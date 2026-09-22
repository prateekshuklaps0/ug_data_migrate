/**
 * SELF-TEST of the user's rules (lib/repair-rules.cjs).
 *   1. a v2 value never becomes blank because v1 is blank
 *   2. CONTENT: v2 is the source of truth - an existing v2 value is never overwritten
 *   3. PROGRESS: if v1 is further along (paid / submitted / % / section / a later "last"
 *      date), v2 moves forward - and never backwards
 *
 * Part A: the rules in JavaScript, no database.
 * Part B: the same rules enforced by Postgres (guardSql) on a TEMPORARY table, inside a
 *         transaction that is rolled back. No real table is touched.
 *
 *   node scripts/repair/70-test-rules.cjs
 */
const R = require('../lib/repair-rules.cjs');
const { connect } = require('../lib/db.cjs');

let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  ' + x : '')); } };
const throws = f => { try { f(); return false; } catch { return true; } };
const L = 'v2_leads', TR = '"ApplicationActivityTrackers"', UG = 'under_graduate';

(async () => {
  console.log('\nA. the rules (no database)');
  // content
  let s = R.plan(UG, { gender: 'Female', city: null, school_name: '', pincode: '110001' }, { gender: 'Male', city: 'Delhi', school_name: 'DPS', pincode: null });
  check('content: v2 "Female" is NOT overwritten by v1 "Male"', !('gender' in s));
  check('content: empty v2 city IS filled', s.city === 'Delhi');
  check('content: blank-text v2 school IS filled', s.school_name === 'DPS');
  check('content: v2 pincode is NOT blanked by v1 NULL', !('pincode' in s));
  s = R.plan(L, { payment_partner: 'Cashfree', lead_stage_date: '2026-09-01T00:00:00Z', payment_completed_at: null },
    { payment_partner: 'Razorpay', lead_stage_date: '2026-08-01T00:00:00Z', payment_completed_at: '2026-09-19T04:21:46Z' });
  check('content: v2 partner "Cashfree" is NOT overwritten by v1 "Razorpay"', !('payment_partner' in s));
  check('content: an existing v2 stage date is NOT overwritten', !('lead_stage_date' in s));
  check('content: an empty v2 paid-on date IS filled', s.payment_completed_at === '2026-09-19T04:21:46Z');
  // progress
  s = R.plan(L, { application_form_submitted: false, payment_status: 'pending', is_payment_done: false, form_percentage_filled: '30.00', last_interacted_section: 1 },
    { application_form_submitted: true, payment_status: 'completed', is_payment_done: true, form_percentage_filled: 100, last_interacted_section: 5 });
  check('progress: submitted false -> true', s.application_form_submitted === true);
  check('progress: payment pending -> completed', s.payment_status === 'completed');
  check('progress: is_payment_done false -> true', s.is_payment_done === true);
  check('progress: 30% -> 100%', Number(s.form_percentage_filled) === 100);
  check('progress: section 1 -> 5', s.last_interacted_section === 5);
  s = R.plan(L, { application_form_submitted: true, payment_status: 'completed', is_payment_done: true, form_percentage_filled: '100.00', last_interacted_section: 5 },
    { application_form_submitted: false, payment_status: 'pending', is_payment_done: false, form_percentage_filled: 30, last_interacted_section: 1 });
  check('progress NEVER goes back: submitted true stays true', !('application_form_submitted' in s));
  check('progress NEVER goes back: completed stays completed (paid in v2, pending in v1)', !('payment_status' in s));
  check('progress NEVER goes back: 100% stays 100%', !('form_percentage_filled' in s));
  check('progress NEVER goes back: section 5 stays 5', !('last_interacted_section' in s));
  s = R.plan(TR, { application_last_activity_date: '2026-09-06T00:00:00Z', applicationForm_start_date: '2026-09-01T00:00:00Z' },
    { application_last_activity_date: '2026-09-18T00:00:00Z', applicationForm_start_date: '2026-08-01T00:00:00Z' });
  check('progress: last-activity date moves LATER', s.application_last_activity_date === '2026-09-18T00:00:00Z');
  check('content: existing form-start date is NOT moved', !('applicationForm_start_date' in s));
  s = R.plan(TR, { application_last_activity_date: '2026-09-18T00:00:00Z' }, { application_last_activity_date: '2026-09-06T00:00:00Z' });
  check('progress NEVER goes back: last-activity date is not moved earlier', !('application_last_activity_date' in s));
  s = R.plan(L, { registered_name: 'A', counsellor_id: 5 }, { registered_name: 'B', counsellor_id: 9 });
  check('a column outside the repair list is never written', !Object.keys(s).length);
  // assertions
  check('assert refuses an overwrite of content', throws(() => R.assertAllowed('t', UG, { a: 'x' }, { a: 'y' })));
  check('assert refuses a blank write', throws(() => R.assertAllowed('t', UG, { a: null }, { a: '' })));
  check('assert refuses progress going backwards', throws(() => R.assertAllowed('t', L, { form_percentage_filled: 100 }, { form_percentage_filled: 30 })));
  check('assert refuses payment completed -> anything', throws(() => R.assertAllowed('t', L, { payment_status: 'completed' }, { payment_status: 'completed' })));
  check('assert refuses a non-repairable column', throws(() => R.assertAllowed('t', L, { registered_name: null }, { registered_name: 'x' })));
  check('assert accepts pending -> completed', !throws(() => R.assertAllowed('t', L, { payment_status: 'pending' }, { payment_status: 'completed' })));
  check('partner spelling normalised to v2 ("razorpay" -> "Razorpay")', R.normPartner('razorpay') === 'Razorpay');

  console.log('\nB. the same rules, enforced by Postgres itself (temporary table, rolled back)');
  const v2 = await connect('v2', { readOnly: false });
  try {
    await v2.query('begin');
    await v2.query(`create temporary table repair_rules_test (id int primary key, payment_partner text, application_form_submitted boolean,
                    payment_status text, form_percentage_filled numeric, application_last_activity_date timestamptz) on commit drop`);
    await v2.query(`insert into repair_rules_test values
      (1, 'Cashfree', true,  'completed', 100,  '2026-09-18'),
      (2, null,       false, 'pending',   30,   '2026-09-06'),
      (3, '',         null,  null,        null, null)`);
    // EXACTLY the statement shape the importer runs: one set-based UPDATE ... FROM
    // jsonb_to_recordset, with the rule guard (guardExpr) on every column.
    const COLS = [['payment_partner', 'text', L], ['application_form_submitted', 'boolean', L], ['payment_status', 'text', L],
      ['form_percentage_filled', 'numeric', L], ['application_last_activity_date', 'timestamptz', TR]];
    const upd = (id, part, sub, pay, pct, lad) => v2.query(
      `UPDATE repair_rules_test AS t SET ${COLS.map(([c, , tb]) => `"${c}" = ${R.guardExpr(tb, c, `t."${c}"`, `v."${c}"`)}`).join(', ')}
       FROM jsonb_to_recordset($1::jsonb) AS v(id int, ${COLS.map(([c, ty]) => `"${c}" ${ty}`).join(', ')}) WHERE t.id = v.id`,
      [JSON.stringify([{ id, payment_partner: part, application_form_submitted: sub, payment_status: pay, form_percentage_filled: pct, application_last_activity_date: lad }])]);
    await upd(1, 'Razorpay', true, 'completed', 30, '2026-09-06');   // v2 is ahead / has content
    await upd(2, 'Razorpay', true, 'completed', 100, '2026-09-18');  // v1 is ahead
    await upd(3, 'Razorpay', true, 'completed', 100, '2026-09-18');  // v2 empty
    const { rows: [a, b, c] } = await v2.query('select id, payment_partner, application_form_submitted s, payment_status, form_percentage_filled::float8 p, application_last_activity_date d from repair_rules_test order by id');
    check('SQL: v2 partner "Cashfree" kept', a.payment_partner === 'Cashfree');
    check('SQL: v2 100% NOT lowered to 30%', a.p === 100);
    check('SQL: v2 later activity date NOT moved earlier', new Date(a.d).toISOString().startsWith('2026-09-18'));
    check('SQL: empty partner filled', b.payment_partner === 'Razorpay' && c.payment_partner === 'Razorpay');
    check('SQL: submitted false -> true', b.s === true);
    check('SQL: payment pending -> completed', b.payment_status === 'completed');
    check('SQL: 30% -> 100%', b.p === 100);
    check('SQL: activity date moved later', new Date(b.d).toISOString().startsWith('2026-09-18'));
    check('SQL: an all-empty row is fully filled', c.s === true && c.payment_status === 'completed' && c.p === 100 && c.d != null);
    await v2.query('rollback');

    console.log('\nC. the importer\'s "events emitted BY THIS REPAIR" check can really see our own events');
    const OURS = `select count(*) filter (where xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text)::int ours
                  from automation_events where id > $1 and table_name = 'v2_leads' and row_id = $2`;
    const probe = async guard => {
      await v2.query('begin');
      await v2.query(`set local app.skip_automation = '${guard}'`);
      const { rows: [bb] } = await v2.query('select coalesce(max(id),0)::bigint mx from automation_events');
      const { rows: [lead] } = await v2.query(`
        insert into v2_leads (org_id, school_id, program_id, form_id, lead_table_id, registered_name, registered_email,
                              registered_mobile, status, type, lead_type, final_decision, is_deleted, created_at, updated_at, automation_tags)
        values ($1, $2, 94, 104, $3, 'REPAIR CHECK PROBE - ROLLED BACK', 'repair-check-probe@example.invalid', '0000000000',
                'active', 'lead'::enum_v2_leads_type, 'primary'::enum_v2_leads_lead_type, 'NOT_ELIGIBLE'::enum_v2_leads_final_decision,
                true, now(), now(), '{}'::text[]) returning id`, [12, 18, 19]);
      await v2.query(`update v2_leads set lead_stage_date = now() where id = $1`, [lead.id]);   // the kind of write the repair makes
      const { rows: [c] } = await v2.query(OURS, [bb.mx, lead.id]);
      await v2.query('rollback');
      return c.ours;
    };
    const off = await probe('false'), on = await probe('true');
    check(`guard OFF: the check sees ${off} event(s) emitted by our own transaction (must be > 0)`, off > 0);
    check(`guard ON : the check sees ${on} event(s) emitted by our own transaction (must be 0)`, on === 0);
    const { rows: [left] } = await v2.query(`select count(*)::int n from v2_leads where registered_email = 'repair-check-probe@example.invalid'`);
    check('no probe lead survived', left.n === 0);
  } finally { await v2.query('rollback').catch(() => {}); await v2.end(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST FAILED TO RUN:', e.message); process.exit(1); });
