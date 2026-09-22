/**
 * POST-APPLY CHECK - read-only. Independent of the importer's own verification.
 *
 *   node scripts/40-post-apply-check.cjs [--run <exportRunId>]
 *
 * Part 1 answers the question that matters most: did anything reach, or get queued
 * for, a real lead or applicant? It checks every layer between a row write and a
 * sent message - automation_events, workflow_executions, node_executions (the
 * email/whatsapp/sms nodes) and communicationLogs - for every v2 lead this import
 * touched. Every query goes through an index; nothing here scans a big table.
 *
 * Part 2 confirms the data landed exactly as exported.
 */
const fs = require('fs');
const path = require('path');
const { connect } = require('./lib/db.cjs');
const M = require('./lib/maps.cjs');

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(80) + '\n' + t + '\n' + '='.repeat(80));
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; log('  PASS  ' + name); } else { fail++; log('  FAIL  ' + name + (extra ? '   ' + extra : '')); }
};

const EXPORT_ROOT = 'C:/Users/Prateek/Desktop/Repos/data/export';
const args = process.argv.slice(2);
const runArg = args.includes('--run') ? args[args.indexOf('--run') + 1] : null;
const readNd = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];

(async () => {
  const runs = fs.readdirSync(EXPORT_ROOT).filter(d => /^\d{4}-/.test(d)).sort();
  const runId = runArg || runs[runs.length - 1];
  const DIR = path.join(EXPORT_ROOT, runId);
  const ckpt = JSON.parse(fs.readFileSync(path.join(DIR, 'checkpoint.json'), 'utf8'));
  const times = Object.values(ckpt.phases).map(p => new Date(p.at).getTime());
  // the apply window: a minute before the first phase finished, to the last one
  const T0 = new Date(Math.min(...times) - 60000);
  const T1 = new Date(Math.max(...times));

  const leads = readNd(path.join(DIR, 'leads.ndjson'));
  const promotions = readNd(path.join(DIR, 'promotions.ndjson'));
  const backfill = readNd(path.join(DIR, 'under_graduate_backfill.ndjson'));
  const students = readNd(path.join(DIR, 'students.ndjson'));
  const ugLead = readNd(path.join(DIR, 'under_graduate_lead.ndjson'));
  const ugApp = readNd(path.join(DIR, 'under_graduate_applicant.ndjson'));
  // A NEW applicant whose lead had no city/state/grade gets no lead-level row, so the
  // applicant phase INSERTS its form row instead of updating one. Count those too.
  const ugLeadSet = new Set(ugLead.map(r => r.v1_lead_id));
  const expectUgNew = ugLead.length + ugApp.filter(a => !a.key.v2_lead_id && !ugLeadSet.has(a.key.v1_lead_id)).length;

  hr(`POST-APPLY CHECK   export ${runId}`);
  log(`  apply window: ${T0.toISOString()} .. ${T1.toISOString()}`);
  log(`  phases committed: ${Object.values(ckpt.phases).filter(p => p.done).length}`);

  const v2 = await connect('v2');
  try {
    const { rows: newRows } = await v2.query(
      'select id, v1_lead_id, registered_email from v2_leads where v1_lead_id = any($1::int[])',
      [leads.map(l => l.v1_lead_id)]);
    const newIds = newRows.map(r => Number(r.id));
    const promoIds = promotions.map(p => Number(p.v2_lead_id));
    const bfIds = backfill.map(b => Number(b.v2_lead_id));
    const allIds = [...new Set([...newIds, ...promoIds, ...bfIds])];
    log(`  v2 leads touched: ${newIds.length} new + ${promoIds.length} promoted + ${bfIds.length} backfilled = ${allIds.length}`);

    // ================================================================ PART 1
    hr('PART 1 - did anything reach a real person?');

    // 1a. automation_events. The engine only ever sees what lands here.
    const { rows: ev } = await v2.query(`
      select id, row_id, event_type, status, created_at from automation_events
      where table_name = 'v2_leads' and row_id = any($1::bigint[]) and created_at >= $2
      order by created_at`, [allIds, T0]);
    const evInWindow = ev.filter(e => new Date(e.created_at) <= T1);
    const evAfter = ev.filter(e => new Date(e.created_at) > T1);
    check('automation_events: 0 events for our leads DURING the apply', evInWindow.length === 0,
      JSON.stringify(evInWindow.slice(0, 5)));
    if (evAfter.length) {
      log(`  note: ${evAfter.length} event(s) since the apply finished - these come from people`);
      log('        using the CRM on these leads now (a counsellor editing a lead), not from');
      log('        the import. Listed so you can see them:');
      evAfter.slice(0, 10).forEach(e => log(`        #${e.id} lead ${e.row_id} ${e.event_type} ${e.status} ${new Date(e.created_at).toISOString()}`));
    } else log('  (and 0 since - nobody has edited these leads yet)');

    // 1b. workflow runs started for our leads
    const { rows: wf } = await v2.query(`
      select we.id, we.workflow_id, we.lead_id, we.status, we.trigger, we.created_at, w.name
      from workflow_executions we left join workflows w on w.id = we.workflow_id
      where we.lead_id = any($1::bigint[]) and we.created_at >= $2 order by we.created_at`, [allIds, T0]);
    const wfIn = wf.filter(w => new Date(w.created_at) <= T1);
    check('workflow_executions: no workflow started for our leads during the apply', wfIn.length === 0,
      JSON.stringify(wfIn.slice(0, 5)));
    const wf82 = wf.filter(w => w.workflow_id === 82);
    check('workflow 82 "UG Login Cred" has NOT run for any of our leads', wf82.length === 0, JSON.stringify(wf82));
    if (wf.length > wfIn.length) {
      log(`  note: ${wf.length - wfIn.length} workflow run(s) since the apply, triggered by live CRM activity:`);
      wf.filter(w => new Date(w.created_at) > T1).slice(0, 10)
        .forEach(w => log(`        wf ${w.workflow_id} "${w.name}" lead ${w.lead_id} ${w.trigger} ${w.status} ${new Date(w.created_at).toISOString()}`));
    }

    // 1c. the message-sending nodes themselves
    const { rows: ne } = await v2.query(`
      select id, lead_id, type, status, created_at from node_executions
      where lead_id = any($1::bigint[]) and created_at >= $2 and type in ('email','whatsapp','sms')
      order by created_at`, [allIds, T0]);
    check('node_executions: 0 email / whatsapp / sms nodes executed for our leads', ne.length === 0,
      JSON.stringify(ne.slice(0, 5)));

    // 1d. communicationLogs - the send log. Small table; bounded by org + time.
    const emails = [...new Set([...newRows.map(r => r.registered_email), ...promotions.map(p => p.registered_email),
      ...students.map(s => s.email)].filter(e => e && e.includes('@')).map(e => e.toLowerCase()))];
    const { rows: cl } = await v2.query(`
      select id, "communicationLogType" t, "jobStatus" s, "templateName" n, "createdAt" c, "sentTo"::text st
      from "communicationLogs" where "organizationId" = $1 and "createdAt" >= $2`, [M.ORG_V2, T0]);
    const clHit = cl.filter(r => emails.some(e => (r.st || '').toLowerCase().includes(e)));
    check(`communicationLogs: none of our ${emails.length} email addresses in any send since the apply`,
      clHit.length === 0, JSON.stringify(clHit.slice(0, 5)));
    log(`  (org ${M.ORG_V2} sends since the apply, to anyone: ${cl.length})`);

    // 1e. the guard is still intact for the next person
    const { rows: [trg] } = await v2.query(`
      select tg.tgenabled from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
      where c.relname = 'v2_leads' and tg.tgname = 'trg_automation_v2_leads'`);
    check('the automation trigger is still ENABLED (the import did not switch automation off for the CRM)',
      trg && trg.tgenabled === 'O');

    // ================================================================ PART 2
    hr('PART 2 - did the data land exactly as exported?');
    check(`v2_leads: ${leads.length} of ${leads.length} new leads present`, newRows.length === leads.length, `${newRows.length}`);
    const { rows: [sc] } = await v2.query(`
      select count(*) filter (where org_id = $2 and school_id = $3 and form_id = any($4::int[]) and not is_deleted)::int ok,
             count(*)::int n from v2_leads where id = any($1::bigint[])`, [newIds, M.ORG_V2, M.SCHOOL_V2, M.V2_FORMS]);
    check(`every new lead is org ${M.ORG_V2} / school ${M.SCHOOL_V2} / forms 104,105 / not deleted`, sc.ok === sc.n, `${sc.ok}/${sc.n}`);

    const { rows: us } = await v2.query('select id, v1_id, email from users where v1_id = any($1::int[])', [students.map(s => s.v1_id)]);
    check(`users: both students linked by v1_id (${us.map(u => `${u.v1_id}->${u.id}`).join(', ')})`, us.length === students.length);
    const { rows: [dupU] } = await v2.query(
      'select count(*)::int n from users where lower(email) = any($1::text[]) group by lower(email) order by 1 desc limit 1',
      [students.map(s => s.email.toLowerCase())]);
    check('users: no duplicate login created for any student email', !dupU || dupU.n === 1, dupU && `${dupU.n}`);

    const { rows: [ugNew] } = await v2.query(
      'select count(*)::int n, count(distinct lead_id)::int d from under_graduate where lead_id = any($1::bigint[])', [newIds]);
    check(`under_graduate: ${ugNew.n} form rows on the new leads (expected ${expectUgNew} = ${ugLead.length} lead-level + ${expectUgNew - ugLead.length} new applicants)`, ugNew.n === expectUgNew);
    check('under_graduate: no lead has more than one form row', ugNew.n === ugNew.d, `${ugNew.n} rows over ${ugNew.d} leads`);
    const { rows: bfRows } = await v2.query(
      'select lead_id, count(*)::int n from under_graduate where lead_id = any($1::bigint[]) group by lead_id', [bfIds]);
    check(`under_graduate backfill: all ${bfIds.length} applicants now have exactly ONE form row`,
      bfRows.length === bfIds.length && bfRows.every(r => r.n === 1), JSON.stringify(bfRows.filter(r => r.n !== 1)));
    const { rows: [dang] } = await v2.query(`
      select ug.lead_id, (select count(*)::int from v2_leads l where l.id = ug.lead_id and not l.is_deleted) alive
      from under_graduate ug where ug.id = 20635`);
    check('the orphan under_graduate #20635 now points at a LIVE lead', dang && dang.alive === 1, JSON.stringify(dang));

    const { rows: [tl] } = await v2.query(`
      select count(*)::int n from timelines
      where created_at >= '2026-07-01' and created_at < '2026-10-01' and v2_lead_id = any($1::bigint[])`, [newIds]);
    check(`timelines: ${tl.n} rows on the new leads (expected 421)`, tl.n === 421);
    const { rows: [nt] } = await v2.query('select count(*)::int n from notes where v2_lead_id = any($1::bigint[])', [newIds]);
    check(`notes: ${nt.n} (expected 1)`, nt.n === 1);
    const { rows: [tg] } = await v2.query('select count(*)::int n from lead_tags where v2_lead_id = any($1::bigint[])', [newIds]);
    check(`lead_tags: ${tg.n} (expected 1)`, tg.n === 1);
    const { rows: [tk] } = await v2.query(
      'select count(*)::int n from "ApplicationActivityTrackers" where "leadId" = any($1::bigint[])', [newIds]);
    check(`ApplicationActivityTrackers: ${tk.n} (expected 163)`, tk.n === 163);
    const { rows: [sh] } = await v2.query(
      `select count(*)::int n from "leadScoreHistory" where "leadId" = any($1::bigint[]) and source = 'v1_history'`, [newIds]);
    check(`leadScoreHistory: ${sh.n} (expected 8)`, sh.n === 8);

    for (const p of promotions) {
      const { rows: [a] } = await v2.query('select * from v2_leads where id = $1', [p.v2_lead_id]);
      check(`promotion ${p.v2_lead_id}: v1 link filled (v1_application_id ${a.v1_application_id})`, Number(a.v1_application_id) === p.v1_application_id);
      check(`promotion ${p.v2_lead_id}: user_id still ${p.before.user_id} (student login intact)`, Number(a.user_id) === Number(p.before.user_id), `${a.user_id}`);
      check(`promotion ${p.v2_lead_id}: application_number still v2's own (${a.application_number})`, a.application_number === p.before.application_number);
      check(`promotion ${p.v2_lead_id}: payment still ${a.payment_status}/${a.is_payment_done}`, a.payment_status === p.before.payment_status && a.is_payment_done === p.before.is_payment_done);
    }

    // ================================================================ the gap now
    hr('what is still missing from v2 (v1 keeps receiving leads)');
    const v1 = await connect('v1');
    try {
      const { rows: all } = await v1.query(
        'select id, "createdAt" from "manageLeads" where "applicationFormId" = any($1::int[])', [M.V1_FORMS]);
      const present = new Set();
      const ids = all.map(r => r.id);
      for (let i = 0; i < ids.length; i += 20000) {
        const { rows } = await v2.query('select v1_lead_id from v2_leads where v1_lead_id = any($1::int[])', [ids.slice(i, i + 20000)]);
        rows.forEach(r => present.add(Number(r.v1_lead_id)));
      }
      const miss = all.filter(r => !present.has(r.id));
      const heldBack = new Set([2497873, 2498456]);
      const fresh = miss.filter(r => !heldBack.has(r.id));
      log(`  v1 UG leads: ${all.length}   in v2: ${present.size}   missing: ${miss.length}`);
      log(`    held back for review : ${miss.filter(r => heldBack.has(r.id)).length}`);
      log(`    NEW since the export : ${fresh.length}${fresh.length ? '  (vendor feeds + chatbot still write only to v1)' : ''}`);
      fresh.slice(0, 10).forEach(r => log(`      v1 lead ${r.id} created ${new Date(r.createdAt).toISOString()}`));
    } finally { await v1.end(); }

    hr(fail ? `${fail} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
    log(`  ${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  } finally { await v2.end(); }
})().catch(e => { console.error('\nPOST-APPLY CHECK FAILED TO RUN:', e.message); console.error(e.stack); process.exit(1); });
