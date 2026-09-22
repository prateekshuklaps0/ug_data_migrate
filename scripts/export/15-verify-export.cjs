/**
 * Independent review of an export folder.  READ-ONLY.
 *
 * This deliberately re-reads v1 and v2 and re-derives the expected values by a
 * different route from the exporter, so that a bug in the exporter's mapping does
 * not simply repeat itself here. It answers: "if we import these files, is what
 * lands in v2 a faithful copy of v1?"
 *
 *   node scripts/export/15-verify-export.cjs [--run <id>]
 */
const fs = require('fs');
const path = require('path');
const { connect } = require('../lib/db.cjs');
const M = require('../lib/maps.cjs');
const { planGapFill, needsGapFill } = require('../lib/promotion.cjs');

const REPOS = 'C:/Users/Prateek/Desktop/Repos';
const EXPORT_ROOT = path.join(REPOS, 'data', 'export');
const args = process.argv.slice(2);
const runArg = args.includes('--run') ? args[args.indexOf('--run') + 1] : null;

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78));
const readNd = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

const iso = v => v === null || v === undefined ? null : new Date(v).toISOString();
const same = (a, b) => (a === null || a === undefined ? null : a) === (b === null || b === undefined ? null : b);

(async () => {
  const runs = fs.readdirSync(EXPORT_ROOT).filter(d => fs.statSync(path.join(EXPORT_ROOT, d)).isDirectory()).sort();
  const runId = runArg || runs[runs.length - 1];
  const DIR = path.join(EXPORT_ROOT, runId);
  hr(`VERIFY EXPORT  ${runId}`);

  const leads = readNd(path.join(DIR, 'leads.ndjson'));
  const ugLead = readNd(path.join(DIR, 'under_graduate_lead.ndjson'));
  const ugApp = readNd(path.join(DIR, 'under_graduate_applicant.ndjson'));
  const timelines = readNd(path.join(DIR, 'timelines.ndjson'));
  const notes = readNd(path.join(DIR, 'notes.ndjson'));
  const tags = readNd(path.join(DIR, 'lead_tags.ndjson'));
  const students = readNd(path.join(DIR, 'students.ndjson'));
  const promotions = readNd(path.join(DIR, 'promotions.ndjson'));

  const v1 = await connect('v1');
  const v2 = await connect('v2');
  const problems = [];
  const bad = m => { problems.push(m); log('  FAIL ' + m); };
  const ok = m => log('  ok   ' + m);

  try {
    // ---------------------------------------------------------------- A. the set is right
    hr('A. is the exported set exactly the missing set?');
    const { rows: allV1 } = await v1.query(
      'select id from "manageLeads" where "applicationFormId" = any($1::int[])', [M.V1_FORMS]);
    const allIds = allV1.map(r => r.id);
    const present = new Set();
    for (let i = 0; i < allIds.length; i += 20000) {
      const { rows } = await v2.query('select v1_lead_id from v2_leads where v1_lead_id = any($1::int[])', [allIds.slice(i, i + 20000)]);
      rows.forEach(r => present.add(r.v1_lead_id));
    }
    const missing = new Set(allIds.filter(id => !present.has(id)));
    const exported = new Set(leads.map(l => l.v1_lead_id));
    const held = fs.readFileSync(path.join(DIR, 'held_back_for_review.csv'), 'utf8')
      .split('\n').slice(1).filter(Boolean).map(l => Number(l.split(',')[0]));
    const covered = new Set([...exported, ...held]);
    const notCovered = [...missing].filter(id => !covered.has(id));
    const extra = [...exported].filter(id => !missing.has(id));
    if (notCovered.length) bad(`${notCovered.length} missing v1 leads are neither exported nor held back: ${notCovered.slice(0, 10)}`);
    else ok(`every one of the ${missing.size} missing v1 leads is either exported (${exported.size}) or held back (${held.length})`);
    if (extra.length) bad(`${extra.length} exported leads are NOT missing from v2 (would duplicate): ${extra.slice(0, 10)}`);
    else ok('no exported lead already exists in v2');

    // ---------------------------------------------------------------- B. field fidelity vs v1
    hr('B. field-by-field against v1 manageLeads (all rows, not a sample)');
    const { rows: src } = await v1.query('select * from "manageLeads" where id = any($1::int[])', [[...exported]]);
    const srcBy = new Map(src.map(r => [r.id, r]));
    let checked = 0;
    const mism = new Map();
    const note = k => mism.set(k, (mism.get(k) || 0) + 1);
    for (const l of leads) {
      const s = srcBy.get(l.v1_lead_id);
      if (!s) { bad(`exported lead ${l.v1_lead_id} does not exist in v1`); continue; }
      checked++;
      if (!same(l.registered_name, s.registeredName)) note('registered_name');
      if (!same(l.registered_email, s.registeredEmail)) note('registered_email');
      if (!same(l.registered_mobile, s.registeredMobile)) note('registered_mobile');
      if (!same(l.source, s.source)) note('source');
      if (!same(l.medium, s.medium)) note('medium');
      if (!same(l.campaign, s.campaign)) note('campaign');
      if (!same(l.city, s.city)) note('city');
      if (!same(l.state, s.state)) note('state');
      if (!same(l.lead_type, s.leadType || 'primary')) note('lead_type');
      if (!same(iso(l.created_at), iso(s.createdAt))) note('created_at');
      if (!same(iso(l.updated_at), iso(s.updatedAt))) note('updated_at');
      if (!same(iso(l.registered_on), iso(s.registeredOn))) note('registered_on');
      if (!same(l.is_deleted, s.isLeadDeleted ?? false)) note('is_deleted');
      if (!same(l.concat_smc, s.concatSMC)) note('concat_smc');
      if (!same(l.country_code, s.countryCode === null || s.countryCode === undefined ? null : String(s.countryCode).replace(/^\+/, '').trim() || null)) note('country_code');
      if (!same(l.human_handoff, s.humanHandoff === null || s.humanHandoff === undefined ? null : String(s.humanHandoff))) note('human_handoff');
      if (l.org_id !== M.ORG_V2 || l.school_id !== M.SCHOOL_V2) note('org/school');
      const tgt = M.FORM_MAP[s.applicationFormId];
      if (l.form_id !== tgt.form_id || l.program_id !== tgt.program_id || l.batch_id !== tgt.batch_id || l.round_id !== tgt.round_id) note('placement');
      if (l.lead_table_id !== M.LEAD_TABLE_ID) note('lead_table_id');
      if (l.status !== 'active') note('status');
      if (JSON.stringify(l.lead_payload) !== JSON.stringify(s.leadPayload)) note('lead_payload');
    }
    if (mism.size) for (const [k, n] of mism) bad(`${k} differs from v1 on ${n} of ${checked} rows`);
    else ok(`all ${checked} exported leads match v1 on every checked column`);

    // ---------------------------------------------------------------- C. stage / counsellor by name
    hr('C. stage and counsellor resolve to the right THING, not just an id');
    const { rows: s1 } = await v1.query('select id, "stageName" from "LeadStage" where "organizationId"=68 and "schoolId"=11');
    const s1By = new Map(s1.map(r => [r.id, r.stageName.trim().toLowerCase()]));
    const { rows: s2 } = await v2.query('select id, "stageName" from "leadStage" where "organizationId"=$1 and "schoolId"=$2', [M.ORG_V2, M.SCHOOL_V2]);
    const s2By = new Map(s2.map(r => [r.id, r.stageName.trim().toLowerCase()]));
    let stageOk = 0;
    for (const l of leads) {
      const s = srcBy.get(l.v1_lead_id); if (!s) continue;
      if (s.leadStageId == null) { if (l.lead_stage_id !== null) bad(`lead ${l.v1_lead_id}: v1 stage null but v2 ${l.lead_stage_id}`); continue; }
      const want = s1By.get(s.leadStageId), got = s2By.get(l.lead_stage_id);
      if (want !== got) bad(`lead ${l.v1_lead_id}: stage "${want}" -> "${got}"`); else stageOk++;
    }
    ok(`${stageOk} leads land on a v2 stage with the same NAME as their v1 stage`);

    const { rows: cs } = await v2.query(
      'select id, email, name from users where id = any($1::int[])', [[...new Set(leads.map(l => l.counsellor_id).filter(Boolean))]]);
    const csBy = new Map(cs.map(r => [r.id, r]));
    const { rows: v1cs } = await v1.query(
      'select uuid, email, name from users where uuid = any($1::uuid[])', [[...new Set(leads.map(l => l._v1.assignTo).filter(Boolean))]]);
    const v1csBy = new Map(v1cs.map(r => [r.uuid, r]));
    const csPairs = new Map();
    for (const l of leads) {
      if (!l._v1.assignTo) continue;
      const a = v1csBy.get(l._v1.assignTo), b = csBy.get(l.counsellor_id);
      if (!b) { bad(`lead ${l.v1_lead_id}: counsellor_id ${l.counsellor_id} is not a v2 user`); continue; }
      const aBase = (a ? a.email : '').replace(/\+\d+@/, '@').toLowerCase();
      const bBase = (b.email || '').replace(/\+\d+@/, '@').toLowerCase();
      const k = `${a ? a.email : '?'}  ->  ${b.email}${aBase === bBase ? '' : '   *** DIFFERENT PERSON ***'}`;
      csPairs.set(k, (csPairs.get(k) || 0) + 1);
      if (aBase !== bBase) bad(`lead ${l.v1_lead_id}: counsellor ${a ? a.email : '?'} mapped to ${b.email}`);
    }
    log('  counsellor pairings actually used by this export:');
    [...csPairs.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => log(`    ${String(n).padStart(4)}  ${k}`));

    // ---------------------------------------------------------------- D. timelines
    hr('D. timelines');
    const { rows: tsrc } = await v1.query(
      'select id, "leadId", "eventType", message, payload, "leadStageId", "createdAt" from "UserTimelines" where "leadId" = any($1::int[])',
      [[...exported]]);
    if (tsrc.length !== timelines.length) bad(`v1 has ${tsrc.length} timelines for the exported leads but the file has ${timelines.length}`);
    else ok(`timeline count matches v1 exactly (${tsrc.length})`);
    const tsrcBy = new Map(tsrc.map(r => [Number(r.id), r]));
    const evPairs = new Map();
    let tlBad = 0;
    for (const t of timelines) {
      const s = tsrcBy.get(Number(t.v1_timeline_id));
      if (!s) { bad(`timeline ${t.v1_timeline_id} not found in v1`); tlBad++; continue; }
      if (!exported.has(t.v1_lead_id)) { bad(`timeline ${t.v1_timeline_id} points at a lead not being imported`); tlBad++; }
      if (!same(iso(t.created_at), iso(s.createdAt))) { bad(`timeline ${t.v1_timeline_id} created_at differs`); tlBad++; }
      if (!same(t.description, s.message)) { bad(`timeline ${t.v1_timeline_id} description differs`); tlBad++; }
      if (JSON.stringify(t.metadata) !== JSON.stringify(s.payload)) { bad(`timeline ${t.v1_timeline_id} metadata differs`); tlBad++; }
      if (t.template_id !== null) { bad(`timeline ${t.v1_timeline_id} has a non-null template_id`); tlBad++; }
      if (t.org_id !== M.ORG_V2 || t.school_id !== M.SCHOOL_V2) { bad(`timeline ${t.v1_timeline_id} org/school wrong`); tlBad++; }
      evPairs.set(`${s.eventType && s.eventType.title} -> ${t.event_type}`, (evPairs.get(`${s.eventType && s.eventType.title} -> ${t.event_type}`) || 0) + 1);
    }
    if (!tlBad) ok('every timeline matches its v1 row on created_at, description, metadata, org/school');
    log('  event type mapping used:');
    [...evPairs.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => log(`    ${String(n).padStart(4)}  ${k}`));

    // Do these event_type values already exist in v2? A per-value EXISTS probe against
    // one partition, not a COUNT over all of them - `timelines` is ~170 GB.
    const evs = [...new Set(timelines.map(t => t.event_type))];
    for (const e of evs) {
      const { rows } = await v2.query(
        `select 1 from timelines_p202609 where event_type = $1 limit 1`, [e]);
      if (rows.length) ok(`event_type "${e}" is already in use in v2`);
      else bad(`event_type "${e}" has never been used in v2 - check the mapping`);
    }

    // ---------------------------------------------------------------- E. notes / tags / students
    hr('E. notes, tags, students');
    const { rows: nsrc } = await v1.query('select id, "leadId", "userId", message, "createdAt" from "Notes" where "leadId" = any($1::int[])', [[...exported]]);
    if (nsrc.length !== notes.length) bad(`v1 has ${nsrc.length} notes but the file has ${notes.length}`);
    else ok(`note count matches v1 (${nsrc.length})`);
    for (const n of notes) {
      const s = nsrc.find(x => x.id === n.v1_note_id);
      if (!s) { bad(`note ${n.v1_note_id} not in v1`); continue; }
      if (n.content !== (s.message || '').trim()) bad(`note ${n.v1_note_id} content differs`);
      if (n.admin_id === null) bad(`note ${n.v1_note_id} has null admin_id but the column is NOT NULL`);
      const { rows: [u] } = await v2.query('select id, v1_id, email from users where id=$1', [n.admin_id]);
      if (!u || u.v1_id !== s.userId) bad(`note ${n.v1_note_id} admin_id ${n.admin_id} does not correspond to v1 user ${s.userId}`);
      else ok(`note ${n.v1_note_id} author v1 ${s.userId} -> v2 ${u.id} ${u.email}`);
    }
    for (const t of tags) {
      const { rows: [tg] } = await v2.query('select id, name, org_id from tags where id=$1', [t.tag_id]);
      if (!tg || tg.org_id !== M.ORG_V2) bad(`tag ${t.tag_id} is not an org ${M.ORG_V2} tag`);
      else ok(`tag "${t.tag_name}" -> v2 tags.id ${tg.id} "${tg.name}"`);
    }
    for (const s of students) {
      const { rows: [u1] } = await v1.query('select id, email, name, password, "mobileNumber" from users where id=$1', [s.v1_id]);
      if (!u1) { bad(`student v1 ${s.v1_id} not found`); continue; }
      if (s.email !== u1.email || s.name !== u1.name || s.password_hash !== u1.password || s.phone !== u1.mobileNumber) {
        bad(`student v1 ${s.v1_id} fields differ from v1`);
      } else ok(`student v1 ${s.v1_id} ${s.email} matches v1 (password carried over)`);
      const { rows: ex } = await v2.query('select id from users where v1_id=$1', [s.v1_id]);
      if (ex.length) bad(`student v1 ${s.v1_id} already exists in v2 as ${ex[0].id}`);
    }

    // ---------------------------------------------------------------- F. applicants and the promotion
    hr('F. applicants and the promotion');
    for (const l of leads.filter(x => x.type === 'applicant')) {
      const { rows: [am] } = await v1.query('select * from "ApplicationManager" where id=$1', [l.v1_application_id]);
      if (!am) { bad(`applicant ${l.v1_lead_id}: v1 application ${l.v1_application_id} not found`); continue; }
      if (l.application_number !== am.applicationNum) bad(`applicant ${l.v1_lead_id}: application_number differs`);
      if (l.v1_user_id !== am.userId) bad(`applicant ${l.v1_lead_id}: v1_user_id differs`);
      if (l.application_form_submitted !== (am.applicationFormSubmitted ?? false)) bad(`applicant ${l.v1_lead_id}: submitted differs`);
      if (l.payment_status !== (am.paymentStatus || 'pending')) bad(`applicant ${l.v1_lead_id}: payment_status differs`);
      const { rows: [asx] } = await v2.query('select "stageName" from "applicationStage" where id=$1', [l.application_stage_id]);
      const { rows: [as1] } = await v1.query('select "stageName" from "LeadStage" where id=$1', [am.applicationStageId]);
      if (as1 && (!asx || asx.stageName.trim().toLowerCase() !== as1.stageName.trim().toLowerCase())) {
        bad(`applicant ${l.v1_lead_id}: application stage "${as1.stageName}" -> "${asx ? asx.stageName : null}"`);
      } else ok(`applicant ${l.v1_lead_id} ${l.application_number} stage "${as1 ? as1.stageName : null}" payment=${l.payment_status} submitted=${l.application_form_submitted}`);
      const { rows: dupNum } = await v2.query(
        'select id, org_id from v2_leads where application_number = $1', [l.application_number]);
      if (dupNum.length) bad(`application_number ${l.application_number} already exists in v2 on row(s) ${dupNum.map(d => d.id)}`);
    }
    for (const p of promotions) {
      // SELECT * deliberately: the gap preview below inspects every column in
      // p.after, and a narrow column list would make missing ones read as undefined
      // and silently under-report what the importer is going to fill.
      const { rows: [cur] } = await v2.query('select * from v2_leads where id=$1', [p.v2_lead_id]);
      if (!cur) { bad(`promotion target v2#${p.v2_lead_id} not found`); continue; }
      if (cur.v1_lead_id !== p.v1_lead_id) bad(`promotion v2#${p.v2_lead_id}: v1_lead_id mismatch`);
      const gapMode = needsGapFill(cur);
      const plan = gapMode ? planGapFill(cur, p.after) : null;   // the importer's own rule, shared
      if (gapMode) {
        // Not a failure: the live v2 app promoted the lead itself. The importer switches
        // to gap-fill mode and only writes fields v2 left empty.
        const gaps = Object.entries(plan.fill);
        ok(`promotion v2#${p.v2_lead_id} was already promoted by v2 (type=${cur.type}) - importer will GAP-FILL ${gaps.length} field(s):`);
        gaps.forEach(([c, v]) => log(`      fill    ${c.padEnd(30)} ${JSON.stringify(cur[c])} -> ${JSON.stringify(v)}`));
        plan.kept.forEach(k => log(`      keep v2 ${k.col.padEnd(30)} ${JSON.stringify(k.v2)}   (v1 says ${JSON.stringify(k.v1)})`));
        log('      never touched: type, updated_at (v2 owns them once it has promoted)');
      } else ok(`promotion v2#${p.v2_lead_id} "${cur.registered_name}" is still type=lead with no application - safe to promote`);
      // what the row will ACTUALLY look like - not the raw v1 values
      const eff = gapMode ? { ...cur, ...plan.fill } : { ...cur, ...p.after };
      log(`    before: type=${cur.type} num=${cur.application_number} pay=${cur.payment_status} submitted=${cur.application_form_submitted} user_id=${cur.user_id}`);
      log(`    after : type=${eff.type} num=${eff.application_number} pay=${eff.payment_status} submitted=${eff.application_form_submitted} user_id=${gapMode ? eff.user_id : '(the student created by this import)'}`);
      if (gapMode && cur.user_id !== null && eff.user_id !== cur.user_id) bad(`promotion v2#${p.v2_lead_id} would change user_id - that would unlink the student's login`);
      const { rows: [am] } = await v1.query('select * from "ApplicationManager" where id=$1', [p.v1_application_id]);
      if (p.after.application_number !== am.applicationNum) bad(`promotion v2#${p.v2_lead_id}: application_number in the export differs from v1`);
      // the uniqueness check only matters for a number that will actually be written
      const writtenNum = gapMode ? plan.fill.application_number : p.after.application_number;
      if (writtenNum) {
        const { rows: dupNum } = await v2.query('select id from v2_leads where application_number = $1 and id <> $2', [writtenNum, p.v2_lead_id]);
        if (dupNum.length) bad(`promotion application_number ${writtenNum} already on v2 row(s) ${dupNum.map(d => d.id)}`);
      }
    }

    // ---------------------------------------------------------------- F2. activity trackers
    hr('F2. activity trackers');
    const trackers = readNd(path.join(DIR, 'activity_trackers.ndjson'));
    const trackerUpdates = readNd(path.join(DIR, 'activity_tracker_updates.ndjson'));
    const { rows: trkSrc } = trackers.length ? await v1.query(
      'select * from "applicationActivityTracker" where "leadId" = any($1::int[])',
      [trackers.map(t => t.v1_leadId)]) : { rows: [] };
    const trkByLead = new Map();
    for (const r of trkSrc) if (!trkByLead.has(r.leadId) || new Date(r.createdAt) < new Date(trkByLead.get(r.leadId).createdAt)) trkByLead.set(r.leadId, r);
    let trkBad = 0;
    const TCOLS = ['applicationForm_start_date', 'payment_Initiated_date', 'payment_last_Initiated_date',
      'counsellor_first_activity_date', 'counsellor_last_activity_date', 'application_fee_paidOn',
      'application_last_activity_date', 'lastLeadStageUpdated', 'firstLeadStageUpdated',
      'applicationFormSubmittedOn', 'createdAt', 'updatedAt'];
    for (const t of trackers) {
      const s = trkByLead.get(t.v1_leadId);
      if (!s) { bad(`tracker for v1 lead ${t.v1_leadId} has no v1 row`); trkBad++; continue; }
      if (!exported.has(t.v1_leadId)) { bad(`tracker references lead ${t.v1_leadId} which is not being imported`); trkBad++; }
      if (t.v1_applicationId !== s.applicationId) { bad(`tracker ${t.v1_leadId}: applicationId differs`); trkBad++; }
      for (const c of TCOLS) if (iso(t[c]) !== iso(s[c])) { bad(`tracker ${t.v1_leadId}: ${c} differs`); trkBad++; }
    }
    if (!trkBad) ok(`all ${trackers.length} activity trackers match v1 column-for-column`);
    const trkIds = trackers.map(t => t.v1_leadId);
    const { rows: trkEx } = trkIds.length ? await v2.query(
      'select "v1_leadId", "leadId" from "ApplicationActivityTrackers" where "v1_leadId" = any($1::int[])', [trkIds]) : { rows: [] };
    if (trkEx.length) bad(`${trkEx.length} activity tracker row(s) already exist in v2 for these v1 lead ids`);
    else ok('no activity tracker row exists yet for any exported lead');
    for (const u of trackerUpdates) {
      const { rows: [cur] } = await v2.query('select * from "ApplicationActivityTrackers" where "leadId"=$1', [u.v2_lead_id]);
      if (!cur) { ok(`promotion ${u.v2_lead_id} has no tracker yet - one will be inserted`); continue; }
      const diff = Object.keys(u.after).filter(c => iso(cur[c]) !== iso(u.after[c]));
      ok(`promotion tracker #${cur.id} (v2 lead ${u.v2_lead_id}) would change ${diff.length} column(s): ${diff.join(', ') || 'none'}`);
    }

    // ---------------------------------------------------------------- G. under_graduate
    hr('G. under_graduate payloads');
    ok(`lead-level rows: ${ugLead.length} (only leads that actually have city/state/grade get one)`);
    for (const a of ugApp) {
      log(`  ${JSON.stringify(a.key)}`);
      for (const [k, v] of Object.entries(a.data)) log(`      ${k.padEnd(52)} ${JSON.stringify(v)}`);
    }
    // A pre-existing row is only a problem if it still points at a LIVE v2 lead.
    // A dangling one is the residue of a hard-deleted lead and the importer re-points it.
    const ugIds = ugLead.map(r => r.v1_lead_id);
    const { rows: ugEx } = await v2.query(`
      select ug.id, ug.lead_id, ug.v1_lead_id,
             (select count(*)::int from v2_leads l where l.id = ug.lead_id) as lead_alive
      from under_graduate ug where ug.v1_lead_id = any($1::int[])`, [ugIds]);
    const dangling = ugEx.filter(r => r.lead_alive === 0);
    const live = ugEx.filter(r => r.lead_alive > 0);
    if (!ugEx.length) ok('no under_graduate row exists yet for any exported lead');
    dangling.forEach(r => ok(`under_graduate #${r.id} (v1 lead ${r.v1_lead_id}) dangles at deleted lead ${r.lead_id} - will be re-pointed, not duplicated`));
    live.forEach(r => bad(`under_graduate #${r.id} (v1 lead ${r.v1_lead_id}) already belongs to LIVE lead ${r.lead_id}`));

    // ---------------------------------------------------------------- G2. Stream F backfill
    hr('G2. Stream F - form backfill for existing v2 applicants');
    {
      const { MAPPED_SFIDS } = require('../lib/appform.cjs');
      const bf = readNd(path.join(DIR, 'under_graduate_backfill.ndjson'));
      ok(`backfill rows in payload: ${bf.length}`);

      // 1. COMPLETENESS, re-derived from the v1 side (the exporter starts from v2)
      const { rows: apps } = await v1.query(`
        select ml.id v1_lead, ml."applicationManagerId" am
        from "manageLeads" ml join "ApplicationManager" a on a.id = ml."applicationManagerId"
        where ml."applicationFormId" = any($1::int[])`, [M.V1_FORMS]);
      const { rows: v2l } = await v2.query(`
        select id, v1_lead_id, v1_application_id from v2_leads
        where v1_lead_id = any($1::int[]) and is_deleted = false and org_id = $2 and school_id = $3`,
        [apps.map(a => a.v1_lead), M.ORG_V2, M.SCHOOL_V2]);
      const v2ByV1 = new Map(v2l.map(r => [Number(r.v1_lead_id), r]));
      const cand = apps.filter(a => { const t = v2ByV1.get(a.v1_lead); return t && Number(t.v1_application_id) === a.am; });
      const candLeadIds = cand.map(a => Number(v2ByV1.get(a.v1_lead).id));
      const { rows: hasUg } = await v2.query(
        'select lead_id, v1_lead_id from under_graduate where lead_id = any($1::bigint[]) or v1_lead_id = any($2::int[])',
        [candLeadIds, cand.map(a => a.v1_lead)]);
      const ugLeadSet = new Set(hasUg.map(r => Number(r.lead_id)));
      const ugV1Set = new Set(hasUg.map(r => Number(r.v1_lead_id)));
      const noRow = cand.filter(a => !ugLeadSet.has(Number(v2ByV1.get(a.v1_lead).id)) && !ugV1Set.has(a.v1_lead));
      const expected = [];
      for (const a of noRow) {
        const { rows: r } = await v1.query(
          `select distinct "sectionFieldId" sf from "ApplicationResponses"
            where "applicationManagerId" = $1 and ((value is not null and btrim(value) <> '') or "dynamicTableData" is not null)`, [a.am]);
        if (r.some(x => MAPPED_SFIDS.has(Number(x.sf)))) expected.push(Number(v2ByV1.get(a.v1_lead).id));
      }
      const got = new Set(bf.map(b => b.v2_lead_id));
      const missed = expected.filter(id => !got.has(id));
      const extra = [...got].filter(id => !expected.includes(id));
      if (missed.length) bad(`Stream F misses ${missed.length} applicant(s) that need a form row: ${missed}`);
      if (extra.length) bad(`Stream F includes ${extra.length} lead(s) the v1-side derivation does not: ${extra}`);
      if (!missed.length && !extra.length) ok(`set equality: the v1-side derivation finds exactly the same ${expected.length} lead(s)`);

      // 2. every target lead is live, in scope, and STILL has no form row
      if (bf.length) {
        const { rows: tl } = await v2.query(`
          select l.id, l.is_deleted, l.org_id, l.school_id, l.form_id, l.v1_lead_id, l.v1_application_id,
                 (select count(*)::int from under_graduate u where u.lead_id = l.id) ug
          from v2_leads l where l.id = any($1::bigint[])`, [bf.map(b => b.v2_lead_id)]);
        const tBy = new Map(tl.map(r => [Number(r.id), r]));
        let scopeBad = 0;
        for (const b of bf) {
          const t = tBy.get(b.v2_lead_id);
          if (!t) { bad(`backfill lead ${b.v2_lead_id} does not exist`); scopeBad++; continue; }
          if (t.is_deleted) { bad(`backfill lead ${b.v2_lead_id} is deleted`); scopeBad++; }
          if (Number(t.org_id) !== M.ORG_V2 || Number(t.school_id) !== M.SCHOOL_V2 || !M.V2_FORMS.includes(Number(t.form_id))) {
            bad(`backfill lead ${b.v2_lead_id} is outside org ${M.ORG_V2}/school ${M.SCHOOL_V2}/forms ${M.V2_FORMS}`); scopeBad++;
          }
          if (Number(t.v1_lead_id) !== b.v1_lead_id || Number(t.v1_application_id) !== b.v1_application_id) {
            bad(`backfill lead ${b.v2_lead_id} provenance mismatch`); scopeBad++;
          }
          if (t.ug > 0) { bad(`backfill lead ${b.v2_lead_id} already has a form row`); scopeBad++; }
        }
        if (!scopeBad) ok(`all ${bf.length} target leads: live, org ${M.ORG_V2}, school ${M.SCHOOL_V2}, forms 104/105, provenance matches, no form row yet`);

        // 3. disjoint from every other stream
        const other = new Set([...leads.map(l => l.v1_lead_id), ...promotions.map(p => p.v1_lead_id)]);
        const ov = bf.filter(b => other.has(b.v1_lead_id));
        if (ov.length) bad(`backfill overlaps another stream: ${ov.map(b => b.v1_lead_id)}`);
        else ok('disjoint from the new-lead and promotion streams');

        // 4. every column exists on under_graduate
        const { rows: ugc } = await v2.query(
          `select column_name, data_type from information_schema.columns where table_name = 'under_graduate'`);
        const ugType = new Map(ugc.map(r => [r.column_name, r.data_type]));
        const badCols = [...new Set(bf.flatMap(b => Object.keys(b.data)))].filter(c => !ugType.has(c));
        if (badCols.length) bad(`backfill writes columns that do not exist on under_graduate: ${badCols}`);
        else ok('every backfill column exists on under_graduate');

        // 5. VALUE FIDELITY - every string value must be traceable to that
        //    application's raw v1 answers (value, file name or table cell)
        let checked = 0, traced = 0, boolsOk = 0;
        const untraced = [];
        for (const b of bf) {
          const { rows: raw } = await v1.query(
            `select value, "fileName", "dynamicTableData" dt from "ApplicationResponses" where "applicationManagerId" = $1`,
            [b.v1_application_id]);
          const pool = new Set();
          for (const r of raw) {
            if (r.value !== null) pool.add(String(r.value).trim());
            if (r.fileName) pool.add(String(r.fileName));
            for (const c of (r.dt && r.dt.rowsCellsData) || []) if (c && c.value != null) pool.add(String(c.value).trim());
          }
          for (const [col, v] of Object.entries(b.data)) {
            if (typeof v === 'boolean') {
              if (ugType.get(col) === 'boolean') boolsOk++; else untraced.push(`${b.v2_lead_id}.${col} boolean into ${ugType.get(col)}`);
              continue;
            }
            checked++;
            const sv = String(v);
            const ok1 = pool.has(sv)
              || sv.split(', ').every(part => pool.has(part))
              || (/-01$/.test(sv) && pool.has(sv.slice(0, -3)));
            if (ok1) traced++; else untraced.push(`${b.v2_lead_id}.${col} = ${JSON.stringify(sv).slice(0, 60)}`);
          }
        }
        if (untraced.length) untraced.forEach(u => bad(`backfill value not traceable to v1: ${u}`));
        else ok(`value fidelity: ${traced}/${checked} values traced to the raw v1 answers, ${boolsOk} booleans into boolean columns`);
      }
    }

    // ---------------------------------------------------------------- H. NOT NULL / FK sanity
    hr('H. column and FK sanity against the live schema');
    const { rows: cols } = await v2.query(
      `select column_name from information_schema.columns where table_schema='public' and table_name='v2_leads'`);
    const known2 = new Set(cols.map(r => r.column_name));
    const unknownCols = Object.keys(leads[0] || {}).filter(c => c !== '_v1' && !known2.has(c));
    if (unknownCols.length) bad(`leads.ndjson has columns that do not exist on v2_leads: ${unknownCols}`);
    else ok('every column in leads.ndjson exists on v2_leads');

    for (const [label, ids, table] of [
      ['counsellor_id', [...new Set(leads.map(l => l.counsellor_id).filter(Boolean))], 'users'],
      ['reassigned_by', [...new Set(leads.map(l => l.reassigned_by).filter(Boolean))], 'users'],
      ['lead_stage_id', [...new Set(leads.map(l => l.lead_stage_id).filter(Boolean))], 'leadStage'],
      ['lead_sub_stage_id', [...new Set(leads.map(l => l.lead_sub_stage_id).filter(Boolean))], 'leadSubStage'],
      ['batch_id', [...new Set(leads.map(l => l.batch_id).filter(Boolean))], 'batches'],
      ['round_id', [...new Set(leads.map(l => l.round_id).filter(Boolean))], 'rounds'],
    ]) {
      if (!ids.length) continue;
      const { rows } = await v2.query(`select id from "${table}" where id = any($1::int[])`, [ids]);
      const found = new Set(rows.map(r => r.id));
      const miss = ids.filter(i => !found.has(i));
      if (miss.length) bad(`${label}: ids not present in ${table}: ${miss}`);
      else ok(`${label}: all ${ids.length} id(s) exist in ${table}`);
    }

    hr(problems.length ? `VERIFY FINISHED - ${problems.length} PROBLEM(S)` : 'VERIFY FINISHED - NO PROBLEMS');
    problems.forEach(p => log('  - ' + p));
    if (problems.length) process.exitCode = 1;
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('\nVERIFY FAILED:', e.message); console.error(e.stack); process.exit(1); });
