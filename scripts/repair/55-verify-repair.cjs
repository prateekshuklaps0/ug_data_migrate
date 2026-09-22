/**
 * STREAM H - VERIFY the repair export.  READ-ONLY.  Deliberately independent:
 *
 *   - it declares its OWN copy of the column classes and fails if the rules file differs
 *   - every planned write is checked against the LIVE v2 row with its own logic
 *   - every planned value is traced back to a RAW v1 row (tracker, fee record, fee
 *     transaction, application, lead, stage event, form answer)
 *
 *   node scripts/repair/55-verify-repair.cjs [--run <id>]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connect } = require('../lib/db.cjs');
const M = require('../lib/maps.cjs');
const RULES = require('../lib/repair-rules.cjs');

const ROOT = 'C:/Users/Prateek/Desktop/Repos/data/repair';
const args = process.argv.slice(2);
const runArg = args.includes('--run') ? args[args.indexOf('--run') + 1] : null;
const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(84) + '\n' + t + '\n' + '='.repeat(84));
const problems = [];
const bad = m => { problems.push(m); if (problems.length <= 60) log('  FAIL ' + m); };
const ok = m => log('  ok   ' + m);
const readNd = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const T = v => v == null ? null : new Date(v).getTime();
const blank = v => v === null || v === undefined || String(v).trim() === '' || (Array.isArray(v) && !v.length);
const sameT = (a, b) => a != null && b != null && Math.abs(T(a) - T(b)) <= 1000;

// the verifier's OWN statement of the rules - must match lib/repair-rules.cjs exactly
const MY = {
  v2_leads: {
    FWD_BOOL: ['application_form_initiated', 'application_form_submitted', 'payment_initiated', 'is_payment_done'],
    FWD_PAID: ['payment_status'], FWD_NUM: ['form_percentage_filled', 'last_interacted_section'], FWD_DATE: [],
    FILL: ['payment_completed_at', 'payment_first_initiated_at', 'payment_last_initiated_at', 'payment_partner', 'payment_mode',
      'payment_method', 'application_registered_on', 'form_completion_date', 'lead_stage_date', 'application_stage_date',
      'secondary_source', 'secondary_medium', 'secondary_campaign', 'tertiary_source', 'tertiary_medium', 'tertiary_campaign',
      'widget_id', 'grade', 'alternate_mobile_number'],
  },
  '"ApplicationActivityTrackers"': {
    FWD_BOOL: [], FWD_PAID: [], FWD_NUM: [], FWD_DATE: ['payment_last_Initiated_date', 'application_last_activity_date'],
    FILL: ['applicationForm_start_date', 'payment_Initiated_date', 'application_fee_paidOn', 'applicationFormSubmittedOn',
      'counsellor_first_activity_date', 'counsellor_last_activity_date', 'firstLeadStageUpdated', 'lastLeadStageUpdated', 'v1_applicationId'],
  },
};
const cls = (t, c) => { const x = MY[t]; if (!x) return 'FILL'; for (const [k, a] of Object.entries(x)) if (a.includes(c)) return k; return null; };
// Two different things can make a planned write not apply to the LIVE row:
//   - the PLAN breaks a rule against the row as it was exported  -> a real problem (FAIL)
//   - v2 CHANGED since the export (a counsellor/student acted)   -> the importer re-plans
//     live and keeps v2's value; reported, not a failure
const drift = [];
const checkRule = (label, t, live, c, v, before) => {
  const k = cls(t, c), b = live[c];
  if (blank(v)) return bad(`${label}: ${c} planned BLANK (rule 1)`);
  if (!k) return bad(`${label}: ${c} is not a repairable column`);
  // 1. the plan against the exported "before" (what v2 held when the plan was made)
  const b0 = before ? before[c] : b;
  if (k === 'FILL' && !blank(b0)) return bad(`${label}: ${c} planned over existing ${JSON.stringify(b0)} (rule 2)`);
  if (k === 'FWD_BOOL' && !(v === true && b0 !== true)) return bad(`${label}: ${c} ${b0} -> ${v} is not false->true`);
  if (k === 'FWD_PAID' && !(v === 'completed' && b0 !== 'completed')) return bad(`${label}: ${c} ${b0} -> ${v}`);
  if (k === 'FWD_NUM' && !(blank(b0) || Number(v) > Number(b0))) return bad(`${label}: ${c} ${b0} -> ${v} does not increase`);
  if (k === 'FWD_DATE' && !(blank(b0) || T(v) > T(b0))) return bad(`${label}: ${c} ${b0} -> ${v} does not move later`);
  // 2. has live v2 moved since the export?
  const stillApplies = k === 'FILL' ? blank(b) : k === 'FWD_BOOL' ? b !== true : k === 'FWD_PAID' ? b !== 'completed'
    : k === 'FWD_NUM' ? (blank(b) || Number(v) > Number(b)) : (blank(b) || T(v) > T(b));
  if (!stillApplies) drift.push(`${label}: ${c} is now ${JSON.stringify(b)} in v2 (changed since export) - importer keeps v2's value`);
};

(async () => {
  const runs = fs.readdirSync(ROOT).filter(d => /^\d{4}-/.test(d)).sort();
  const runId = runArg || runs[runs.length - 1];
  const DIR = path.join(ROOT, runId);
  hr(`VERIFY STREAM H REPAIR   ${runId}`);
  const man = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  for (const [f, m] of Object.entries(man.files)) {
    if (crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, f))).digest('hex') !== m.sha256) bad(`${f} changed after export`);
  }
  ok(`checksums verified for ${Object.keys(man.files).length} files`);
  if (JSON.stringify(MY) !== JSON.stringify(RULES.CLASSES)) bad('the rules file column classes differ from the verifier\'s own statement of the rules');
  else ok('column classes in the rules file match the verifier\'s own statement of the rules');
  const F = readNd(path.join(DIR, 'h_forms.ndjson')), L = readNd(path.join(DIR, 'h_leads.ndjson')), K = readNd(path.join(DIR, 'h_trackers.ndjson'));

  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    // ---------------------------------------------------------------- A. scope
    hr('A. scope');
    const ids = [...new Set([...F, ...L, ...K].map(x => x.v2_lead_id))];
    const live = new Map();
    for (let i = 0; i < ids.length; i += 20000) {
      (await v2.query('select * from v2_leads where id = any($1::bigint[])', [ids.slice(i, i + 20000)])).rows.forEach(r => live.set(Number(r.id), r));
    }
    const out = ids.filter(i => { const r = live.get(i); return !r || r.is_deleted || Number(r.org_id) !== M.ORG_V2 || Number(r.school_id) !== M.SCHOOL_V2 || !M.V2_FORMS.includes(Number(r.form_id)) || r.v1_lead_id == null; });
    if (out.length) bad(`${out.length} target lead(s) outside scope or deleted`); else ok(`${ids.length} distinct leads: all live, migrated, org ${M.ORG_V2}, school ${M.SCHOOL_V2}, forms 104/105`);

    // ---------------------------------------------------------------- B. rules on LIVE rows
    hr('B. the rules, checked against the LIVE v2 rows');
    const n0 = problems.length;
    for (const g of L) { const l = live.get(g.v2_lead_id); for (const [c, v] of Object.entries(g.set)) checkRule(`lead ${g.v2_lead_id}`, 'v2_leads', l, c, v, g.before); }
    const trk = new Map();
    for (let i = 0; i < K.length; i += 5000) {
      (await v2.query('select * from "ApplicationActivityTrackers" where id = any($1::int[])', [K.slice(i, i + 5000).map(k => k.tracker_id)])).rows.forEach(r => trk.set(Number(r.id), r));
    }
    for (const g of K) { const t = trk.get(g.tracker_id); if (!t || Number(t.leadId) !== g.v2_lead_id) { bad(`tracker #${g.tracker_id} missing or moved`); continue; } for (const [c, v] of Object.entries(g.set)) checkRule(`tracker ${g.v2_lead_id}`, '"ApplicationActivityTrackers"', t, c, v, g.before); }
    const ugl = new Map();
    for (let i = 0; i < F.length; i += 2000) (await v2.query('select * from under_graduate where id = any($1::int[])', [F.slice(i, i + 2000).map(f => f.ug_id)])).rows.forEach(r => ugl.set(Number(r.id), r));
    for (const g of F) { const u = ugl.get(g.ug_id); if (!u || Number(u.lead_id) !== g.v2_lead_id) { bad(`form row #${g.ug_id} missing or moved`); continue; } for (const [c, v] of Object.entries(g.set)) checkRule(`form ${g.v2_lead_id}`, 'under_graduate', u, c, v, g.before); }
    // coherence: nothing may leave v2 saying "pending" with paid detail
    for (const g of L) { const l = live.get(g.v2_lead_id); const st = g.set.payment_status || l.payment_status; if ((g.set.payment_completed_at || g.set.payment_partner || g.set.payment_mode) && st !== 'completed') bad(`lead ${g.v2_lead_id}: payment detail on a lead that is not paid`); }
    if (drift.length) {
      log(`  note ${drift.length} planned value(s) no longer apply because v2 CHANGED since the export (live CRM use).`);
      log("       The importer re-checks every row live and keeps v2's value for these:");
      drift.slice(0, 10).forEach(d => log('         ' + d));
    }
    if (problems.length === n0) ok(`${[...F, ...L, ...K].reduce((n, g) => n + Object.keys(g.set).length, 0)} planned writes: content only fills EMPTY v2 fields, progress only moves forward, nothing blank, payment coherent`);

    // ---------------------------------------------------------------- C. provenance
    hr('C. every value traced to a RAW v1 row');
    const leadRows = L.map(g => ({ g, l: live.get(g.v2_lead_id) }));
    const v1ids = [...new Set([...L, ...K].map(g => Number(live.get(g.v2_lead_id).v1_lead_id)))];
    const amids = [...new Set([...L, ...K, ...F].map(g => live.get(g.v2_lead_id).v1_application_id).filter(Boolean).map(Number))];
    const ml = new Map(), t1 = new Map(), ev = new Map(), am = new Map(), fd = new Map(), ans = new Map(), declT = new Map();
    for (let i = 0; i < v1ids.length; i += 2000) {
      const ch = v1ids.slice(i, i + 2000);
      (await v1.query('select * from "manageLeads" where id = any($1::int[])', [ch])).rows.forEach(r => ml.set(r.id, r));
      (await v1.query('select * from "applicationActivityTracker" where "leadId" = any($1::int[])', [ch])).rows.forEach(r => { if (!t1.has(r.leadId)) t1.set(r.leadId, []); t1.get(r.leadId).push(r); });
      (await v1.query(`select "leadId", "createdAt", "eventType"->>'title' title, "leadStageId" from "UserTimelines" where "leadId" = any($1::int[])
                        and "eventType"->>'title' in ('Changed_Lead_Stage','Stage Assigned','Application Stage Changed')`, [ch]))
        .rows.forEach(r => { if (!ev.has(r.leadId)) ev.set(r.leadId, []); ev.get(r.leadId).push(r); });
    }
    for (let i = 0; i < amids.length; i += 2000) {
      const ch = amids.slice(i, i + 2000);
      (await v1.query('select * from "ApplicationManager" where id = any($1::int[])', [ch])).rows.forEach(r => am.set(r.id, r));
      (await v1.query(`select f.*, (select array_agg(t."paidOn") from feetransactions t where t."feeDueId" = f.id) paid_ons,
                              (select array_agg(t."paymentPartner"::text) from feetransactions t where t."feeDueId" = f.id) tx_partners
                       from feedues f where f."applicationManagerId" = any($1::int[])`, [ch])).rows.forEach(r => { if (!fd.has(r.applicationManagerId)) fd.set(r.applicationManagerId, []); fd.get(r.applicationManagerId).push(r); });
      (await v1.query(`select "applicationManagerId" a, "sectionFieldId" sf, "createdAt", "updatedAt", value, "fileName", "dynamicTableData" dt
                       from "ApplicationResponses" where "applicationManagerId" = any($1::int[])`, [ch])).rows.forEach(r => { if (!ans.has(r.a)) ans.set(r.a, []); ans.get(r.a).push(r); });
    }
    for (const [a, rows] of ans) {
      const d = rows.filter(r => [4575, 5291, 4576, 5292, 11268].includes(r.sf) && !blank(r.value));
      if (d.length) declT.set(a, Math.max(...d.map(r => T(r.updatedAt))));
    }
    const tally = new Map();
    const tick = (c, okv) => { const x = tally.get(c) || [0, 0]; x[okv ? 0 : 1]++; tally.set(c, x); };
    for (const { g, l } of leadRows) {
      const m = ml.get(Number(l.v1_lead_id)) || {};
      const s = l.v1_application_id ? am.get(Number(l.v1_application_id)) : null;
      const dues = s ? fd.get(s.id) || [] : [];
      const paid = dues.filter(d => d.isPaid);
      const trkTimes = (t1.get(Number(l.v1_lead_id)) || []);
      const events = ev.get(Number(l.v1_lead_id)) || [];
      for (const [c, v] of Object.entries(g.set)) {
        let okv = false;
        if (['secondary_source', 'secondary_medium', 'secondary_campaign', 'tertiary_source', 'tertiary_medium', 'tertiary_campaign', 'widget_id', 'grade', 'alternate_mobile_number'].includes(c)) {
          const k = { secondary_source: 'secondarySource', secondary_medium: 'secondaryMedium', secondary_campaign: 'secondaryCampaign', tertiary_source: 'tertiarySource', tertiary_medium: 'tertiaryMedium', tertiary_campaign: 'tertiaryCampaign', widget_id: 'widgetId', grade: 'grade', alternate_mobile_number: 'alternateMobileNumber' }[c];
          okv = String(m[k]) === String(v);
        } else if (c === 'application_form_initiated') okv = s && s.applicationFormInitiated === true;
        else if (c === 'application_form_submitted') okv = s && s.applicationFormSubmitted === true;
        else if (c === 'payment_initiated') okv = s && s.paymentInitiated === true;
        else if (c === 'payment_status' || c === 'is_payment_done') okv = s && s.paymentStatus === 'completed' && paid.length > 0;
        else if (c === 'form_percentage_filled') okv = s && Number(s.applicationStatus) === Number(v);
        else if (c === 'last_interacted_section') okv = s && Number(s.lastInteractedSection) === Number(v);
        else if (c === 'application_registered_on') okv = s && sameT(s.registeredOn, v);
        else if (c === 'form_completion_date') okv = s && s.applicationFormSubmitted === true && (sameT(s.formCompletionDate, v) || Math.abs((declT.get(s.id) || 0) - T(v)) <= 1000);
        else if (c === 'payment_completed_at') okv = paid.length > 0 && (trkTimes.some(t => sameT(t.application_fee_paidOn, v)) || paid.some(p => sameT(p.updatedAt, v) || (p.paid_ons || []).some(x => sameT(x, v))));
        else if (c === 'payment_partner') okv = paid.some(p => RULES.normPartner(p.paymentPartner) === v || (p.tx_partners || []).some(x => RULES.normPartner(x) === v));
        else if (c === 'payment_mode') okv = v === 'online' && paid.length > 0;
        else if (c === 'payment_method') okv = s && String(s.paymentMethod) === String(v);
        else if (c === 'payment_first_initiated_at') okv = trkTimes.some(t => sameT(t.payment_Initiated_date, v)) || dues.some(d => sameT(d.createdAt, v));
        else if (c === 'payment_last_initiated_at') okv = trkTimes.some(t => sameT(t.payment_last_Initiated_date, v)) || dues.some(d => sameT(d.createdAt, v));
        else if (c === 'lead_stage_date') okv = events.some(e => e.leadStageId != null && sameT(e.createdAt, v)) || (sameT(l.created_at, v) && !events.some(e => e.leadStageId != null && e.title !== 'Application Stage Changed'));
        else if (c === 'application_stage_date') okv = events.some(e => e.title === 'Application Stage Changed' && sameT(e.createdAt, v)) || (s && sameT(s.registeredOn, v));
        tick('v2_leads.' + c, okv);
        if (!okv) bad(`lead ${g.v2_lead_id}: ${c}=${JSON.stringify(v)} not found in any raw v1 source`);
      }
    }
    for (const g of K) {
      const l = live.get(g.v2_lead_id);
      const rows1 = t1.get(Number(l.v1_lead_id)) || [];
      const events = ev.get(Number(l.v1_lead_id)) || [];
      const a = l.v1_application_id ? ans.get(Number(l.v1_application_id)) || [] : [];
      const s = l.v1_application_id ? am.get(Number(l.v1_application_id)) : null;
      const paid = s ? (fd.get(s.id) || []).filter(d => d.isPaid) : [];
      for (const [c, v] of Object.entries(g.set)) {
        let okv = c === 'v1_applicationId' ? rows1.some(r => Number(r.applicationId) === Number(v)) : rows1.some(r => sameT(r[c], v));
        if (!okv && ['firstLeadStageUpdated', 'lastLeadStageUpdated'].includes(c)) okv = events.some(e => e.title === 'Changed_Lead_Stage' && sameT(e.createdAt, v));
        if (!okv && c === 'applicationForm_start_date') okv = a.length && Math.min(...a.map(r => T(r.createdAt))) === T(v);
        if (!okv && c === 'application_last_activity_date') okv = a.length && Math.max(...a.map(r => T(r.updatedAt))) === T(v);
        if (!okv && c === 'applicationFormSubmittedOn') okv = s && s.applicationFormSubmitted === true && Math.abs((declT.get(s.id) || 0) - T(v)) <= 1000;
        if (!okv && c === 'application_fee_paidOn') okv = paid.some(p => sameT(p.updatedAt, v) || (p.paid_ons || []).some(x => sameT(x, v)));
        tick('tracker.' + c, okv);
        if (!okv) bad(`tracker ${g.v2_lead_id}: ${c}=${v} not found in any raw v1 source`);
      }
    }
    let fTot = 0, fOk = 0;
    for (const g of F) {
      const pool = new Set();
      for (const r of ans.get(g.v1_application_id) || []) {
        if (r.value != null) pool.add(String(r.value).trim()); if (r.fileName) pool.add(String(r.fileName));
        for (const c of (r.dt && r.dt.rowsCellsData) || []) if (c && c.value != null) pool.add(String(c.value).trim());
      }
      for (const [c, v] of Object.entries(g.set)) {
        if (typeof v === 'boolean') continue;
        fTot++; const sv = String(v);
        if (pool.has(sv) || sv.split(', ').every(x => pool.has(x)) || (/-01$/.test(sv) && pool.has(sv.slice(0, -3)))) fOk++;
        else bad(`form ${g.v2_lead_id}: ${c}=${JSON.stringify(sv).slice(0, 40)} not in the raw v1 answers`);
      }
    }
    [...tally.entries()].sort().forEach(([c, [y, n]]) => log(`  ${n ? 'FAIL' : 'ok  '} ${c.padEnd(42)} ${y}/${y + n} traced to raw v1`));
    log(`  ${fOk === fTot ? 'ok  ' : 'FAIL'} under_graduate form answers                ${fOk}/${fTot} traced to the raw v1 answers`);

    // ---------------------------------------------------------------- D. sanity
    hr('D. sanity of the dates');
    const now = Date.now(); let future = 0, beforeCreate = 0, paidBeforeInit = 0;
    for (const { g, l } of leadRows) {
      for (const [c, v] of Object.entries(g.set)) if (/_(at|date|on)$/.test(c) && T(v) > now + 60000) future++;
      if (g.set.lead_stage_date && T(g.set.lead_stage_date) < T(l.created_at) - 120000) beforeCreate++;
      const pc = g.set.payment_completed_at || l.payment_completed_at, pi = g.set.payment_first_initiated_at || l.payment_first_initiated_at;
      if (pc && pi && T(pc) < T(pi) - 86400000) paidBeforeInit++;
    }
    (future ? bad : ok)(`${future} planned date(s) in the future`);
    (beforeCreate ? bad : ok)(`${beforeCreate} lead_stage_date(s) earlier than the lead was created`);
    (paidBeforeInit ? bad : ok)(`${paidBeforeInit} payment completed more than a day before it was initiated`);

    hr(problems.length ? `VERIFY FINISHED - ${problems.length} PROBLEM(S)` : 'VERIFY FINISHED - NO PROBLEMS');
    if (problems.length > 60) log(`  (${problems.length - 60} more not printed)`);
    if (problems.length) process.exitCode = 1;
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('VERIFY FAILED TO RUN:', e.message); console.error(e.stack); process.exit(1); });
