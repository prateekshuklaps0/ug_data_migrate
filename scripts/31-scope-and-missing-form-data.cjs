/**
 * READ-ONLY audit answering two questions:
 *
 *  A. Is this migration strictly confined to the stated entities?
 *     v1 org 68 / school 11 / programs 94,105 / forms 100,109
 *     v2 org 12 / school 18 / programs 94,95  / forms 104,105
 *
 *  B. A person whose LEAD already exists in v2 but whose APPLICATION FORM DATA
 *     does not. Testers report ~5 such cases. Which are they, and does the
 *     importer cover them?
 *
 *   node scripts/31-scope-and-missing-form-data.cjs
 */
const fs = require('fs');
const path = require('path');
const { connect } = require('./lib/db.cjs');
const M = require('./lib/maps.cjs');
const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(84) + '\n' + t + '\n' + '='.repeat(84));

const EMPTY = `value is not null and btrim(value) <> ''`;

const { MAPPED_SFIDS, MAPPED_COLS } = require('./lib/appform.cjs');

(async () => {
  const v1 = await connect('v1', { readOnly: true });
  const v2 = await connect('v2', { readOnly: true });
  try {
    const { rows: ugCols } = await v2.query(
      `select column_name from information_schema.columns where table_name = 'under_graduate'`);
    const ugColSet = new Set(ugCols.map(r => r.column_name));
    const FORM_COLS = MAPPED_COLS.filter(c => ugColSet.has(c));
    log(`mapping can fill ${FORM_COLS.length} of ${MAPPED_COLS.length} under_graduate columns`);

    // ================================================================= PART A
    hr('A1. v1 side - are forms 100 & 109 really in org 68 / school 11?');
    const { rows: f1 } = await v1.query(`
      select f.id, f.title, f."programId", f."schoolId", f."organizationId", f."isActive"
      from "applicationForms" f where f."schoolId" = 11 order by f.id`);
    f1.forEach(r => log(`  form ${String(r.id).padEnd(4)} org ${r.organizationId} school ${r.schoolId} program ${String(r.programId).padEnd(5)} active=${r.isActive}  "${r.title}"`));
    const inScope = f1.filter(r => M.V1_FORMS.includes(r.id));
    log(`\n  IN SCOPE  : ${inScope.map(r => r.id).join(', ')}`);
    log(`  IGNORED   : ${f1.filter(r => !M.V1_FORMS.includes(r.id)).map(r => `${r.id}(active=${r.isActive})`).join(', ') || 'none'}`);
    for (const r of inScope) {
      if (r.organizationId !== 68 || r.schoolId !== 11) log(`  !! form ${r.id} is NOT org 68/school 11`);
    }
    log(`  programIds of the in-scope forms: ${inScope.map(r => r.programId).join(', ')}   (expected 94, 105)`);

    hr('A2. how much of v1 the export will never read');
    const { rows: [cAll] } = await v1.query('select count(*)::int n from "manageLeads"');
    const { rows: [cUg] } = await v1.query(
      'select count(*)::int n from "manageLeads" where "applicationFormId" = any($1::int[])', [M.V1_FORMS]);
    log(`  v1 manageLeads total         : ${cAll.n}`);
    log(`  v1 manageLeads forms 100,109 : ${cUg.n}`);
    log(`  never read by the export     : ${cAll.n - cUg.n}`);

    hr('A3. v2 targets');
    const { rows: f2 } = await v2.query(`
      select f.id, f.title, f."programId", f."schoolId", f."organizationId", p.name program, s.name school
      from "applicationForms" f join programs p on p.id=f."programId" join schools s on s.id=f."schoolId"
      where f.id = any($1::int[]) order by f.id`, [M.V2_FORMS]);
    f2.forEach(r => log(`  form ${r.id}  org ${r.organizationId}  school ${r.schoolId} "${r.school}"  program ${r.programId} "${r.program}"`));

    hr('A4. the exported payload itself - every row, not a sample');
    const runs = fs.readdirSync('data/export').filter(d => /^\d{4}-/.test(d)).sort();
    const DIR = path.join('data/export', runs[runs.length - 1]);
    log(`  checking ${DIR}`);
    const rd = f => {
      const p = path.join(DIR, f);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
    };
    const leads = rd('leads.ndjson');
    const bad = [];
    const seen = { org: new Set(), school: new Set(), form: new Set(), prog: new Set(), lt: new Set(), batch: new Set(), round: new Set() };
    for (const r of leads) {
      seen.org.add(r.org_id); seen.school.add(r.school_id); seen.form.add(r.form_id);
      seen.prog.add(r.program_id); seen.lt.add(r.lead_table_id);
      seen.batch.add(r.batch_id); seen.round.add(r.round_id);
      if (r.org_id !== 12 || r.school_id !== 18) bad.push(r.v1_lead_id);
      else if (![104, 105].includes(r.form_id)) bad.push(r.v1_lead_id);
      else if (![94, 95].includes(r.program_id)) bad.push(r.v1_lead_id);
    }
    log(`  leads in payload       : ${leads.length}`);
    log(`  distinct org_id        : ${[...seen.org].join(',')}`);
    log(`  distinct school_id     : ${[...seen.school].join(',')}`);
    log(`  distinct form_id       : ${[...seen.form].join(',')}`);
    log(`  distinct program_id    : ${[...seen.prog].join(',')}`);
    log(`  distinct batch_id      : ${[...seen.batch].join(',')}`);
    log(`  distinct round_id      : ${[...seen.round].join(',')}`);
    log(`  distinct lead_table_id : ${[...seen.lt].join(',')}`);
    log(`  ROWS OUTSIDE THE STATED ENTITIES: ${bad.length}`);
    const srcIds = leads.map(r => r.v1_lead_id);
    if (srcIds.length) {
      const { rows: srcForms } = await v1.query(
        `select "applicationFormId" f, count(*)::int n from "manageLeads" where id = any($1::int[]) group by 1 order by 1`, [srcIds]);
      log(`  their v1 applicationFormId(s): ${srcForms.map(r => `${r.f} x${r.n}`).join(', ')}   (expected only 100 and 109)`);
    }
    log('');
    for (const f of ['under_graduate_lead', 'under_graduate_applicant', 'timelines', 'notes',
      'lead_tags', 'activity_trackers', 'lead_score_history', 'promotions', 'students']) {
      const rows = rd(f + '.ndjson');
      const orgs = new Set(rows.map(r => r.org_id !== undefined ? r.org_id : r.organization_id).filter(v => v !== undefined));
      const schools = new Set(rows.map(r => r.school_id !== undefined ? r.school_id : r.schoolId).filter(v => v !== undefined));
      log(`  ${(f + '.ndjson').padEnd(30)} ${String(rows.length).padStart(5)} rows   org=${[...orgs].join(',') || '-'}   school=${[...schools].join(',') || '-'}`);
    }

    // ================================================================= PART B
    hr('B1. v1 people who APPLIED (have an ApplicationManager row) on forms 100/109');
    const { rows: applied } = await v1.query(`
      select ml.id v1_lead, ml."applicationManagerId" am, ml."applicationFormId" f,
             ml."registeredEmail" email, ml."registeredName" name,
             am."applicationNum", am."applicationStatus", am."isApplicationLeadDeleted" am_deleted, am."createdAt" am_created
      from "manageLeads" ml join "ApplicationManager" am on am.id = ml."applicationManagerId"
      where ml."applicationFormId" = any($1::int[])`, [M.V1_FORMS]);
    log(`  v1 UG leads with an application : ${applied.length}`);

    const ids = applied.map(r => r.v1_lead);
    const v2By = new Map();
    for (let i = 0; i < ids.length; i += 20000) {
      const { rows } = await v2.query(`
        select id, v1_lead_id, v1_application_id, type, application_number, application_stage_id,
               is_deleted, form_id, org_id, school_id
        from v2_leads where v1_lead_id = any($1::int[])`, [ids.slice(i, i + 20000)]);
      rows.forEach(r => v2By.set(r.v1_lead_id, r));
    }
    log(`  ... LEAD exists in v2           : ${v2By.size}`);
    log(`  ... LEAD missing from v2        : ${applied.length - v2By.size}   (covered by the normal gap import)`);

    hr('B2. THE TESTER CASE - lead is in v2, application was never carried over');
    const notPromoted = applied.filter(r => v2By.has(r.v1_lead) && v2By.get(r.v1_lead).v1_application_id === null);
    log(`  leads in v2 whose v1_application_id IS NULL: ${notPromoted.length}\n`);
    for (const r of notPromoted) {
      const t = v2By.get(r.v1_lead);
      const { rows: [resp] } = await v1.query(
        `select count(*)::int n from "ApplicationResponses" where "applicationManagerId"=$1 and ${EMPTY}`, [r.am]);
      const { rows: [ug] } = await v2.query('select count(*)::int n from under_graduate where lead_id=$1', [t.id]);
      log(`    v1 lead ${r.v1_lead} / app ${r.am}  form ${r.f}  "${r.name}" <${r.email}>`);
      log(`        v1: appNum=${r.applicationNum} status=${r.applicationStatus} deleted=${r.am_deleted} answered=${resp.n} created=${r.am_created ? r.am_created.toISOString().slice(0, 10) : '-'}`);
      log(`        v2: lead ${t.id} type=${t.type} appNum=${t.application_number} ug_rows=${ug.n} deleted=${t.is_deleted}`);
    }

    hr('B3. promoted in v2 - but is the FORM DATA actually there?');
    const promoted = applied.filter(r => v2By.has(r.v1_lead) && v2By.get(r.v1_lead).v1_application_id !== null);
    log(`  leads in v2 WITH v1_application_id: ${promoted.length}`);
    const leadIds = promoted.map(r => v2By.get(r.v1_lead).id);
    const nonNullExpr = FORM_COLS.map(c => `(case when "${c}" is not null then 1 else 0 end)`).join(' + ');
    const ugBy = new Map();
    for (let i = 0; i < leadIds.length; i += 5000) {
      const { rows } = await v2.query(
        `select lead_id, (${nonNullExpr}) filled from under_graduate where lead_id = any($1::bigint[])`,
        [leadIds.slice(i, i + 5000)]);
      rows.forEach(r => ugBy.set(String(r.lead_id), Number(r.filled)));
    }
    const noUgRow = [], emptyUg = [];
    for (const r of promoted) {
      const f = ugBy.get(String(v2By.get(r.v1_lead).id));
      if (f === undefined) noUgRow.push(r); else if (f === 0) emptyUg.push(r);
    }
    log(`  no under_graduate row at all          : ${noUgRow.length}`);
    log(`  under_graduate row with 0 form fields : ${emptyUg.length}`);

    const suspects = [...noUgRow, ...emptyUg];
    const realLoss = [];
    for (const r of suspects) {
      const { rows: resp } = await v1.query(
        `select distinct "sectionFieldId" sf from "ApplicationResponses"
          where "applicationManagerId"=$1 and ${EMPTY}`, [r.am]);
      const mapped = resp.filter(x => MAPPED_SFIDS.has(Number(x.sf))).length;
      if (mapped > 0) realLoss.push({ ...r, answered: resp.length, mapped, v2: v2By.get(r.v1_lead) });
    }
    log(`  ... with answers in MAPPED fields  (= REAL LOSS): ${realLoss.length}`);
    log(`  ... only unmappable answers (name/email/phone/consent): ${suspects.length - realLoss.length}\n`);
    realLoss.slice(0, 40).forEach(r => log(
      `    v1 lead ${r.v1_lead} app ${r.am} form ${r.f} "${r.name}" <${r.email}>  v1_answered=${r.answered} MAPPED=${r.mapped}  v2 lead ${r.v2.id} type=${r.v2.type} deleted=${r.v2.is_deleted}`));
    if (realLoss.length > 40) log(`    ... and ${realLoss.length - 40} more`);

    hr('B4. partially filled - v1 has answers the v2 row does not');
    log('  (sampling the 400 most recent promoted applications)');
    const recent = promoted.slice(-400);
    let partial = 0; const partialEx = [];
    for (const r of recent) {
      const f = ugBy.get(String(v2By.get(r.v1_lead).id));
      if (f === undefined || f === 0) continue;
      const { rows: resp } = await v1.query(
        `select distinct "sectionFieldId" sf from "ApplicationResponses"
          where "applicationManagerId"=$1 and ${EMPTY}`, [r.am]);
      const n2 = resp.filter(x => MAPPED_SFIDS.has(Number(x.sf))).length;
      if (n2 - f >= 8) { partial++; if (partialEx.length < 10) partialEx.push({ r, f, n: n2 }); }
    }
    log(`  sampled ${recent.length}; rows where v1 has >=8 more MAPPED answered fields than v2 has filled: ${partial}`);
    partialEx.forEach(x => log(`    v1 lead ${x.r.v1_lead} app ${x.r.am}  v1_fields=${x.n}  v2_filled=${x.f}`));
    log('  (some gap is expected: name/email/phone live on v2_leads, consents are not stored)');

    hr('B5. Stream D - v1 applications with NO manageLeads row (invisible to a lead-driven import)');
    const { rows: [orph] } = await v1.query(`
      select count(*)::int n from "ApplicationManager" am
      where am."applicationFormId" = any($1::int[])
        and not exists (select 1 from "manageLeads" ml where ml."applicationManagerId" = am.id)`, [M.V1_FORMS]);
    const { rows: orphLive } = await v1.query(`
      select am.id, am."applicationFormId" f, am."applicationNum", am."applicationStatus", am."createdAt"
      from "ApplicationManager" am
      where am."applicationFormId" = any($1::int[]) and am."isApplicationLeadDeleted" = false
        and not exists (select 1 from "manageLeads" ml where ml."applicationManagerId" = am.id)
      order by am."createdAt" desc`, [M.V1_FORMS]);
    log(`  orphan applications total: ${orph.n}    live (not deleted): ${orphLive.length}`);
    orphLive.slice(0, 15).forEach(r => log(
      `    app ${r.id} form ${r.f} num=${r.applicationNum} status=${r.applicationStatus} created=${r.createdAt.toISOString().slice(0, 10)}`));

    hr('DONE');
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('ERR', e.message); console.error(e.stack); process.exit(1); });
