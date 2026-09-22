/**
 * AUTOMATION SAFETY CHECK - run this before --apply.
 *
 * It does not assert that the guard works. It PROVES it, on your connection, against
 * the live database, by running both halves of the experiment inside transactions
 * that are rolled back:
 *
 *   CONTROL   insert a row with the guard OFF  -> automation_events MUST gain a row
 *   PROTECTED insert a row with the guard ON   -> automation_events MUST NOT gain one
 *
 * The control matters: without it, "no events" could simply mean the trigger is
 * disabled, the test row did not match, or the query was wrong. Seeing the event
 * appear and then not appear is what makes the result meaningful.
 *
 * Both transactions are rolled back, so no row and no event survives - and because
 * pg_notify only delivers on COMMIT, the workflow engine is never woken either.
 *
 *   node scripts/import/05-automation-safety-check.cjs
 */
const { connect, armAutomationGuard } = require('../lib/db.cjs');
const M = require('../lib/maps.cjs');

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78));

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; log('  PASS  ' + name); } else { fail++; log('  FAIL  ' + name + (extra ? '   ' + extra : '')); }
};

/** Insert one throwaway lead, see whether the trigger fired, then ROLL BACK. */
async function probe(v2, label) {
  await v2.query('begin');
  try {
    const { rows: [base] } = await v2.query(
      `select coalesce(max(id), 0)::bigint mx from automation_events`);
    const { rows: [lead] } = await v2.query(`
      insert into v2_leads (org_id, school_id, program_id, form_id, lead_table_id,
                            registered_name, registered_email, registered_mobile,
                            status, type, lead_type, final_decision, is_deleted,
                            created_at, updated_at, automation_tags)
      values ($1, $2, 94, 104, $3, 'AUTOMATION GUARD PROBE - ROLLED BACK',
              'automation-guard-probe@example.invalid', '0000000000',
              'active', 'lead'::enum_v2_leads_type, 'primary'::enum_v2_leads_lead_type,
              'NOT_ELIGIBLE'::enum_v2_leads_final_decision, true, now(), now(), '{}'::text[])
      returning id`, [M.ORG_V2, M.SCHOOL_V2, M.LEAD_TABLE_ID]);
    const { rows: [after] } = await v2.query(
      `select count(*)::int n from automation_events
        where id > $1::bigint and table_name = 'v2_leads' and row_id = $2::bigint`,
      [base.mx, lead.id]);
    log(`  ${label}: inserted throwaway lead id ${lead.id} -> automation_events rows for it: ${after.n}`);
    return after.n;
  } finally {
    await v2.query('rollback');
  }
}

(async () => {
  hr('AUTOMATION SAFETY CHECK');
  log(`  target: the v2 production database, org ${M.ORG_V2} / school ${M.SCHOOL_V2}`);
  log('  every write below happens inside a transaction that is ROLLED BACK.');

  const v2 = await connect('v2', { readOnly: false });
  try {
    // ---------------------------------------------------------------- the trigger exists
    hr('1. the trigger this is all about');
    const { rows: trg } = await v2.query(`
      select tg.tgname, tg.tgenabled, p.proname
      from pg_trigger tg join pg_class c on c.oid = tg.tgrelid join pg_proc p on p.oid = tg.tgfoid
      where not tg.tgisinternal and c.relname = 'v2_leads'`);
    trg.forEach(t => log(`  ${t.tgname} -> ${t.proname}()  enabled=${t.tgenabled}`));
    check('trg_automation_v2_leads exists and is enabled',
      trg.some(t => t.tgname === 'trg_automation_v2_leads' && t.tgenabled === 'O'));
    const { rows: [fn] } = await v2.query(
      `select prosrc from pg_proc where proname = 'emit_automation_event'`);
    const guardLine = (fn ? fn.prosrc : '').split('\n').map(l => l.trim())
      .find(l => l.includes('app.skip_automation'));
    log(`  guard inside the function: ${guardLine || '(NOT FOUND)'}`);
    check('the function still checks app.skip_automation before doing anything',
      !!guardLine && /current_setting\('app\.skip_automation'/.test(guardLine));

    // ---------------------------------------------------------------- control
    hr('2. CONTROL - guard OFF, the trigger MUST fire');
    await v2.query(`set app.skip_automation = 'false'`);
    const { rows: [g1] } = await v2.query(`select current_setting('app.skip_automation', true) v`);
    log(`  app.skip_automation = ${JSON.stringify(g1.v)}`);
    const controlEvents = await probe(v2, 'CONTROL  ');
    check('an event IS emitted when the guard is off (so this test can detect events)',
      controlEvents > 0, `got ${controlEvents}`);

    // ---------------------------------------------------------------- protected
    hr('3. PROTECTED - guard ON, exactly what the importer does');
    await armAutomationGuard(v2);
    const { rows: [g2] } = await v2.query(`select current_setting('app.skip_automation', true) v`);
    log(`  app.skip_automation = ${JSON.stringify(g2.v)}  (armAutomationGuard verified it read back)`);
    const protectedEvents = await probe(v2, 'PROTECTED');
    check('NO event is emitted when the guard is on', protectedEvents === 0, `got ${protectedEvents}`);

    // ---------------------------------------------------------------- survives commit
    hr('4. the guard survives a COMMIT (this is why it is SET, not SET LOCAL)');
    await v2.query('begin');
    await v2.query('commit');
    const { rows: [g3] } = await v2.query(`select current_setting('app.skip_automation', true) v`);
    log(`  after begin/commit, app.skip_automation = ${JSON.stringify(g3.v)}`);
    check('still true after a commit cycle', g3.v === 'true');
    const stillProtected = await probe(v2, 'AFTER COMMIT');
    check('still no event after a commit cycle', stillProtected === 0, `got ${stillProtected}`);

    // ---------------------------------------------------------------- nothing survived
    hr('5. nothing the probes wrote survived');
    const { rows: [leftover] } = await v2.query(
      `select count(*)::int n from v2_leads where registered_email = 'automation-guard-probe@example.invalid'`);
    check('no probe lead left in v2_leads', leftover.n === 0, `found ${leftover.n}`);
    const { rows: [ev] } = await v2.query(
      `select count(*)::int n from automation_events
        where after_data->>'registered_email' = 'automation-guard-probe@example.invalid'`);
    check('no probe event left in automation_events', ev.n === 0, `found ${ev.n}`);

    // ---------------------------------------------------------------- workflow exposure
    hr('6. what the guard is actually protecting you from');
    // The engine treats BOTH 'active' and 'published' as live
    // (automation.service.js: LIVE_WORKFLOW_STATUSES = new Set(['active','published'])).
    // Filtering on status='active' alone badly understates the exposure.
    const { rows: [live] } = await v2.query(`
      select count(distinct w.id)::int n from workflows w join nodes n on n.workflow_id = w.id
      where w.org_id = $1 and lower(w.status) in ('active','published')
        and n.type in ('email','whatsapp','sms')`, [M.ORG_V2]);
    log(`  LIVE workflows in org ${M.ORG_V2} that contain an email/whatsapp/sms node: ${live.n}`);
    const { rows: ugWf } = await v2.query(`
      select w.id, w.name, w.status, string_agg(distinct n.type, ',') types
      from workflows w join nodes n on n.workflow_id = w.id
      where w.org_id = $1 and lower(w.status) in ('active','published') and w.school_id = $2
        and n.type in ('email','whatsapp','sms')
      group by 1,2,3 order by 1`, [M.ORG_V2, M.SCHOOL_V2]);
    if (ugWf.length) {
      log('');
      log(`  Of those, scoped to school ${M.SCHOOL_V2} (UG) - i.e. they could match the very`);
      log('  leads this migration inserts:');
      ugWf.forEach(w => log(`    workflow ${w.id}  "${w.name}"  status=${w.status}  nodes=${w.types}`));
      log('');
      log('  That is the concrete risk, named. The guard is what stops it: with');
      log('  app.skip_automation = true the trigger returns before writing an event, so');
      log('  the engine is never handed anything to evaluate and these workflows never');
      log('  run. Section 3 proved exactly that, on this connection, minutes ago.');
    } else {
      log(`  none of them are scoped to school ${M.SCHOOL_V2}`);
    }
    const { rows: [paused] } = await v2.query(
      `select count(*)::int n from workflows where org_id = $1 and lower(status) = 'paused'`, [M.ORG_V2]);
    log('');
    log(`  (workflows currently paused in org ${M.ORG_V2}: ${paused.n})`);

    hr(fail ? `${fail} CHECK(S) FAILED - DO NOT RUN --apply` : 'ALL CHECKS PASSED - the guard is working on this connection');
    log(`  ${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  } finally {
    await v2.query(`set app.skip_automation = 'true'`).catch(() => {});
    await v2.end();
  }
})().catch(e => { console.error('\nSAFETY CHECK FAILED TO RUN:', e.message); console.error(e.stack); process.exit(1); });
