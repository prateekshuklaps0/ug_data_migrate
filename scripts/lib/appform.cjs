/**
 * The v1 ApplicationResponses -> v2 `under_graduate` column mapping.
 *
 * Extracted from 10-export.cjs so that the exporter, the verifier and the audits
 * all use ONE definition. If this drifts from what the migration actually writes,
 * the audits stop being evidence.
 *
 * Every id below was derived empirically from already-migrated rows; see
 * ai_agent_history/02-field-mappings.md.
 */

// sectionFieldId -> under_graduate column
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

/** Every sectionFieldId that lands in an under_graduate column. */
const MAPPED_SFIDS = new Set([
  ...Object.keys(SCALAR), ...Object.keys(DATE), ...Object.keys(BOOL_YESNO),
  ...Object.keys(BOTH), ...Object.keys(MULTI), ...Object.keys(FILE),
  ...Object.keys(EXAM_CHECKBOX), ...Object.keys(CLASS10_TABLE), ...Object.keys(DECL),
].map(Number));

/** Every under_graduate column this mapping can populate. */
const MAPPED_COLS = [...new Set([
  ...Object.values(SCALAR), ...Object.values(DATE), ...Object.values(BOOL_YESNO),
  ...Object.values(BOTH).flat(), ...Object.values(MULTI), ...Object.values(FILE).flat(),
  ...Object.values(EXAM_COL), ...Object.values(DECL), ...C10,
])];

/** Build under_graduate column values from v1 ApplicationResponses for each application. */
async function buildApplicantUnderGraduate(v1, amIds) {
  const out = new Map();
  if (!amIds.length) return out;
  const { rows } = await v1.query(`
    select ar."applicationManagerId" am, ar."sectionFieldId" sfid, sf.label, sf.type,
           ar.value, ar."fileName", ar."dynamicTableData" dt
    from "ApplicationResponses" ar left join sectionfields sf on sf.id = ar."sectionFieldId"
    where ar."applicationManagerId" = any($1::int[]) order by ar."applicationManagerId", ar.id`, [amIds]);

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

module.exports = { buildApplicantUnderGraduate, MAPPED_SFIDS, MAPPED_COLS };
