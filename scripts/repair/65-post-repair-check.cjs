/**
 * STREAM H - POST-APPLY CHECK.  READ-ONLY.
 *
 *   node scripts/repair/65-post-repair-check.cjs [--run <id>]
 *
 * 1. Nothing reached a real person: automation_events, workflow_executions,
 *    email/whatsapp/sms node_executions and communicationLogs for the touched leads.
 * 2. The repair landed: re-applying the rules to the LIVE rows finds nothing left to do
 *    (except rows a live user was editing at the time - listed).
 * 3. The testers' named applicants, as the CRM now sees them.
 */
const fs = require('fs');
const path = require('path');
const { connect } = require('../lib/db.cjs');
const M = require('../lib/maps.cjs');
const R = require('../lib/repair-rules.cjs');

const ROOT = 'C:/Users/Prateek/Desktop/Repos/data/repair';
const args = process.argv.slice(2);
const runArg = args.includes('--run') ? args[args.indexOf('--run') + 1] : null;
const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(80) + '\n' + t + '\n' + '='.repeat(80));
let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; log('  PASS  ' + n); } else { fail++; log('  FAIL  ' + n + (x ? '   ' + x : '')); } };
const readNd = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];

(async () => {
  const runs = fs.readdirSync(ROOT).filter(d => /^\d{4}-/.test(d)).sort();
  const runId = runArg || runs[runs.length - 1];
  const DIR = path.join(ROOT, runId);
  const ckpt = JSON.parse(fs.readFileSync(path.join(DIR, 'checkpoint.json'), 'utf8'));
  const summ = fs.readdirSync(path.join(DIR, 'runs')).map(d => path.join(DIR, 'runs', d, 'summary.json')).filter(fs.existsSync);
  const firstRun = fs.readdirSync(path.join(DIR, 'runs')).sort()[0];
  const T0 = new Date(new Date(firstRun.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z/, 'T$1:$2:$3.$4Z')).getTime() - 60000);
  const T1 = new Date(Math.max(...Object.values(ckpt.phases).map(p => new Date(p.at || 0).getTime())));
  const F = readNd(path.join(DIR, 'h_forms.ndjson')), L = readNd(path.join(DIR, 'h_leads.ndjson')), K = readNd(path.join(DIR, 'h_trackers.ndjson'));
  const ids = [...new Set([...F, ...L, ...K].map(x => x.v2_lead_id))];
  hr(`STREAM H POST-APPLY CHECK   ${runId}`);
  log(`  phases: ${Object.entries(ckpt.phases).map(([k, v]) => `${k}=${v.done ? 'done' : v.batches + ' batches'}`).join(', ')}   (${summ.length} apply run(s))`);
  log(`  window ${T0.toISOString()} .. ${T1.toISOString()}   leads in the plan: ${ids.length}`);

  const v2 = await connect('v2');
  try {
    hr('PART 1 - did anything reach a real person?');
    // The live CRM keeps emitting events on these leads (lead_score job every 30s, counsellor
    // stage/substage edits, students filling forms). The app ALWAYS bumps updated_at on a lead
    // update and the lead_score job changes only lead_score. The repair NEVER touches
    // v2_leads.updated_at, so an event the repair could have caused would change ONLY repair
    // columns, with no updated_at. Count those; list the rest as the CRM's own activity.
    const REPAIR_COLS = Object.values(R.CLASSES.v2_leads).flat();
    const { rows: evs } = await v2.query(`select id, row_id, changed_fields, created_at from automation_events
      where table_name = 'v2_leads' and row_id = any($1::bigint[]) and created_at between $2 and $3`, [ids, T0, T1]);
    const byRepair = evs.filter(e => { const f = e.changed_fields || []; return f.length && !f.includes('updated_at') && f.every(c => REPAIR_COLS.includes(c)); });
    const kinds = {};
    for (const e of evs) if (!byRepair.includes(e)) { const k = (e.changed_fields || []).join(','); kinds[k] = (kinds[k] || 0) + 1; }
    check('automation_events: 0 caused by the repair during the repair window', byRepair.length === 0,
      `${byRepair.length}: ${byRepair.slice(0, 5).map(e => e.id + ' lead ' + e.row_id + ' [' + e.changed_fields + ']').join('; ')}`);
    if (evs.length - byRepair.length) {
      log(`  note: ${evs.length - byRepair.length} event(s) in the window are the live CRM's own activity on these leads (not the repair):`);
      for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) log(`          ${String(n).padStart(4)}  [${k}]`);
    }
    const { rows: [after] } = await v2.query(`select count(*)::int n from automation_events
      where table_name = 'v2_leads' and row_id = any($1::bigint[]) and created_at > $2`, [ids, T1]);
    if (after.n) log(`  note: ${after.n} event(s) AFTER the repair - counsellors/students using the CRM on these leads, not the repair`);
    const { rows: [wf] } = await v2.query(`select count(*)::int n from workflow_executions where lead_id = any($1::bigint[]) and created_at between $2 and $3`, [ids, T0, T1]);
    check('workflow_executions: no workflow started for these leads during the repair', wf.n === 0, `${wf.n}`);
    const { rows: [ne] } = await v2.query(`select count(*)::int n from node_executions
      where lead_id = any($1::bigint[]) and created_at between $2 and $3 and type in ('email','whatsapp','sms')`, [ids, T0, T1]);
    check('node_executions: 0 email / whatsapp / sms for these leads during the repair', ne.n === 0, `${ne.n}`);
    const { rows: [trg] } = await v2.query(`select tg.tgenabled from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
      where c.relname = 'v2_leads' and tg.tgname = 'trg_automation_v2_leads'`);
    check('the automation trigger is still ENABLED for the live CRM', trg && trg.tgenabled === 'O');

    hr('PART 2 - did the repair land? (re-applying the rules to the LIVE rows)');
    const left = async (arr, table, sql, idOf) => {
      let n = 0; const ex = [];
      for (let i = 0; i < arr.length; i += 5000) {
        const chunk = arr.slice(i, i + 5000);
        const { rows } = await v2.query(sql, [chunk.map(idOf)]);
        const by = new Map(rows.map(r => [Number(r.id), r]));
        for (const g of chunk) { const live = by.get(idOf(g)); if (live && Object.keys(R.plan(table, live, g.want)).length) { n++; if (ex.length < 5) ex.push(idOf(g)); } }
      }
      return { n, ex };
    };
    const a = await left(F, 'under_graduate', 'select * from under_graduate where id = any($1::int[])', g => g.ug_id);
    const b = await left(L, 'v2_leads', 'select * from v2_leads where id = any($1::bigint[])', g => g.v2_lead_id);
    const c = await left(K, '"ApplicationActivityTrackers"', 'select * from "ApplicationActivityTrackers" where id = any($1::int[])', g => g.tracker_id);
    check(`forms: ${F.length - a.n}/${F.length} applicants complete`, a.n === 0, `still to do: ${a.ex}`);
    check(`leads: ${L.length - b.n}/${L.length} leads complete`, b.n === 0, `still to do (a live user had them locked - re-run the apply): ${b.ex}`);
    check(`trackers: ${K.length - c.n}/${K.length} trackers complete`, c.n === 0, `still to do: ${c.ex}`);

    hr('PART 3 - the testers\' named applicants, as the CRM now sees them');
    for (const e of ['aaliyahxahmed13@gmail.com', 'rabiaahuja09@gmail.com', 'ayushman.28.2008@gmail.com', 'guananya@tisb.ac.in']) {
      const { rows } = await v2.query(`select l.id, l.form_id, l.application_form_submitted s, l.form_percentage_filled p, l.payment_status ps,
          l.payment_completed_at pc, l.payment_partner pp, l.lead_stage_date lsd, l.application_stage_date asd, l.form_completion_date fcd,
          t."applicationFormSubmittedOn" tsub, t."application_last_activity_date" tlad, u.gender, u.date_of_birth::text dob
        from v2_leads l left join "ApplicationActivityTrackers" t on t."leadId" = l.id left join under_graduate u on u.lead_id = l.id
        where lower(l.registered_email) = $1 and l.org_id = $2 and not l.is_deleted order by l.id`, [e, M.ORG_V2]);
      const d = v => v ? new Date(v).toISOString().slice(0, 16) : 'EMPTY';
      for (const r of rows) {
        log(`  ${e}  (lead ${r.id}, form ${r.form_id})`);
        log(`     submitted=${r.s}  ${Number(r.p)}%  payment=${r.ps}  paid_at=${d(r.pc)}  partner=${r.pp || 'EMPTY'}`);
        log(`     lead_stage_date=${d(r.lsd)}  application_stage_date=${d(r.asd)}  form_completion_date=${d(r.fcd)}`);
        log(`     tracker submitted_on=${d(r.tsub)}  last_activity=${d(r.tlad)}   form: gender=${r.gender || 'EMPTY'} dob=${r.dob || 'EMPTY'}`);
      }
    }
    hr(fail ? `${fail} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
    log(`  ${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  } finally { await v2.end(); }
})().catch(e => { console.error('POST-REPAIR CHECK FAILED TO RUN:', e.message); process.exit(1); });
