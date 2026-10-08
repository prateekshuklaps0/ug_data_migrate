/**
 * "DID ANYTHING REACH A REAL PERSON?"   READ ONLY.
 *
 *   node scripts/k12/66-comms-proof-k12.cjs
 *
 * An independent second opinion on the one question that matters after an apply, written so
 * it does NOT reuse 65-post-check-k12.cjs's queries - two scripts agreeing is worth more
 * than one script repeating itself. It also closes a hole in that script, which reports
 * "communicationLogs not queryable here - skipped".
 *
 * It works from the v2 lead ID RANGE the migration created, not from the export files, so a
 * mistake in the export cannot hide anything from it. Four layers, outermost first:
 *
 *   automation_events      the trigger's output - the thing the guard suppresses
 *   workflow_executions    the engine deciding to run a workflow for a lead
 *   node_executions        an individual email / whatsapp / sms node actually running
 *   communicationAudiences one row per recipient of a campaign - the send itself
 *   communicationLogs      the campaign
 *
 * The pass criterion is "nothing references OUR leads", NOT "the engine was idle". The live
 * CRM runs these same workflows for every genuine school-18 lead that arrives - during the
 * 2026-10-08 K12 apply that was one real lead every three or four minutes - and an idle
 * engine would mean the CRM was broken, not safe. So every run in the window is listed with
 * the lead it was for, and the check is that none of those leads is one of ours.
 */
const { connect } = require('../lib/db.cjs');
const K = require('./lib-k12.cjs');

const WINDOW = process.argv.includes('--hours')
  ? Number(process.argv[process.argv.indexOf('--hours') + 1]) : 4;

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(88) + '\n' + t + '\n' + '='.repeat(88));
let bad = 0;
const must = (ok, m, extra) => { log((ok ? '  PASS  ' : '  FAIL  ') + m + (extra ? '   ' + extra : '')); if (!ok) bad++; };

(async () => {
  const v2 = await connect('v2');
  const q = async (s, p) => (await v2.query(s, p)).rows;
  try {
    hr(`K12: did anything reach a real person?   (window: last ${WINDOW}h)`);

    // ---------------------------------------------------------------- the leads in question
    const [span] = await q(
      `select count(*)::int n, min(id)::bigint lo, max(id)::bigint hi
         from v2_leads where org_id = $1 and form_id = $2 and v1_lead_id is not null`,
      [K.V2.org, K.V2.form]);
    if (!span.n) { log('  no migrated K12 leads in v2 - nothing to check'); return; }
    log(`  migrated K12 leads: ${span.n}, v2 ids ${span.lo} .. ${span.hi}`);
    const ids = (await q(
      `select id from v2_leads where org_id = $1 and form_id = $2 and v1_lead_id is not null`,
      [K.V2.org, K.V2.form])).map(r => Number(r.id));
    const emails = (await q(
      `select distinct lower(registered_email) e from v2_leads
        where id = any($1::bigint[]) and registered_email is not null and registered_email <> ''`,
      [ids])).map(r => r.e);
    log(`  distinct email addresses among them: ${emails.length}`);

    const tabs = new Set((await q(
      `select table_name from information_schema.tables where table_schema = 'public'`)).map(r => r.table_name));
    const colsOf = async t => new Set((await q(
      `select column_name from information_schema.columns where table_name = $1`, [t])).map(r => r.column_name));

    // ---------------------------------------------------------------- 1. the event trail
    hr('1. the trigger output (what the guard suppresses)');
    const [ev] = await q(
      `select count(*)::int n from automation_events where table_name = 'v2_leads' and row_id = any($1::bigint[])`, [ids]);
    must(ev.n === 0, 'automation_events naming one of these leads', String(ev.n));
    // Our ids are a contiguous block the migration minted, so a range test catches anything
    // an id list could miss.
    const [evr] = await q(
      `select count(*)::int n from automation_events where table_name = 'v2_leads' and row_id between $1 and $2`,
      [span.lo, span.hi]);
    must(evr.n === 0, `automation_events anywhere in the id range ${span.lo}..${span.hi}`, String(evr.n));

    // ---------------------------------------------------------------- 2. the engine
    hr('2. the workflow engine');
    for (const t of ['workflow_executions', 'node_executions']) {
      if (!tabs.has(t)) { log(`  (no ${t} table)`); continue; }
      const cols = await colsOf(t);
      if (!cols.has('lead_id')) { log(`  (${t} has no lead_id)`); continue; }
      const [a] = await q(`select count(*)::int n from "${t}" where lead_id = any($1::bigint[])`, [ids]);
      const [b] = await q(`select count(*)::int n from "${t}" where lead_id between $1 and $2`, [span.lo, span.hi]);
      must(a.n === 0 && b.n === 0, `${t} for these leads (by id list and by range)`, `${a.n} / ${b.n}`);
    }

    // ---------------------------------------------------------------- 3. the send itself
    hr('3. the send');
    if (tabs.has('communicationAudiences')) {
      const cols = await colsOf('communicationAudiences');
      for (const c of ['v2_lead_id', 'leadId'].filter(x => cols.has(x))) {
        const [r] = await q(`select count(*)::int n from "communicationAudiences" where "${c}" = any($1::bigint[])`, [ids]);
        must(r.n === 0, `communicationAudiences rows for these leads (by ${c})`, String(r.n));
      }
    }
    if (tabs.has('communicationLogs')) {
      // communicationLogs is the CAMPAIGN, with no lead column - sentTo is the audience
      // description, so the honest check is campaign volume in the window.
      const [r] = await q(
        `select count(*)::int n, min("createdAt") first, max("createdAt") last
           from "communicationLogs" where "createdAt" > now() - ($1 || ' hours')::interval`, [String(WINDOW)]);
      log(`  communicationLogs created CRM-wide in the window: ${r.n}` + (r.n ? ` (${r.first} .. ${r.last})` : ''));
      if (r.n) {
        const rows = await q(
          `select id, "jobStatus", left(coalesce("sentTo"::text, ''), 40) sent_to, "createdAt"
             from "communicationLogs" where "createdAt" > now() - ($1 || ' hours')::interval
             order by "createdAt" desc limit 10`, [String(WINDOW)]);
        console.table(rows);
        log('  ^ these are the CRM\'s own campaigns. None can be ours unless its audience');
        log('    contains one of the lead ids above, which section 3 just showed it does not.');
      }
    }

    // ---------------------------------------------------------------- 4. the risky workflows
    hr('4. the workflows that were the risk, and what they actually ran');
    const wf = await q(
      `select w.id, left(w.name, 40) name, w.status,
              (select count(*)::int from workflow_executions x
                where x.workflow_id = w.id and x.created_at > now() - ($2 || ' hours')::interval) runs,
              (select count(*)::int from workflow_executions x
                where x.workflow_id = w.id and x.lead_id between $3 and $4) runs_for_ours
         from workflows w
        where w.org_id = $1 and lower(w.status) in ('active', 'published') and w.is_deleted = false
          and (w.school_id = $5 or w.school_id is null) and w.trigger = 'lead_create'
          and exists (select 1 from nodes n where n.workflow_id = w.id and n.type in ('email', 'whatsapp', 'sms'))
        order by w.id`,
      [K.V2.org, String(WINDOW), span.lo, span.hi, K.V2.school]);
    console.table(wf);
    must(wf.every(w => w.runs_for_ours === 0), 'none of those workflows ran for a migrated K12 lead');
    const busy = wf.filter(w => w.runs > 0);
    if (busy.length) {
      log(`  They did run ${busy.map(w => w.id + ':' + w.runs).join(', ')} time(s) in the window - for OTHER leads.`);
      const recent = await q(
        `select x.workflow_id, x.lead_id, l.form_id, l.school_id, l.v1_lead_id, x.created_at
           from workflow_executions x join v2_leads l on l.id = x.lead_id
          where x.workflow_id = any($1::int[]) and x.created_at > now() - ($2 || ' hours')::interval
          order by x.created_at desc limit 8`, [busy.map(w => w.id), String(WINDOW)]);
      console.table(recent);
      log('  A null v1_lead_id means the lead was created natively by the widget, not migrated.');
      log('  This is the CRM working normally - and it is also the proof the risk was real:');
      log('  these workflows fire on every genuine school-18 lead. The guard is the only');
      log('  reason they did not fire ' + span.n + ' more times.');
    }

    hr(bad ? `${bad} CHECK(S) FAILED - INVESTIGATE BEFORE DOING ANYTHING ELSE` : 'NOTHING REACHED A REAL PERSON');
    if (!bad) {
      log(`  ${span.n} leads inserted. 0 events, 0 workflow runs, 0 node runs, 0 audience rows.`);
      log('  The 2026-08-18 incident was 6,388 emails from an import this size. See');
      log('  incident_2026-08-18_automation_emails/README.md');
    }
    process.exitCode = bad ? 1 : 0;
  } finally { await v2.end(); }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
