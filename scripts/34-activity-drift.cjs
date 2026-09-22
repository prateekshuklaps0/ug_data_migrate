/**
 * READ-ONLY. Activity / tracker / payment / submission / date fields that v1 has and
 * v2 does not, for every live UG lead ALREADY in v2.
 *
 *   node scripts/34-activity-drift.cjs
 *
 * Two places are compared:
 *   1. ApplicationActivityTrackers (v2)  vs  applicationActivityTracker (v1)
 *   2. the application + payment columns on v2_leads  vs  ApplicationManager (v1)
 *
 * Each difference is classified:
 *   FILL      v1 has a value, v2 is empty                 -> safe
 *   FORWARD   v1 is further along (submitted / paid / a later "last" date) -> safe
 *   V2_WINS   v2 already has something at least as new     -> leave alone
 *
 * Counsellor-side tracker columns (counsellor_*, *LeadStageUpdated) are REPORTED but
 * never proposed for change: counsellors work in v2, so v2 owns those.
 */
const { connect } = require('./lib/db.cjs');
const M = require('./lib/maps.cjs');

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(84) + '\n' + t + '\n' + '='.repeat(84));

// student-side tracker columns: FILL when empty; the "last" ones also move FORWARD
const TRK_STUDENT = ['applicationForm_start_date', 'payment_Initiated_date', 'payment_last_Initiated_date',
  'application_fee_paidOn', 'applicationFormSubmittedOn', 'application_last_activity_date'];
const TRK_LAST = new Set(['payment_last_Initiated_date', 'application_last_activity_date']);
const TRK_COUNSELLOR = ['counsellor_first_activity_date', 'counsellor_last_activity_date',
  'firstLeadStageUpdated', 'lastLeadStageUpdated'];

(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: leads } = await v2.query(`
      select id, v1_lead_id, v1_application_id, type, registered_email,
             application_form_initiated, application_form_submitted, form_percentage_filled,
             last_interacted_section, form_completion_date, application_registered_on,
             payment_status, is_payment_done, payment_initiated, payment_method, payment_mode
      from v2_leads where org_id = $1 and school_id = $2 and form_id = any($3::int[])
        and not is_deleted and v1_lead_id is not null`, [M.ORG_V2, M.SCHOOL_V2, M.V2_FORMS]);
    log(`live migrated UG leads: ${leads.length}   (applicants with a v1 application: ${leads.filter(l => l.v1_application_id).length})`);
    const v1Ids = leads.map(l => Number(l.v1_lead_id));
    const v2Ids = leads.map(l => Number(l.id));

    // ------------------------------------------------------------ trackers
    const t2 = new Map(), t1 = new Map();
    for (let i = 0; i < v2Ids.length; i += 20000) {
      const { rows } = await v2.query('select * from "ApplicationActivityTrackers" where "leadId" = any($1::int[])', [v2Ids.slice(i, i + 20000)]);
      rows.forEach(r => t2.set(Number(r.leadId), r));
    }
    for (let i = 0; i < v1Ids.length; i += 20000) {
      const { rows } = await v1.query('select * from "applicationActivityTracker" where "leadId" = any($1::int[]) order by "leadId", "createdAt", id', [v1Ids.slice(i, i + 20000)]);
      rows.forEach(r => { if (!t1.has(r.leadId)) t1.set(r.leadId, []); t1.get(r.leadId).push(r); });
    }

    hr('1. ApplicationActivityTrackers');
    const trkFill = new Map(), trkFwd = new Map(), trkV2 = new Map(), cFill = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    let noV2Row = 0, noV1Row = 0, appIdFill = 0;
    const trkFix = [];      // per lead: { v2_lead_id, tracker_id, set:{col:val} }
    const noRowList = [];
    for (const l of leads) {
      const rows1 = t1.get(Number(l.v1_lead_id));
      if (!rows1) { noV1Row++; continue; }
      const r2 = t2.get(Number(l.id));
      // the same v1 row the migration used: matched on createdAt, else the earliest
      const r1 = (r2 && rows1.find(r => new Date(r.createdAt).getTime() === new Date(r2.createdAt).getTime())) || rows1[0];
      if (!r2) { noV2Row++; noRowList.push({ v2_lead_id: Number(l.id), v1_lead_id: Number(l.v1_lead_id), v1_tracker_id: r1.id }); continue; }
      const set = {};
      for (const c of TRK_STUDENT) {
        const a = r1[c], b = r2[c];
        if (a == null) continue;
        if (b == null) { bump(trkFill, c); set[c] = a; }
        else if (TRK_LAST.has(c) && new Date(a) > new Date(b)) { bump(trkFwd, c); set[c] = a; }
        else if (new Date(a).getTime() !== new Date(b).getTime()) bump(trkV2, c);
      }
      for (const c of TRK_COUNSELLOR) if (r1[c] != null && r2[c] == null) bump(cFill, c);
      if (r1.applicationId != null && r2.v1_applicationId == null) { appIdFill++; set.v1_applicationId = r1.applicationId; }
      if (Object.keys(set).length) trkFix.push({ v2_lead_id: Number(l.id), tracker_id: r2.id, v1_tracker_id: r1.id, set });
    }
    log(`  leads with no v1 tracker at all           : ${noV1Row}`);
    log(`  leads with a v1 tracker but NO v2 tracker : ${noV2Row}`);
    log(`  v2 trackers missing v1_applicationId      : ${appIdFill}`);
    log(`\n  student-side columns           FILL   FORWARD   v2-wins/differs`);
    for (const c of TRK_STUDENT) log(`    ${c.padEnd(32)} ${String(trkFill.get(c) || 0).padStart(4)}   ${String(trkFwd.get(c) || 0).padStart(7)}   ${String(trkV2.get(c) || 0).padStart(7)}`);
    log(`\n  counsellor-side columns empty in v2 but set in v1 (REPORT ONLY - v2 owns these):`);
    for (const c of TRK_COUNSELLOR) log(`    ${c.padEnd(32)} ${cFill.get(c) || 0}`);
    log(`\n  => trackers that would change: ${trkFix.length}`);

    // ------------------------------------------------------------ v2_leads application / payment
    hr('2. application + payment columns on v2_leads');
    const apps = leads.filter(l => l.v1_application_id);
    const am = new Map();
    const amIds = apps.map(a => Number(a.v1_application_id));
    for (let i = 0; i < amIds.length; i += 5000) {
      const { rows } = await v1.query('select * from "ApplicationManager" where id = any($1::int[])', [amIds.slice(i, i + 5000)]);
      rows.forEach(r => am.set(r.id, r));
    }
    const cnt = new Map(), leadFix = [], v2wins = new Map();
    for (const a of apps) {
      const s = am.get(Number(a.v1_application_id)); if (!s) continue;
      const set = {};
      const pct1 = (s.applicationStatus === 'untouched' || s.applicationStatus == null) ? 0 : (Number(s.applicationStatus) || 0);
      // booleans: only ever false -> true
      if (s.applicationFormInitiated === true && a.application_form_initiated !== true) set.application_form_initiated = true;
      if (s.applicationFormSubmitted === true && a.application_form_submitted !== true) set.application_form_submitted = true;
      if (s.paymentInitiated === true && a.payment_initiated !== true) set.payment_initiated = true;
      // payment: only ever pending -> completed
      if (s.paymentStatus === 'completed' && a.payment_status !== 'completed') {
        set.payment_status = 'completed'; set.is_payment_done = true;
        if (a.payment_mode == null) set.payment_mode = 'online';
      } else if (s.paymentStatus === 'completed' && a.is_payment_done !== true) set.is_payment_done = true;
      if (s.paymentStatus !== 'completed' && a.payment_status === 'completed') v2wins.set('paid in v2, pending in v1', (v2wins.get('paid in v2, pending in v1') || 0) + 1);
      // numbers: only ever up
      if (pct1 > Number(a.form_percentage_filled || 0)) set.form_percentage_filled = pct1;
      if (s.lastInteractedSection != null && (a.last_interacted_section == null || Number(s.lastInteractedSection) > Number(a.last_interacted_section))) set.last_interacted_section = s.lastInteractedSection;
      // dates / text: only when v2 is empty
      if (s.formCompletionDate != null && a.form_completion_date == null) set.form_completion_date = s.formCompletionDate;
      if (s.registeredOn != null && a.application_registered_on == null) set.application_registered_on = s.registeredOn;
      if (s.paymentMethod != null && a.payment_method == null) set.payment_method = s.paymentMethod;
      Object.keys(set).forEach(k => cnt.set(k, (cnt.get(k) || 0) + 1));
      if (Object.keys(set).length) leadFix.push({ v2_lead_id: Number(a.id), v1_application_id: Number(a.v1_application_id), email: a.registered_email, set });
    }
    log(`  applicants compared: ${apps.length}`);
    log(`  column                        would change`);
    [...cnt.entries()].sort((x, y) => y[1] - x[1]).forEach(([k, n]) => log(`    ${k.padEnd(28)} ${String(n).padStart(6)}`));
    for (const [k, n] of v2wins) log(`  v2 wins, left alone: ${n} ${k}`);
    log(`\n  => applicants whose v2_leads row would change: ${leadFix.length}`);
    leadFix.slice(0, 30).forEach(f => log(`    lead ${String(f.v2_lead_id).padEnd(8)} ${String(f.email).padEnd(34).slice(0, 34)} ${Object.entries(f.set).map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString().slice(0, 10) : v}`).join(' ')}`));
    if (leadFix.length > 30) log(`    ... and ${leadFix.length - 30} more`);

    hr('3. trackers that would change (first 30)');
    trkFix.slice(0, 30).forEach(f => log(`    lead ${String(f.v2_lead_id).padEnd(8)} tracker #${f.tracker_id}  ${Object.entries(f.set).map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString().slice(0, 10) : v}`).join(' ')}`));
    if (trkFix.length > 30) log(`    ... and ${trkFix.length - 30} more`);
    if (noRowList.length) { log(`\n  leads with a v1 tracker but none in v2 (first 15):`); noRowList.slice(0, 15).forEach(r => log(`    ${JSON.stringify(r)}`)); }
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('ERR', e.message); console.error(e.stack); process.exit(1); });
