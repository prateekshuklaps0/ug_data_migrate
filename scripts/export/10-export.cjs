/**
 * STEP 1 of 2 - EXPORT.  READ-ONLY on both databases.
 *
 * Reads v1, resolves every mapping against the live v2 database, and writes
 * fully-formed v2 rows to files under data/export/<runId>/.  Nothing is written
 * to any database by this script - both sessions are opened read-only.
 *
 * Scope (confirmed by the user 2026-09-22):
 *   A  v1 manageLeads on forms 100/109 with no v2_leads row     -> insert
 *   B  their UserTimelines / Notes / tags / under_graduate rows  -> insert
 *   C  the applications that have a manageLeads row              -> insert or promote
 *   held back: leads whose email/mobile already exists in v2 on the same form
 *
 * Usage:  node scripts/export/10-export.cjs
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connect } = require('../lib/db.cjs');
const { Progress } = require('../lib/progress.cjs');
const M = require('../lib/maps.cjs');

const REPOS = 'C:/Users/Prateek/Desktop/Repos';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(REPOS, 'data', 'export', RUN_ID);

const log = (...a) => console.log(...a);
const hr = (t) => log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78));

const stripPlus = v => v === null || v === undefined ? null : (String(v).replace(/^\+/, '').trim() || null);
const trimOrNull = v => { if (v === null || v === undefined) return null; const s = String(v).trim(); return s === '' ? null : s; };

function writeNdjson(file, rows) {
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function writeCsv(file, rows, cols) {
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = v instanceof Date ? v.toISOString()
      : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  fs.writeFileSync(file, [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n');
}

/** Build under_graduate column values from v1 ApplicationResponses for each application. */
async function buildApplicantUnderGraduate(v1, amIds) {
  const out = new Map();
  if (!amIds.length) return out;
  const { rows } = await v1.query(`
    select ar."applicationManagerId" am, ar."sectionFieldId" sfid, sf.label, sf.type,
           ar.value, ar."fileName", ar."dynamicTableData" dt
    from "ApplicationResponses" ar left join sectionfields sf on sf.id = ar."sectionFieldId"
    where ar."applicationManagerId" = any($1::int[]) order by ar."applicationManagerId", ar.id`, [amIds]);

  // sectionFieldId -> under_graduate column. Derived empirically; see 02-field-mappings.md.
  const SCALAR = {
    3414: 'country_of_birth', 4707: 'country_of_birth',
    3415: 'gender', 4708: 'gender',
    3417: 'alternate_phone_number', 5295: 'alternate_phone_number',
    3421: 'where_did_you_hear_about_masters_union', 4713: 'where_did_you_hear_about_masters_union',
    3422: 'head_about_mu_other',
    3423: 'do_you_have_any_physical_disabilities', 4715: 'do_you_have_any_physical_disabilities',
    3424: 'type_of_disability', 4716: 'type_of_disability',
    3504: 'parent_name', 4880: 'parent_name',
    3505: 'parent_number', 4881: 'parent_number',
    3506: 'parent_email_address', 4882: 'parent_email_address',
    3508: 'select_country', 4884: 'select_country',
    3509: 'select_state', 4885: 'select_state',
    3510: 'district',
    3511: 'select_city', 4887: 'select_city',
    3512: 'address_line_1', 4888: 'address_line_1',
    3513: 'address_line_2', 4889: 'address_line_2',
    3514: 'pincode', 4890: 'pincode',
    3517: 'select_permanent_country', 3518: 'select_permanent_state', 3519: 'permanent_district',
    3520: 'select_permanent_city', 3521: 'permanent_address_line_1', 3522: 'permanent_address_line_2',
    3523: 'permanent_pincode', 4896: 'permanent_address_line_1', 4898: 'permanent_pincode',
    4709: 'please_specify_your_school',
    4878: 'state', 5033: 'state',
    4879: 'city', 5035: 'city',
    5076: 'school_branch', 5077: 'school_branch',
    6396: 'discover_us_specific_channel_or_person', 6397: 'discover_us_specific_channel_or_person',
    7689: 'top_5_things', 7690: 'top_5_things',
    11252: 'school_name',
  };
  const DATE = { 3413: 'date_of_birth', 4706: 'date_of_birth', 4575: 'declaration_date', 5291: 'declaration_date' };
  const BOOL_YESNO = {
    3516: 'is_the_above_address_same_as_your_permanent_address',
    4891: 'is_the_above_address_same_as_your_permanent_address',
    4565: 'are_your_grade_12th_results_out', 11241: 'are_your_grade_12th_results_out',
    10256: 'has_foreign_university_admit_or_studying_abroad',
    10259: 'has_foreign_university_admit_or_studying_abroad',
  };
  const BOTH = { 5279: ['grade', 'professional_qualification'], 5280: ['grade', 'professional_qualification'] };
  const MULTI = { 4570: 'your_preferred_course_at_masters_union', 5038: 'your_preferred_course_at_masters_union' };
  const FILE = {
    4564: ['upload_your_class_10th_marksheet', 'upload_your_class_10th_marksheet_name'],
    11240: ['upload_your_class_10th_marksheet', 'upload_your_class_10th_marksheet_name'],
    4568: ['upload_your_class_12th_marksheet', 'upload_your_class_12th_marksheet_name'],
    5063: ['upload_sat_result_documents', 'upload_sat_result_documents_name'],
    10285: ['upload_sat_result_documents', 'upload_sat_result_documents_name'],
    5067: ['upload_cuet_result_documents', 'upload_cuet_result_documents_name'],
    10289: ['upload_cuet_result_documents', 'upload_cuet_result_documents_name'],
    5069: ['academic_upload_jee_result_documents', 'academic_upload_jee_result_documents_name'],
  };
  const EXAM_CHECKBOX = { 10283: true, 3543: true };
  const EXAM_COL = {
    SAT: 'academic_sat_checkbox', CUET: 'academic_cuet_checkbox', JEE: 'academic_jee_checkbox',
    ACT: 'academic_act_checkbox', 'IPMAT/JIPMAT': 'academic_ipmat_jipmat_checkbox',
  };
  const CLASS10_TABLE = { 4562: true, 11239: true };
  const DECL = { 4576: 'declaration_checkbox1', 5292: 'declaration_checkbox1', 11268: 'declaration_checkbox2' };
  const C10 = ['class_10th_board', 'class_10th_school_name', 'class_10th_month_and_year_of_passing',
    'class_10th_marking_scheme', 'class_10th_percentage_cgpa_grades'];

  const unknown = new Map();
  const multiBuf = new Map();
  for (const r of rows) {
    if (!out.has(r.am)) out.set(r.am, {});
    const o = out.get(r.am);
    const val = r.value === null ? null : String(r.value).trim();

    if (SCALAR[r.sfid]) { if (val) o[SCALAR[r.sfid]] = val; continue; }
    if (DATE[r.sfid]) { if (val && /^\d{4}-\d{2}-\d{2}$/.test(val)) o[DATE[r.sfid]] = val; continue; }
    if (BOOL_YESNO[r.sfid]) { if (val) o[BOOL_YESNO[r.sfid]] = /^yes$/i.test(val); continue; }
    if (BOTH[r.sfid]) { if (val) for (const c of BOTH[r.sfid]) o[c] = val; continue; }
    if (DECL[r.sfid]) { if (val) o[DECL[r.sfid]] = true; continue; }
    if (MULTI[r.sfid]) {
      if (val) { const k = `${r.am}|${MULTI[r.sfid]}`; if (!multiBuf.has(k)) multiBuf.set(k, []); multiBuf.get(k).push(val); }
      continue;
    }
    if (FILE[r.sfid]) { const [u, n] = FILE[r.sfid]; if (val) o[u] = val; if (r.fileName) o[n] = r.fileName; continue; }
    if (EXAM_CHECKBOX[r.sfid]) { if (val && EXAM_COL[val]) o[EXAM_COL[val]] = true; continue; }
    if (CLASS10_TABLE[r.sfid]) {
      const cells = (r.dt && r.dt.rowsCellsData ? r.dt.rowsCellsData : []).map(c => c.value);
      cells.forEach((v, i) => {
        if (v === null || v === undefined || String(v).trim() === '' || !C10[i]) return;
        let s = String(v).trim();
        if (C10[i] === 'class_10th_month_and_year_of_passing' && /^\d{4}-\d{2}$/.test(s)) s += '-01';
        o[C10[i]] = s;
      });
      continue;
    }
    // Anything else is a field the previous migration also had no column for
    // (name / email / phone live on v2_leads; consent checkboxes are not stored).
    const k = `${r.sfid} ${r.label || ''}`;
    unknown.set(k, (unknown.get(k) || 0) + 1);
  }
  for (const [k, vals] of multiBuf) {
    const i = k.indexOf('|');
    out.get(Number(k.slice(0, i)))[k.slice(i + 1)] = vals.join(', ');
  }
  out._unknown = unknown;
  return out;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  hr(`UG v1 -> v2 EXPORT   run ${RUN_ID}`);
  log(`output: ${OUT}\n`);

  const v1 = await connect('v1', { readOnly: true });
  const v2 = await connect('v2', { readOnly: true });
  const warnings = [];
  const warn = m => { warnings.push(m); log('  !  ' + m); };

  try {
    const { rows: ro } = await v1.query('show default_transaction_read_only');
    if (ro[0].default_transaction_read_only !== 'on') throw new Error('v1 session is not read-only - aborting');
    log('v1 session read-only: on');
    log('v2 session read-only: on (export writes no database rows)');

    // ------------------------------------------------------------ 1. entities
    hr('1. entity check');
    const { rows: ent } = await v2.query(`
      select f.id form_id, f.title, f."programId", f."schoolId", f."organizationId",
             p.name program, s.name school
      from "applicationForms" f
      join programs p on p.id = f."programId"
      join schools s on s.id = f."schoolId"
      where f.id = any($1::int[])`, [M.V2_FORMS]);
    for (const r of ent) {
      log(`  v2 form ${r.form_id}  program ${r.programId} "${r.program}"  school ${r.schoolId} "${r.school}"  org ${r.organizationId}`);
      if (r.organizationId !== M.ORG_V2 || r.schoolId !== M.SCHOOL_V2) {
        throw new Error(`form ${r.form_id} is not in org ${M.ORG_V2}/school ${M.SCHOOL_V2}`);
      }
    }
    for (const [v1f, t] of Object.entries(M.FORM_MAP)) {
      const e = ent.find(x => x.form_id === t.form_id);
      if (!e || e.programId !== t.program_id) throw new Error(`FORM_MAP is wrong for v1 form ${v1f}`);
    }
    const { rows: olt } = await v2.query(
      'select id, table_name from org_lead_tables where org_id=$1 and school_id=$2 and is_active', [M.ORG_V2, M.SCHOOL_V2]);
    if (olt.length !== 1 || olt[0].id !== M.LEAD_TABLE_ID || olt[0].table_name !== 'under_graduate') {
      throw new Error(`org_lead_tables mismatch: ${JSON.stringify(olt)}`);
    }
    log(`  org_lead_tables ${olt[0].id} -> ${olt[0].table_name}  OK`);

    // ------------------------------------------------------------ 2. maps
    hr('2. building maps from live data');
    const { stage, subStage, appStage, appSubStage } = await M.buildStageMaps(v1, v2);
    log(`  lead stage map          : ${stage.size} entries`);
    log(`  lead sub-stage map      : ${subStage.size} entries`);
    log(`  application stage map   : ${appStage.size} entries`);
    log(`  application sub-stage   : ${appSubStage.size} entries`);
    const { map: counsellorMap, evidence: counsellorEvidence } = await M.buildCounsellorMap(v1, v2);
    log(`  counsellor map     : ${counsellorMap.size} entries (from observed migrated rows)`);

    // ------------------------------------------------------------ 3. gap
    hr('3. recomputing the gap against live data');
    const { rows: allV1 } = await v1.query(
      'select id from "manageLeads" where "applicationFormId" = any($1::int[])', [M.V1_FORMS]);
    log(`  v1 UG manageLeads : ${allV1.length}`);
    const allIds = allV1.map(r => r.id);
    const present = new Set();
    for (let i = 0; i < allIds.length; i += 20000) {
      const { rows } = await v2.query(
        'select v1_lead_id from v2_leads where v1_lead_id = any($1::int[])', [allIds.slice(i, i + 20000)]);
      rows.forEach(r => present.add(r.v1_lead_id));
    }
    log(`  already in v2     : ${present.size}`);
    const missingIds = allIds.filter(id => !present.has(id));
    log(`  MISSING           : ${missingIds.length}`);

    const { rows: leads } = missingIds.length
      ? await v1.query('select * from "manageLeads" where id = any($1::int[]) order by "createdAt"', [missingIds])
      : { rows: [] };

    // ------------------------------------------------------------ 4. hold-back
    hr('4. duplicate-collision check (held back for manual review)');
    const emails = [...new Set(leads.map(r => (r.registeredEmail || '').toLowerCase().trim()).filter(e => e && e !== 'na'))];
    const mobiles = [...new Set(leads.map(r => trimOrNull(r.registeredMobile)).filter(m => m && m.toUpperCase() !== 'NA'))];
    const { rows: exE } = emails.length ? await v2.query(`
      select id, form_id, lower(registered_email) e, registered_name, type, v1_lead_id
      from v2_leads where org_id=$1 and school_id=$2 and is_deleted=false
        and lower(registered_email) = any($3::text[])`, [M.ORG_V2, M.SCHOOL_V2, emails]) : { rows: [] };
    const { rows: exM } = mobiles.length ? await v2.query(`
      select id, form_id, registered_mobile m, registered_name, type, v1_lead_id
      from v2_leads where org_id=$1 and school_id=$2 and is_deleted=false
        and registered_mobile = any($3::text[])`, [M.ORG_V2, M.SCHOOL_V2, mobiles]) : { rows: [] };
    const eKey = new Map(), mKey = new Map();
    exE.forEach(r => { const k = `${r.e}|${r.form_id}`; if (!eKey.has(k)) eKey.set(k, []); eKey.get(k).push(r); });
    exM.forEach(r => { const k = `${r.m}|${r.form_id}`; if (!mKey.has(k)) mKey.set(k, []); mKey.get(k).push(r); });

    const heldBack = [], toImport = [];
    for (const l of leads) {
      const tgt = M.FORM_MAP[l.applicationFormId];
      const em = (l.registeredEmail || '').toLowerCase().trim();
      const mo = trimOrNull(l.registeredMobile);
      const hitE = em && em !== 'na' ? (eKey.get(`${em}|${tgt.form_id}`) || []) : [];
      const hitM = mo && mo.toUpperCase() !== 'NA' ? (mKey.get(`${mo}|${tgt.form_id}`) || []) : [];
      const hits = [...hitE, ...hitM].filter((v, i, a) => a.findIndex(x => x.id === v.id) === i);
      if (hits.length) {
        heldBack.push({
          v1_lead_id: l.id, v1_form: l.applicationFormId, v2_form: tgt.form_id,
          name: l.registeredName, email: l.registeredEmail, mobile: l.registeredMobile,
          source: l.source, created_at: l.createdAt,
          collides_with: hits.map(h => `v2#${h.id}(${h.type},${h.v1_lead_id ? 'v1#' + h.v1_lead_id : 'native'}) ${h.registered_name}`).join(' ; '),
          same_person_likely: hits.some(h => (h.registered_name || '').trim().toLowerCase() === (l.registeredName || '').trim().toLowerCase())
            ? 'YES' : 'no - shared contact only',
        });
      } else toImport.push(l);
    }
    log(`  held back : ${heldBack.length}`);
    log(`  to import : ${toImport.length}`);
    heldBack.forEach(h => log(`    v1#${h.v1_lead_id} ${h.name} <${h.email}> ${h.mobile} -> ${h.collides_with}  [same person: ${h.same_person_likely}]`));

    // ------------------------------------------------------------ 5. applications
    hr('5. Stream C - applications');
    const amIdsNew = [...new Set(toImport.map(l => l.applicationManagerId).filter(Boolean))];
    const { rows: v2NoApp } = await v2.query(`
      select id v2_id, v1_lead_id, type from v2_leads
      where org_id=$1 and school_id=$2 and v1_application_id is null and v1_lead_id is not null`, [M.ORG_V2, M.SCHOOL_V2]);
    const convById = new Map(v2NoApp.map(r => [r.v1_lead_id, r]));
    const { rows: mlWithApp } = await v1.query(`
      select id, "applicationManagerId" from "manageLeads"
      where "applicationFormId" = any($1::int[]) and "applicationManagerId" is not null`, [M.V1_FORMS]);
    const { rows: v2HasApp } = await v2.query('select v1_application_id from v2_leads where v1_application_id is not null');
    const haveApp = new Set(v2HasApp.map(r => r.v1_application_id));
    const promotions = mlWithApp.filter(r => !haveApp.has(r.applicationManagerId) && convById.has(r.id));
    log(`  new applicant rows (lead also missing) : ${amIdsNew.length} ${JSON.stringify(amIdsNew)}`);
    log(`  promotions of an EXISTING v2 lead      : ${promotions.length} ${JSON.stringify(promotions.map(p => ({ v2: convById.get(p.id).v2_id, v1_lead: p.id, v1_app: p.applicationManagerId })))}`);

    const allAmIds = [...new Set([...amIdsNew, ...promotions.map(p => p.applicationManagerId)])];
    const { rows: ams } = allAmIds.length
      ? await v1.query('select * from "ApplicationManager" where id = any($1::int[])', [allAmIds]) : { rows: [] };
    const amBy = new Map(ams.map(r => [r.id, r]));

    const studentV1Ids = [...new Set(ams.map(r => r.userId).filter(Boolean))];
    const { rows: existingStudents } = studentV1Ids.length
      ? await v2.query('select id, v1_id, email from users where v1_id = any($1::int[])', [studentV1Ids]) : { rows: [] };
    const haveStudent = new Set(existingStudents.map(r => r.v1_id));
    const needStudents = studentV1Ids.filter(id => !haveStudent.has(id));
    const { rows: v1Students } = needStudents.length
      ? await v1.query('select * from users where id = any($1::int[])', [needStudents]) : { rows: [] };
    log(`  student users to create in v2          : ${v1Students.length} ${JSON.stringify(v1Students.map(u => `${u.id} ${u.email}`))}`);
    if (v1Students.length) {
      const { rows: clash } = await v2.query(
        'select id, email, role, v1_id from users where lower(email) = any($1::text[])',
        [v1Students.map(u => (u.email || '').toLowerCase())]);
      if (clash.length) warn(`student email already present in v2: ${JSON.stringify(clash)} - the importer REUSES these rows rather than creating duplicates`);
    }

    // ------------------------------------------------------------ 6. build v2_leads
    hr('6. building v2 rows');
    const outLeads = [], outUg = [], outTags = [];
    const stageMiss = new Set(), subMiss = new Set(), counsellorMiss = new Set();
    const unmappedEvents = new Map();

    const p1 = new Progress(toImport.length || 1, 'v2_leads');
    for (const l of toImport) {
      const tgt = M.FORM_MAP[l.applicationFormId];
      const am = l.applicationManagerId ? amBy.get(l.applicationManagerId) : null;
      const isApplicant = !!am;

      if (l.leadStageId != null && !stage.has(l.leadStageId)) stageMiss.add(l.leadStageId);
      if (l.leadSubStageId != null && !subStage.has(l.leadSubStageId)) subMiss.add(l.leadSubStageId);
      if (l.assignTo && !counsellorMap.has(l.assignTo)) counsellorMiss.add(l.assignTo);
      if (l.previousLeadStage != null && !stage.has(l.previousLeadStage)) {
        warn(`v1 lead ${l.id}: previousLeadStage ${l.previousLeadStage} has no UG equivalent (it belongs to another school) - writing NULL`);
      }

      const row = {
        org_id: M.ORG_V2, school_id: M.SCHOOL_V2,
        program_id: tgt.program_id, batch_id: tgt.batch_id, round_id: tgt.round_id, form_id: tgt.form_id,
        lead_table_id: M.LEAD_TABLE_ID,
        user_id: null,
        registered_name: l.registeredName,
        registered_email: l.registeredEmail,
        registered_mobile: l.registeredMobile,
        country_code: stripPlus(l.countryCode),
        status: 'active',
        lead_score: l.leadScore,
        lead_stage_id: l.leadStageId == null ? null : (stage.get(l.leadStageId) ?? null),
        lead_sub_stage_id: l.leadSubStageId == null ? null : (subStage.get(l.leadSubStageId) ?? null),
        counsellor_id: l.assignTo ? (counsellorMap.get(l.assignTo) ?? null) : null,
        is_mobile_verified: l.isMobileVerified ?? false,
        is_email_verified: l.isEmailVerified ?? false,
        alternate_email: l.alternateEmail,
        alternate_mobile_number: l.alternateMobileNumber,
        source: l.source, medium: l.medium, campaign: l.campaign,
        secondary_source: l.secondarySource, secondary_medium: l.secondaryMedium, secondary_campaign: l.secondaryCampaign,
        tertiary_source: l.tertiarySource, tertiary_medium: l.tertiaryMedium, tertiary_campaign: l.tertiaryCampaign,
        lead_origin: l.leadOrigin, lead_device: l.leadDevice,
        created_at: l.createdAt, updated_at: l.updatedAt,
        is_payment_done: false, payment_status: l.paymentStatus || 'pending', payment_initiated: false,
        payment_mode: null, payment_method: null,
        form_percentage_filled: 0,
        lead_payload: l.leadPayload, registered_on: l.registeredOn,
        city: l.city, state: l.state, iso_code: l.isoCode, lead_country: l.leadCountry,
        program_eligible: l.programEligible,
        previous_lead_stage: l.previousLeadStage == null ? null : (stage.get(l.previousLeadStage) ?? null),
        reassigned_on: l.reassignedOn, reassigned_by: null,
        crisp_chat_link: l.crispChatLink, chat_summary: l.chatSummary,
        is_chatbot_lead: l.isChatbotLead ?? false,
        application_form_initiated: false, application_form_submitted: false,
        application_number: null, application_stage_id: null, application_sub_stage_id: null,
        application_registered_on: null, last_interacted_section: null, form_completion_date: null,
        applicant_status: null,
        is_edit_access_granted: false,
        type: isApplicant ? 'applicant' : 'lead',
        is_deleted: l.isLeadDeleted ?? false,
        source_url: l.sourceUrl,
        lead_type: l.leadType || 'primary',
        is_enrolled: false, final_decision: 'NOT_ELIGIBLE',
        concat_smc: l.concatSMC,
        human_handoff: l.humanHandoff === null || l.humanHandoff === undefined ? null : String(l.humanHandoff),
        v1_lead_id: l.id, v1_application_id: null, v1_user_id: null,
        is_inbound_lead: l.isInboundLead ?? false,
        test_lead: false,
        automation_tags: [],
        _v1: { form: l.applicationFormId, assignTo: l.assignTo, reassignedBy: l.reassignedBy, userId: l.userId },
      };

      if (isApplicant) {
        row.v1_application_id = am.id;
        row.v1_user_id = am.userId;
        row.application_number = am.applicationNum;
        row.application_stage_id = am.applicationStageId == null ? null : (appStage.get(am.applicationStageId) ?? null);
        row.application_sub_stage_id = am.applicationSubStageId == null ? null : (appSubStage.get(am.applicationSubStageId) ?? null);
        if (am.applicationSubStageId != null && !appSubStage.has(am.applicationSubStageId)) {
          warn(`application ${am.id}: applicationSubStageId ${am.applicationSubStageId} has no v2 equivalent - writing NULL`);
        }
        row.application_form_initiated = am.applicationFormInitiated ?? false;
        row.application_form_submitted = am.applicationFormSubmitted ?? false;
        row.application_registered_on = am.registeredOn;
        row.last_interacted_section = am.lastInteractedSection;
        row.form_completion_date = am.formCompletionDate;
        row.form_percentage_filled = (am.applicationStatus === 'untouched' || am.applicationStatus == null)
          ? 0 : (Number(am.applicationStatus) || 0);
        row.payment_status = am.paymentStatus || 'pending';
        row.payment_initiated = am.paymentInitiated ?? false;
        row.payment_method = am.paymentMethod;
        row.is_payment_done = am.paymentStatus === 'completed';
        row.payment_mode = am.paymentStatus === 'completed' ? 'online' : null;
        row.applicant_status = am.applicantStatus;
        row._v1.applicationManagerId = am.id;
        row._v1.studentV1Id = am.userId;
        if (am.applicationStageId != null && !appStage.has(am.applicationStageId)) {
          warn(`application ${am.id}: applicationStageId ${am.applicationStageId} has no v2 equivalent - writing NULL`);
        }
      }
      outLeads.push(row);
      p1.tick();
    }
    p1.done();

    const staffV1 = [...new Set(toImport.map(l => l.reassignedBy).filter(Boolean))];
    const staffMap = await M.buildUserMap(v2, staffV1);
    for (const r of outLeads) {
      if (r._v1.reassignedBy) {
        const u = staffMap.get(r._v1.reassignedBy);
        r.reassigned_by = u ? u.id : null;
        if (!u) warn(`reassignedBy v1 user ${r._v1.reassignedBy} has no v2 user - writing NULL`);
      }
    }

    // ------------------------------------------------------------ 7. under_graduate
    for (const l of toImport) {
      const row = {
        org_id: M.ORG_V2, v1_lead_id: l.id,
        created_at: l.createdAt, updated_at: l.updatedAt,
        city: trimOrNull(l.city), state: trimOrNull(l.state),
        grade: trimOrNull(l.grade),
        professional_qualification: trimOrNull(l.grade),
        country_of_birth: trimOrNull(l.leadCountry),
      };
      const meta = ['org_id', 'v1_lead_id', 'created_at', 'updated_at'];
      if (Object.entries(row).some(([k, v]) => !meta.includes(k) && v !== null)) outUg.push(row);
    }
    log(`  under_graduate rows (lead-level) : ${outUg.length}`);

    // A v1 lead can be missing from v2_leads and yet still own an under_graduate row:
    // the previous migration created both, then the v2_leads row was HARD deleted,
    // leaving the under_graduate row pointing at an id that no longer exists.
    // under_graduate_v1_lead_id_uniq would make a plain insert silently do nothing,
    // so the importer re-points those rows instead. A conflict against a row whose
    // lead_id is still LIVE would mean something we do not understand - fail then.
    const ugConflictIds = outUg.map(r => r.v1_lead_id);
    const { rows: ugPre } = ugConflictIds.length ? await v2.query(`
      select ug.id, ug.lead_id, ug.v1_lead_id,
             (select count(*)::int from v2_leads l where l.id = ug.lead_id) as lead_alive
      from under_graduate ug where ug.v1_lead_id = any($1::int[])`, [ugConflictIds]) : { rows: [] };
    const ugDangling = ugPre.filter(r => r.lead_alive === 0);
    const ugLive = ugPre.filter(r => r.lead_alive > 0);
    if (ugPre.length) {
      log(`  pre-existing under_graduate rows : ${ugPre.length} (${ugDangling.length} dangling, ${ugLive.length} live)`);
      ugDangling.forEach(r => warn(`under_graduate #${r.id} (v1 lead ${r.v1_lead_id}) points at deleted v2 lead ${r.lead_id} - the importer will re-point it to the new row`));
    }

    const appUg = await buildApplicantUnderGraduate(v1, allAmIds);
    const unknownFields = appUg._unknown || new Map();
    log(`  under_graduate rows (applicants) : ${[...appUg.keys()].filter(k => typeof k === 'number').length}`);
    if (unknownFields.size) {
      log('  application fields with no under_graduate column (not stored, as before):');
      for (const [k, n] of unknownFields) log(`    ${k}  x${n}`);
    }

    // ------------------------------------------------------------ 8. timelines / notes / tags
    hr('7. timelines / notes / tags');
    const importIds = toImport.map(l => l.id);
    const { rows: tls } = importIds.length
      ? await v1.query('select * from "UserTimelines" where "leadId" = any($1::int[]) order by "leadId", "createdAt", id', [importIds])
      : { rows: [] };
    log(`  v1 UserTimelines : ${tls.length}`);

    const tlUserIds = [...new Set(tls.map(r => r.payload && r.payload.userId).filter(x => x != null))];
    const tlUserMap = await M.buildUserMap(v2, tlUserIds);
    const missingTlUsers = tlUserIds.filter(u => !tlUserMap.has(u));
    if (missingTlUsers.length) {
      warn(`timeline authors with no v2 user yet: ${JSON.stringify(missingTlUsers)} - the importer resolves any student it creates, otherwise created_by is NULL`);
    }

    // `timelines` is partitioned by created_at and timelines_pdefault alone is 79 GB,
    // so this lookup MUST carry a created_at bound or Postgres scans every partition.
    // Bounding it to the month range these rows fall in lets the planner prune.
    const tlIds = tls.map(r => r.id);
    let tlClash = 0;
    if (tlIds.length) {
      const times = tls.map(r => new Date(r.createdAt).getTime());
      const lo = new Date(Math.min(...times)); lo.setUTCDate(1); lo.setUTCHours(0, 0, 0, 0);
      const hi = new Date(Math.max(...times)); hi.setUTCMonth(hi.getUTCMonth() + 1, 1); hi.setUTCHours(0, 0, 0, 0);
      log(`  timeline partition window : ${lo.toISOString().slice(0, 10)} .. ${hi.toISOString().slice(0, 10)}`);
      for (let i = 0; i < tlIds.length; i += 5000) {
        const { rows } = await v2.query(
          `select v1_timeline_id from timelines
            where created_at >= $2 and created_at < $3 and v1_timeline_id = any($1::bigint[])`,
          [tlIds.slice(i, i + 5000), lo, hi]);
        tlClash += rows.length;
      }
    }
    if (tlClash) warn(`${tlClash} of these v1 timeline ids already exist in v2.timelines - the importer will skip them`);
    else log('  v1_timeline_id collision check : none');

    const outTl = [];
    const p2 = new Progress(tls.length || 1, 'timelines');
    for (const t of tls) {
      const title = t.eventType && t.eventType.title ? t.eventType.title : null;
      const { event_type, known } = M.toEventType(title);
      if (!known) unmappedEvents.set(title, (unmappedEvents.get(title) || 0) + 1);
      const authorV1 = (t.payload && t.payload.userId != null) ? t.payload.userId : null;
      const author = authorV1 != null ? tlUserMap.get(authorV1) : null;
      if (t.leadStageId != null && !stage.has(t.leadStageId)) stageMiss.add(t.leadStageId);
      outTl.push({
        v1_lead_id: t.leadId,
        v1_timeline_id: t.id,
        event_type, title,
        description: t.message,
        metadata: t.payload,
        lead_stage_id: t.leadStageId == null ? null : (stage.get(t.leadStageId) ?? null),
        template_id: null,
        created_by: author ? author.id : null,
        v1_counsellor_id: authorV1,
        org_id: M.ORG_V2, school_id: M.SCHOOL_V2,
        created_at: t.createdAt, updated_at: t.updatedAt,
        lead_id: null,
        _v1: { authorV1 },
      });
      p2.tick();
    }
    p2.done();
    for (const [title, n] of unmappedEvents) {
      warn(`event title "${title}" (${n} rows) was never produced by the previous migration; falling back to "${M.toEventType(title).event_type}"`);
    }
    // stages seen only inside timelines are informational, not fatal
    const tlOnlyStageMiss = [...stageMiss].filter(s => !toImport.some(l => l.leadStageId === s || l.leadSubStageId === s));

    const { rows: nts } = importIds.length
      ? await v1.query('select * from "Notes" where "leadId" = any($1::int[]) order by "leadId", id', [importIds])
      : { rows: [] };
    const noteUserIds = [...new Set(nts.map(r => r.userId).filter(Boolean))];
    const noteUserMap = await M.buildUserMap(v2, noteUserIds);
    const outNotes = nts.map(n => {
      const u = n.userId ? noteUserMap.get(n.userId) : null;
      if (n.userId && !u) warn(`note ${n.id}: v1 author ${n.userId} has no v2 user - admin_id NULL`);
      return {
        v1_lead_id: n.leadId, v1_note_id: n.id,
        content: (n.message === null || n.message === undefined ? '' : String(n.message)).trim(),
        admin_id: u ? u.id : null, v1_counsellor_id: n.userId,
        org_id: M.ORG_V2, school_id: M.SCHOOL_V2,
        created_at: n.createdAt, updated_at: n.updatedAt,
        visible: true, lead_id: null,
      };
    });
    log(`  notes            : ${outNotes.length}`);

    const tagged = toImport.filter(l => Array.isArray(l.tags) && l.tags.length);
    const tagNames = [...new Set(tagged.flatMap(l => l.tags))];
    const { rows: v2Tags } = tagNames.length
      ? await v2.query('select id, name from tags where org_id=$1 and name = any($2::text[])', [M.ORG_V2, tagNames])
      : { rows: [] };
    const tagBy = new Map(v2Tags.map(r => [r.name, r.id]));
    for (const l of tagged) {
      for (const name of l.tags) {
        const id = tagBy.get(name);
        if (!id) { warn(`tag "${name}" (v1 lead ${l.id}) has no v2 tag in org ${M.ORG_V2} - skipped`); continue; }
        outTags.push({
          v1_lead_id: l.id, tag_id: id, tag_name: name,
          org_id: M.ORG_V2, school_id: M.SCHOOL_V2,
          created_at: l.createdAt, updated_at: l.updatedAt, lead_id: null,
        });
      }
    }
    log(`  lead_tags        : ${outTags.length}`);

    // ------------------------------------------------------------ 9. promotions
    const outPromotions = [];
    for (const p of promotions) {
      const am = amBy.get(p.applicationManagerId);
      const t = convById.get(p.id);
      const { rows: [cur] } = await v2.query('select * from v2_leads where id=$1', [t.v2_id]);
      const keys = ['type', 'v1_application_id', 'v1_user_id', 'application_number', 'application_stage_id', 'application_sub_stage_id',
        'application_form_initiated', 'application_form_submitted', 'application_registered_on',
        'last_interacted_section', 'form_completion_date', 'form_percentage_filled', 'payment_status',
        'payment_initiated', 'payment_method', 'is_payment_done', 'payment_mode', 'applicant_status',
        'user_id', 'updated_at'];
      const after = {
        type: 'applicant',
        v1_application_id: am.id,
        v1_user_id: am.userId,
        application_number: am.applicationNum,
        application_stage_id: am.applicationStageId == null ? null : (appStage.get(am.applicationStageId) ?? null),
        application_sub_stage_id: am.applicationSubStageId == null ? null : (appSubStage.get(am.applicationSubStageId) ?? null),
        application_form_initiated: am.applicationFormInitiated ?? false,
        application_form_submitted: am.applicationFormSubmitted ?? false,
        application_registered_on: am.registeredOn,
        last_interacted_section: am.lastInteractedSection,
        form_completion_date: am.formCompletionDate,
        form_percentage_filled: (am.applicationStatus === 'untouched' || am.applicationStatus == null)
          ? 0 : (Number(am.applicationStatus) || 0),
        payment_status: am.paymentStatus || 'pending',
        payment_initiated: am.paymentInitiated ?? false,
        payment_method: am.paymentMethod,
        is_payment_done: am.paymentStatus === 'completed',
        payment_mode: am.paymentStatus === 'completed' ? 'online' : null,
        applicant_status: am.applicantStatus,
        user_id: null,
        updated_at: am.updatedAt,
      };
      const before = {};
      for (const k of keys) before[k] = cur[k];
      outPromotions.push({
        v2_lead_id: t.v2_id, v1_lead_id: p.id, v1_application_id: am.id,
        registered_name: cur.registered_name, registered_email: cur.registered_email,
        before, after,
        _v1: { studentV1Id: am.userId, applicationManagerId: am.id },
      });
    }
    log(`  promotions       : ${outPromotions.length}`);

    // Student rows mirror what the previous migration wrote, verified against 40
    // already-migrated students: password, email, name, phone and timezone are
    // copied verbatim; country_code loses its '+'; user_type becomes the v2 label.
    // ---------------------------------------------------------------- 8b. activity trackers
    // v2 "ApplicationActivityTrackers" is a straight column-for-column copy of v1
    // "applicationActivityTracker" (verified identical on 2,291 of 2,291 rows that
    // have not been touched since migration). It carries one row per LEAD, not per
    // application, and 64,562 of the 70,769 UG leads already in v2 have one.
    // The v1 tetr* and offerLetterStatus columns have no v2 destination and are dropped.
    const TRACKER_COLS = ['applicationForm_start_date', 'payment_Initiated_date', 'payment_last_Initiated_date',
      'counsellor_first_activity_date', 'counsellor_last_activity_date', 'application_fee_paidOn',
      'application_last_activity_date', 'lastLeadStageUpdated', 'firstLeadStageUpdated',
      'applicationFormSubmittedOn', 'createdAt', 'updatedAt'];
    const { rows: trkRows } = importIds.length
      ? await v1.query('select * from "applicationActivityTracker" where "leadId" = any($1::int[]) order by "leadId", id', [importIds])
      : { rows: [] };
    const trkByLead = new Map();
    for (const r of trkRows) {
      // v1 can hold more than one row per lead (505 UG leads do). v2 has a UNIQUE on
      // v1_leadId, so pick one deterministically: the earliest, which is the original.
      const cur = trkByLead.get(r.leadId);
      if (!cur) trkByLead.set(r.leadId, r);
      else {
        if (new Date(r.createdAt) < new Date(cur.createdAt)) trkByLead.set(r.leadId, r);
        warn(`v1 lead ${r.leadId} has more than one applicationActivityTracker row - keeping the earliest (v2 allows one per lead)`);
      }
    }
    const outTrackers = [...trkByLead.values()].map(r => {
      const o = { v1_leadId: r.leadId, v1_applicationId: r.applicationId };
      for (const c of TRACKER_COLS) o[c] = r[c] ?? null;
      return o;
    });
    log(`  activity trackers : ${outTrackers.length} (of ${importIds.length} leads; v1 rows seen: ${trkRows.length})`);
    const noTrk = importIds.filter(i => !trkByLead.has(i));
    if (noTrk.length) log(`    ${noTrk.length} lead(s) have no v1 tracker row and get none in v2`);

    // The promoted lead already HAS a v2 tracker row; it needs refreshing from v1.
    // NOTE: iterate outPromotions, NOT the raw `promotions` list - the raw rows are
    // {id, applicationManagerId} and carry neither v1_lead_id nor v2_lead_id.
    const outTrackerUpdates = [];
    for (const p of outPromotions) {
      const { rows: v1t } = await v1.query(
        'select * from "applicationActivityTracker" where "leadId" = $1 order by "createdAt"', [p.v1_lead_id]);
      const { rows: v2t } = await v2.query(
        'select * from "ApplicationActivityTrackers" where "leadId" = $1', [p.v2_lead_id]);
      if (!v1t.length) continue;
      // match the v1 row the previous migration used, by created_at; else the earliest
      const existing = v2t[0] || null;
      const src = (existing && v1t.find(r => new Date(r.createdAt).getTime() === new Date(existing.createdAt).getTime())) || v1t[0];
      if (v1t.length > 1) {
        warn(`promoted lead ${p.v1_lead_id} has ${v1t.length} v1 tracker rows - using v1 id ${src.id} (matched on createdAt to the existing v2 row)`);
      }
      const after = { v1_applicationId: src.applicationId };
      for (const c of TRACKER_COLS) after[c] = src[c] ?? null;
      outTrackerUpdates.push({
        v2_lead_id: p.v2_lead_id, v1_lead_id: p.v1_lead_id, v1_tracker_id: src.id,
        existing_id: existing ? existing.id : null,
        before: existing ? Object.fromEntries(['v1_applicationId', ...TRACKER_COLS].map(c => [c, existing[c]])) : null,
        after,
      });
    }
    if (outTrackerUpdates.length) log(`  activity tracker updates (promotions): ${outTrackerUpdates.length}`);

    // ---------------------------------------------------------------- 8c. lead score history
    // v2 leadScoreHistory holds 98,833 UG rows with source='v1_history' - the previous
    // migration copied v1 LeadScoreHistories. Every one of 2,832 sampled migrated leads
    // that had v1 history has it in v2, so skipping this would lose real scoring detail.
    // delta and mappingValue are the v1 score; scoreBefore/leadScore are a running total
    // in createdAt order. Idempotency: lead_score_history_lead_dedupe_uidx (leadId, dedupeKey).
    const scoreMaps = await M.buildScoreMaps(v1, v2);
    log(`  score criteria map: ${scoreMaps.criteria.size}, mapping map: ${scoreMaps.mapping.size}, ` +
        `cross-checked on ${scoreMaps.observedRows} migrated rows, disagreements: ${scoreMaps.disagree.length}`);
    scoreMaps.disagree.forEach(d => warn(`score map disagreement: ${d}`));
    const { rows: shSrc } = importIds.length
      ? await v1.query('select * from "LeadScoreHistories" where "leadId" = any($1::int[]) order by "leadId", "createdAt", id', [importIds])
      : { rows: [] };
    const outScoreHistory = [];
    const runTotal = new Map();
    for (const r of shSrc) {
      const before = runTotal.get(r.leadId) || 0;
      const delta = Number(r.score) || 0;
      const after = before + delta;
      runTotal.set(r.leadId, after);
      const cid = scoreMaps.criteria.get(r.criteriaId);
      const mid = scoreMaps.mapping.get(r.mappingId);
      if (cid === undefined) warn(`score history ${r.id}: v1 criteriaId ${r.criteriaId} has no v2 equivalent`);
      if (mid === undefined) warn(`score history ${r.id}: v1 mappingId ${r.mappingId} has no v2 equivalent`);
      outScoreHistory.push({
        v1_lead_id: r.leadId,
        v1_history_id: r.id,
        dedupeKey: `v1_history:${r.id}`,
        criteriaId: cid ?? null,
        mappingId: mid ?? null,
        mappingValue: delta,
        delta,
        scoreBefore: before,
        leadScore: after,
        schoolId: M.SCHOOL_V2,
        source: 'v1_history',
        createdBy: null,
        createdAt: r.createdAt,
        occurredAt: r.createdAt,
        metadata: {
          v1LeadId: r.leadId, v1CreatedBy: r.createdBy, v1HistoryId: r.id,
          v1MappingId: r.mappingId, v1CriteriaId: r.criteriaId, formSectionId: r.formSectionId ?? null,
        },
      });
    }
    log(`  lead score history: ${outScoreHistory.length} row(s) over ${runTotal.size} lead(s)`);
    // the running total must land on the lead_score we are writing to v2_leads
    for (const [v1LeadId, total] of runTotal) {
      const lead = outLeads.find(l => l.v1_lead_id === v1LeadId);
      if (lead && Number(lead.lead_score ?? 0) !== total) {
        warn(`lead ${v1LeadId}: score history sums to ${total} but lead_score is ${lead.lead_score}`);
      }
    }

    const outStudents = v1Students.map(u => ({
      v1_id: u.id, email: u.email, name: u.name, phone: u.mobileNumber,
      password_hash: u.password,
      country_code: stripPlus(u.countryCode), role: 'student', user_type: 'Institute Users',
      organization_id: M.ORG_V2, school_id: M.SCHOOL_V2, status: 'active',
      timezone: u.timezone, image: u.image, login_count: 0,
      created_at: u.createdAt, updated_at: u.updatedAt,
    }));
    for (const s of outStudents) {
      if (!s.password_hash) warn(`student v1#${s.v1_id} has no password hash in v1 - users.password_hash is NOT NULL, the importer will refuse`);
      if (!s.email) warn(`student v1#${s.v1_id} has no email - users.email is NOT NULL, the importer will refuse`);
    }

    const outAppUg = [];
    for (const r of outLeads) {
      if (!r._v1.applicationManagerId) continue;
      const d = appUg.get(r._v1.applicationManagerId);
      if (d && Object.keys(d).length) outAppUg.push({ key: { v1_lead_id: r.v1_lead_id }, data: d });
    }
    for (const p of outPromotions) {
      const d = appUg.get(p.v1_application_id);
      if (d && Object.keys(d).length) outAppUg.push({ key: { v2_lead_id: p.v2_lead_id, v1_lead_id: p.v1_lead_id }, data: d });
    }

    // ------------------------------------------------------------ 10. assertions
    hr('8. assertions');
    const fail = [];
    const leadStageMiss = [...stageMiss].filter(s => toImport.some(l => l.leadStageId === s));
    if (leadStageMiss.length) fail.push(`lead stages with no v2 equivalent: ${leadStageMiss}`);
    if (subMiss.size) fail.push(`sub-stages with no v2 equivalent: ${[...subMiss]}`);
    if (counsellorMiss.size) fail.push(`assignTo uuids with no counsellor mapping: ${[...counsellorMiss]}`);
    const noCounsellor = outLeads.filter(r => r._v1.assignTo && r.counsellor_id === null);
    if (noCounsellor.length) fail.push(`${noCounsellor.length} leads have assignTo but no counsellor_id`);
    const badForm = outLeads.filter(r => !M.V2_FORMS.includes(r.form_id));
    if (badForm.length) fail.push(`${badForm.length} leads have an unexpected form_id`);
    const seen = new Set(), dupV1 = [];
    for (const r of outLeads) { if (seen.has(r.v1_lead_id)) dupV1.push(r.v1_lead_id); seen.add(r.v1_lead_id); }
    if (dupV1.length) fail.push(`duplicate v1_lead_id in the export: ${dupV1}`);
    const tlDup = new Set(), tlSeen = new Set();
    for (const t of outTl) { if (tlSeen.has(t.v1_timeline_id)) tlDup.add(t.v1_timeline_id); tlSeen.add(t.v1_timeline_id); }
    if (tlDup.size) fail.push(`duplicate v1_timeline_id in the export: ${[...tlDup]}`);
    const orphanTl = outTl.filter(t => !seen.has(t.v1_lead_id));
    if (orphanTl.length) fail.push(`${orphanTl.length} timelines reference a lead that is not being imported`);
    const orphanNote = outNotes.filter(n => !seen.has(n.v1_lead_id));
    if (orphanNote.length) fail.push(`${orphanNote.length} notes reference a lead that is not being imported`);
    // notes.admin_id and notes.content are NOT NULL in v2 - catch it here, not at INSERT.
    const noteNoAdmin = outNotes.filter(n => n.admin_id === null);
    if (noteNoAdmin.length) fail.push(`${noteNoAdmin.length} notes have no resolvable v2 author but notes.admin_id is NOT NULL: ${JSON.stringify(noteNoAdmin.map(n => n.v1_note_id))}`);
    const noteNoContent = outNotes.filter(n => !n.content);
    if (noteNoContent.length) fail.push(`${noteNoContent.length} notes have empty content but notes.content is NOT NULL`);
    // users.password_hash / users.email are NOT NULL
    const badStudent = outStudents.filter(s => !s.password_hash || !s.email);
    if (badStudent.length) fail.push(`${badStudent.length} student rows are missing email or password_hash`);
    // Every promotion whose lead has a v1 tracker row MUST produce an update entry.
    // Without this, iterating the wrong array silently exports zero updates.
    for (const p of outPromotions) {
      const { rows: hasTrk } = await v1.query(
        'select count(*)::int n from "applicationActivityTracker" where "leadId" = $1', [p.v1_lead_id]);
      if (hasTrk[0].n > 0 && !outTrackerUpdates.some(u => u.v2_lead_id === p.v2_lead_id)) {
        fail.push(`promotion v2#${p.v2_lead_id} has ${hasTrk[0].n} v1 tracker row(s) but produced no tracker update`);
      }
    }
    const shOrphan = outScoreHistory.filter(r => !seen.has(r.v1_lead_id));
    if (shOrphan.length) fail.push(`${shOrphan.length} score-history rows reference a lead that is not being imported`);
    const shNoMap = outScoreHistory.filter(r => r.criteriaId === null || r.mappingId === null);
    if (shNoMap.length) fail.push(`${shNoMap.length} score-history rows have an unmapped criteria/mapping id`);
    const trkOrphan = outTrackers.filter(t => !seen.has(t.v1_leadId));
    if (trkOrphan.length) fail.push(`${trkOrphan.length} activity trackers reference a lead that is not being imported`);
    const trkSeen = new Set(), trkDup = [];
    for (const t of outTrackers) { if (trkSeen.has(t.v1_leadId)) trkDup.push(t.v1_leadId); trkSeen.add(t.v1_leadId); }
    if (trkDup.length) fail.push(`duplicate v1_leadId in the activity tracker export: ${trkDup}`);
    if (ugLive.length) {
      fail.push(`${ugLive.length} under_graduate row(s) already exist for an exported lead AND point at a LIVE v2 lead: ` +
        JSON.stringify(ugLive.map(r => ({ ug: r.id, v1_lead: r.v1_lead_id, lead_id: r.lead_id }))));
    }

    if (tlOnlyStageMiss.length) warn(`timeline-only stage ids with no UG equivalent (lead_stage_id -> NULL): ${tlOnlyStageMiss}`);
    for (const r of outLeads) if (!r.registered_name) warn(`v1 lead ${r.v1_lead_id} has no registered_name`);
    for (const r of outLeads) if (r.type === 'applicant' && !r.application_number) warn(`applicant v1#${r.v1_lead_id} has no application_number`);

    if (fail.length) { fail.forEach(f => log('  FAIL ' + f)); throw new Error('assertions failed - nothing exported'); }
    log('  all structural assertions passed');
    log(`  stage ids used      : ${JSON.stringify([...new Set(outLeads.map(r => r.lead_stage_id))])}`);
    log(`  counsellor ids used : ${JSON.stringify([...new Set(outLeads.map(r => r.counsellor_id))])}`);
    log(`  form split          : ${JSON.stringify(outLeads.reduce((a, r) => (a[r.form_id] = (a[r.form_id] || 0) + 1, a), {}))}`);
    log(`  type split          : ${JSON.stringify(outLeads.reduce((a, r) => (a[r.type] = (a[r.type] || 0) + 1, a), {}))}`);

    // ------------------------------------------------------------ 11. write
    hr('9. writing files');
    const files = {};
    const put = (name, rows) => {
      const f = path.join(OUT, name);
      writeNdjson(f, rows);
      files[name] = { rows: rows.length, sha256: sha256(f) };
      log(`  ${name.padEnd(30)} ${String(rows.length).padStart(6)} rows`);
    };
    put('leads.ndjson', outLeads);
    put('under_graduate_lead.ndjson', outUg);
    put('under_graduate_applicant.ndjson', outAppUg);
    put('timelines.ndjson', outTl);
    put('notes.ndjson', outNotes);
    put('lead_tags.ndjson', outTags);
    put('students.ndjson', outStudents);
    put('promotions.ndjson', outPromotions);
    put('activity_trackers.ndjson', outTrackers);
    put('activity_tracker_updates.ndjson', outTrackerUpdates);
    put('lead_score_history.ndjson', outScoreHistory);

    const hbCols = ['v1_lead_id', 'v1_form', 'v2_form', 'name', 'email', 'mobile', 'source', 'created_at', 'collides_with', 'same_person_likely'];
    writeCsv(path.join(OUT, 'held_back_for_review.csv'), heldBack, hbCols);
    files['held_back_for_review.csv'] = { rows: heldBack.length, sha256: sha256(path.join(OUT, 'held_back_for_review.csv')) };
    log(`  ${'held_back_for_review.csv'.padEnd(30)} ${String(heldBack.length).padStart(6)} rows`);

    const tlByLead = new Map(), ntByLead = new Map(), tgByLead = new Map();
    outTl.forEach(t => tlByLead.set(t.v1_lead_id, (tlByLead.get(t.v1_lead_id) || 0) + 1));
    outNotes.forEach(n => ntByLead.set(n.v1_lead_id, (ntByLead.get(n.v1_lead_id) || 0) + 1));
    outTags.forEach(t => tgByLead.set(t.v1_lead_id, (tgByLead.get(t.v1_lead_id) || 0) + 1));
    const review = outLeads.map(r => ({
      v1_lead_id: r.v1_lead_id, type: r.type, v2_form: r.form_id, program_id: r.program_id,
      name: r.registered_name, email: r.registered_email, mobile: r.registered_mobile, country_code: r.country_code,
      source: r.source, medium: r.medium, campaign: r.campaign, lead_type: r.lead_type,
      lead_stage_id: r.lead_stage_id, lead_sub_stage_id: r.lead_sub_stage_id,
      counsellor_id: r.counsellor_id, counsellor_v1_uuid: r._v1.assignTo,
      city: r.city, state: r.state, created_at: r.created_at,
      application_number: r.application_number || '', payment_status: r.payment_status,
      timelines: tlByLead.get(r.v1_lead_id) || 0,
      notes: ntByLead.get(r.v1_lead_id) || 0,
      tags: tgByLead.get(r.v1_lead_id) || 0,
    }));
    const revCols = Object.keys(review[0] || { v1_lead_id: '' });
    writeCsv(path.join(OUT, 'review_leads.csv'), review, revCols);
    files['review_leads.csv'] = { rows: review.length, sha256: sha256(path.join(OUT, 'review_leads.csv')) };
    log(`  ${'review_leads.csv'.padEnd(30)} ${String(review.length).padStart(6)} rows`);

    const manifest = {
      runId: RUN_ID,
      generatedAt: new Date().toISOString(),
      scope: 'UG org12/school18 forms 104+105; streams A+B+C',
      source: { db: 'LeadsRDS', forms: M.V1_FORMS },
      target: { db: 'anandi', org: M.ORG_V2, school: M.SCHOOL_V2, forms: M.V2_FORMS },
      gap: {
        v1Total: allV1.length, alreadyInV2: present.size, missing: missingIds.length,
        heldBack: heldBack.length, exported: toImport.length,
      },
      counts: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.rows])),
      files,
      maps: {
        formMap: M.FORM_MAP,
        leadStage: Object.fromEntries(stage),
        leadSubStage: Object.fromEntries(subStage),
        applicationStage: Object.fromEntries(appStage),
        counsellor: counsellorEvidence,
        eventType: M.EVENT_TYPE_MAP,
      },
      decisions: {
        heldBackDuplicates: 'user chose to hold collision rows back for manual review',
        v1TimelineId: 'populated, activating timelines_v1_timeline_id_uniq for idempotency (user approved)',
        v1NoteId: 'populated, activating notes_v1_note_id_uniq (the previous migration left it NULL)',
        templateId: 'NULL - v1 template ids are dropped, matching the previous migration (17,903/17,903)',
        paymentRecords: 'v1 feedues/feeTransactions rows are NOT migrated, matching the previous migration',
        paymentCompletedAt: 'left NULL, matching the previous migration (42 of 60 sampled paid applicants are NULL)',
        activityTrackers: 'ApplicationActivityTrackers IS migrated - column-for-column, verified identical on 2,291/2,291 untouched rows',
        leadActivityTracker: 'v1 leadActivityTracker is NOT migrated - v2 has no such table and the previous migration never wrote one',
        leadStageLogs: 'NOT written - all 14,963 UG rows in v2 were generated natively by v2; none carry v1_id',
        applicationSubStage: 'mapped by (stage name, sub-stage name); all 30 v1 UG values in use resolve',
        leadScoreHistory: 'IS migrated (source=v1_history); criteria/mapping resolved by name and cross-checked against migrated rows',
      },
      warnings,
    };
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
    log('  manifest.json');

    hr('EXPORT COMPLETE');
    log(`  run folder : ${OUT}`);
    log(`  leads      : ${outLeads.length}   held back: ${heldBack.length}`);
    log(`  timelines  : ${outTl.length}   notes: ${outNotes.length}   tags: ${outTags.length}`);
    log(`  promotions : ${outPromotions.length}   students to create: ${outStudents.length}`);
    log(`  trackers   : ${outTrackers.length} insert, ${outTrackerUpdates.length} update`);
    log(`  score hist : ${outScoreHistory.length}`);
    log(`  warnings   : ${warnings.length}`);
    log('\n  Nothing was written to any database.');
  } finally {
    await v1.end(); await v2.end();
  }
})().catch(e => { console.error('\nEXPORT FAILED:', e.message); console.error(e.stack); process.exit(1); });
