/**
 * READ-ONLY.  "What exactly will change in v2?"
 *
 * Reports every table, every column and every row the import would touch, derived
 * from the export payload itself (not from a description of it), plus ready-made
 * SQL you can paste into a DB client to see the rows before and after.
 *
 *   node scripts/export/16-impact-report.cjs [--run <id>]
 */
const fs = require('fs');
const path = require('path');
const { connect } = require('../lib/db.cjs');
const M = require('../lib/maps.cjs');

const REPOS = 'C:/Users/Prateek/Desktop/Repos';
const EXPORT_ROOT = path.join(REPOS, 'data', 'export');
const args = process.argv.slice(2);
const runArg = args.includes('--run') ? args[args.indexOf('--run') + 1] : null;

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(84) + '\n' + t + '\n' + '='.repeat(84));
const readNd = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];

/** Which columns does this payload actually set a non-null value for? */
function columnUse(rows, skip = []) {
  const out = new Map();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (skip.includes(k)) continue;
      if (!out.has(k)) out.set(k, { nonNull: 0, total: 0, sample: null });
      const e = out.get(k);
      e.total++;
      if (v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) {
        e.nonNull++;
        if (e.sample === null) e.sample = typeof v === 'object' ? JSON.stringify(v).slice(0, 44) : String(v).slice(0, 44);
      }
    }
  }
  return out;
}
function printColumns(title, rows, skip = []) {
  const use = columnUse(rows, skip);
  const set = [...use.entries()].filter(([, e]) => e.nonNull > 0).sort((a, b) => b[1].nonNull - a[1].nonNull);
  const nul = [...use.entries()].filter(([, e]) => e.nonNull === 0).map(([k]) => k);
  log(`\n  ${title}`);
  log(`  ${'column'.padEnd(34)} ${'rows w/ a value'.padStart(16)}   example`);
  log('  ' + '-'.repeat(80));
  for (const [k, e] of set) log(`  ${k.padEnd(34)} ${String(e.nonNull + ' / ' + e.total).padStart(16)}   ${e.sample ?? ''}`);
  if (nul.length) {
    log(`\n  written as NULL / empty on every row (${nul.length}):`);
    log('    ' + nul.join(', '));
  }
}

(async () => {
  const runs = fs.readdirSync(EXPORT_ROOT).filter(d => fs.statSync(path.join(EXPORT_ROOT, d)).isDirectory()).sort();
  const runId = runArg || runs[runs.length - 1];
  const DIR = path.join(EXPORT_ROOT, runId);

  const leads = readNd(path.join(DIR, 'leads.ndjson'));
  const ugLead = readNd(path.join(DIR, 'under_graduate_lead.ndjson'));
  const ugApp = readNd(path.join(DIR, 'under_graduate_applicant.ndjson'));
  const timelines = readNd(path.join(DIR, 'timelines.ndjson'));
  const notes = readNd(path.join(DIR, 'notes.ndjson'));
  const tags = readNd(path.join(DIR, 'lead_tags.ndjson'));
  const students = readNd(path.join(DIR, 'students.ndjson'));
  const promotions = readNd(path.join(DIR, 'promotions.ndjson'));
  const trackers = readNd(path.join(DIR, 'activity_trackers.ndjson'));
  const trackerUpdates = readNd(path.join(DIR, 'activity_tracker_updates.ndjson'));

  hr(`IMPACT REPORT - what the import would change in v2      export ${runId}`);

  log(`
  SEVEN tables are written. Nothing else in the database is touched: no schema change,
  no DELETE anywhere, and no UPDATE except the two noted below.

    table            INSERT   UPDATE   why
    ---------------  ------   ------   --------------------------------------------
    users            ${String(students.length).padStart(6)}        0   the 2 new applicants need a login row
    v2_leads         ${String(leads.length).padStart(6)}   ${String(promotions.length).padStart(6)}   the missing leads; 1 lead promoted to applicant
    under_graduate   ${String(ugLead.length - 1).padStart(6)}   ${String(1 + ugApp.length).padStart(6)}   form data; 1 orphan re-pointed, 3 get answers
    timelines        ${String(timelines.length).padStart(6)}        0   the v1 activity feed for those leads
    notes            ${String(notes.length).padStart(6)}        0   counsellor notes
    lead_tags        ${String(tags.length).padStart(6)}        0   lead tags
    ApplicationActivityTrackers
                     ${String(trackers.length).padStart(6)}   ${String(trackerUpdates.length).padStart(6)}   counsellor/application activity timestamps
`);

  // ------------------------------------------------------------------ per table
  hr('1. users     - INSERT only');
  log(`  ${students.length} row(s). These are STUDENTS (role='student'), not staff accounts.`);
  students.forEach(s => log(`    v1 user ${s.v1_id}  ${s.email}  "${s.name}"`));
  printColumns('columns set:', students);

  hr('2. v2_leads  - INSERT (the bulk of the change)');
  log(`  ${leads.length} new rows, all org_id=${M.ORG_V2}, school_id=${M.SCHOOL_V2}.`);
  const byForm = leads.reduce((a, r) => (a[r.form_id] = (a[r.form_id] || 0) + 1, a), {});
  const byType = leads.reduce((a, r) => (a[r.type] = (a[r.type] || 0) + 1, a), {});
  log(`  by form_id: ${JSON.stringify(byForm)}   by type: ${JSON.stringify(byType)}`);
  printColumns('columns set on the new rows:', leads, ['_v1']);
  const applicants = leads.filter(l => l.type === 'applicant');
  log(`
  NOTE: user_id shows as NULL above because the export cannot know it yet - the v2
  users row does not exist until the import creates it. The importer fills user_id
  for the ${applicants.length} applicant row(s) from the students it just inserted, and refuses to
  continue if it cannot resolve one. The other ${leads.length - applicants.length} rows are plain leads and
  legitimately have user_id = NULL, exactly like the 68,000 UG leads already in v2.`);

  hr('2b. v2_leads - UPDATE (exactly 1 row)');
  for (const p of promotions) {
    log(`  v2_leads.id = ${p.v2_lead_id}   "${p.registered_name}" <${p.registered_email}>`);
    log(`  ${'column'.padEnd(30)} ${'before'.padEnd(26)} -> after`);
    log('  ' + '-'.repeat(80));
    for (const k of Object.keys(p.after)) {
      const b = p.before[k], a = p.after[k];
      const f = v => v === null || v === undefined ? 'NULL' : String(v).slice(0, 25);
      log(`  ${k.padEnd(30)} ${f(b).padEnd(26)} -> ${f(a)}${String(f(b)) === String(f(a)) ? '   (unchanged)' : ''}`);
    }
    log(`\n  Guard: the UPDATE carries "AND type='lead' AND v1_application_id IS NULL",`);
    log(`  so if anyone edits this row before you apply, it is skipped rather than overwritten.`);
  }

  hr('3. under_graduate - INSERT + a few UPDATEs');
  log(`  ${ugLead.length} lead-level rows. Only leads that actually have city/state/grade get one`);
  log(`  (that is why it is ${ugLead.length} and not ${leads.length}).`);
  printColumns('lead-level columns set:', ugLead);
  log(`\n  Plus ${ugApp.length} application-form payloads (UPDATE of the row just inserted, or of an`);
  log(`  existing row for the promoted lead). Columns touched per applicant:`);
  for (const a of ugApp) log(`    ${JSON.stringify(a.key).padEnd(46)} ${Object.keys(a.data).length} columns`);
  const allAppCols = [...new Set(ugApp.flatMap(a => Object.keys(a.data)))].sort();
  log(`\n  union of application columns written (${allAppCols.length}):`);
  log('    ' + allAppCols.join(', '));

  hr('4. timelines - INSERT only');
  log(`  ${timelines.length} rows. This table is PARTITIONED by created_at; rows land in`);
  const parts = timelines.reduce((a, t) => {
    const d = new Date(t.created_at); const k = `timelines_p${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    a[k] = (a[k] || 0) + 1; return a;
  }, {});
  log(`  ${JSON.stringify(parts)}`);
  printColumns('columns set:', timelines, ['_v1']);

  hr('5. notes - INSERT only');
  log(`  ${notes.length} row(s).`);
  printColumns('columns set:', notes);

  hr('6. lead_tags - INSERT only');
  log(`  ${tags.length} row(s).`);
  printColumns('columns set:', tags, ['tag_name']);

  // ------------------------------------------------------------------ not touched
  hr('7. ApplicationActivityTrackers - INSERT + UPDATE');
  log(`  ${trackers.length} insert, ${trackerUpdates.length} update. One row per LEAD (not per application).`);
  printColumns('columns set:', trackers);
  for (const u of trackerUpdates) {
    log(`
  UPDATE of the existing tracker for v2 lead ${u.v2_lead_id} (from v1 tracker row ${u.v1_tracker_id}):`);
    if (u.before) for (const [k, v] of Object.entries(u.after)) {
      const b = u.before[k];
      const f = x => x === null || x === undefined ? 'NULL' : String(x).slice(0, 26);
      if (String(f(b)) !== String(f(v))) log(`    ${k.padEnd(32)} ${f(b).padEnd(28)} -> ${f(v)}`);
    }
  }

  hr('NOT touched by this import');
  log(`
  No row is ever DELETED, and no column is dropped or altered.

  These tables are explicitly NOT written, even though a lead normally relates to them:
    automation_events   suppressed on purpose by app.skip_automation (this is the 18-Aug lesson)
    workflows / workflow_executions / node_executions    untouched
    communicationLogs / communication_audiences          untouched
    feeDues / feeTransactions / fee_masters              untouched - v1 payment rows are NOT migrated,
                                                         matching the existing 2,427 migrated applicants
    applicationStageLogs / leadStageLogs                 untouched - stage history was never migrated for UG
    applicant_documents / educations / parents           untouched
    leadActivityTracker (v1, 5.9M rows)                 NOT migrated - v2 has no such table
    leadStageLogs                                       untouched - all 14,963 UG rows in v2 are
                                                        v2-native; none carry v1_id
    counsellors / org_users / user_schools               untouched
    organizations / schools / programs / applicationForms / batches / rounds / tags / leadStage
                                                         READ ONLY - used to resolve ids, never written
`);

  // ------------------------------------------------------------------ SQL to eyeball it
  hr('SQL you can paste into your DB client');
  const v1ids = leads.map(l => l.v1_lead_id);
  const sample = v1ids.slice(0, 5).join(',');
  const promoId = promotions.length ? promotions[0].v2_lead_id : 0;
  log(`
-- 1. BEFORE: these should return 0 rows. AFTER: ${leads.length}.
SELECT count(*) FROM v2_leads
WHERE org_id = ${M.ORG_V2} AND school_id = ${M.SCHOOL_V2} AND v1_lead_id IN (${sample} /* ... ${v1ids.length} ids */);

-- 2. The full set, the way the CRM sees it
SELECT id, v1_lead_id, form_id, type, registered_name, registered_email, registered_mobile,
       source, lead_stage_id, counsellor_id, city, created_at
FROM v2_leads
WHERE org_id = ${M.ORG_V2} AND school_id = ${M.SCHOOL_V2} AND form_id IN (104,105)
  AND v1_lead_id IS NOT NULL
ORDER BY id DESC LIMIT ${leads.length};

-- 3. The one UPDATE - Ananya's promotion. Run it before AND after.
SELECT id, type, application_number, payment_status, is_payment_done,
       application_form_submitted, user_id, v1_application_id, updated_at
FROM v2_leads WHERE id = ${promoId};

-- 4. The 2 new student logins
SELECT id, email, name, role, user_type, organization_id, school_id, v1_id, created_at
FROM users WHERE v1_id IN (${students.map(s => s.v1_id).join(',')});

-- 5. Timelines (bound created_at - the table is partitioned and huge)
SELECT count(*) FROM timelines
WHERE created_at >= '2026-07-01' AND created_at < '2026-10-01'
  AND org_id = ${M.ORG_V2} AND school_id = ${M.SCHOOL_V2} AND v1_timeline_id IS NOT NULL;

-- 6. THE SAFETY CHECK - must stay 0 after the apply.
--    Any row here means the automation trigger fired and emails may be going out.
SELECT count(*) FROM automation_events
WHERE table_name = 'v2_leads'
  AND row_id IN (SELECT id FROM v2_leads
                 WHERE org_id = ${M.ORG_V2} AND school_id = ${M.SCHOOL_V2} AND v1_lead_id IN (${sample} /* ... */));

-- 7. The org-wide totals, before and after
SELECT type, count(*) FROM v2_leads
WHERE org_id = ${M.ORG_V2} AND school_id = ${M.SCHOOL_V2} AND form_id IN (104,105) GROUP BY type;
`);

  // ------------------------------------------------------------------ live totals
  const v2 = await connect('v2');
  try {
    hr('Current v2 totals, and what they become');
    const { rows: cur } = await v2.query(`
      select type, count(*)::int n from v2_leads
      where org_id=$1 and school_id=$2 and form_id in (104,105) group by 1 order by 1`, [M.ORG_V2, M.SCHOOL_V2]);
    const add = leads.reduce((a, r) => (a[r.type] = (a[r.type] || 0) + 1, a), {});
    log(`  ${'v2_leads (UG, forms 104+105)'.padEnd(34)} ${'now'.padStart(8)} ${'+'.padStart(8)} ${'after'.padStart(8)}`);
    let tn = 0, ta = 0;
    for (const r of cur) {
      // the promotion moves one row from lead to applicant
      const moved = r.type === 'lead' ? -promotions.length : promotions.length;
      const plus = (add[r.type] || 0) + moved;
      log(`  ${('  type = ' + r.type).padEnd(34)} ${String(r.n).padStart(8)} ${String(plus >= 0 ? '+' + plus : plus).padStart(8)} ${String(r.n + plus).padStart(8)}`);
      tn += r.n; ta += r.n + plus;
    }
    log(`  ${'  TOTAL'.padEnd(34)} ${String(tn).padStart(8)} ${('+' + leads.length).padStart(8)} ${String(ta).padStart(8)}`);
    log(`\n  (the promotion is not an extra row - it moves one row from 'lead' to 'applicant')`);

    const { rows: ug } = await v2.query('select count(*)::int n from under_graduate where org_id=$1', [M.ORG_V2]);
    log(`\n  under_graduate (org ${M.ORG_V2})              ${String(ug[0].n).padStart(8)} ${('+' + (ugLead.length - 1)).padStart(8)} ${String(ug[0].n + ugLead.length - 1).padStart(8)}`);
    const { rows: us } = await v2.query(`select count(*)::int n from users where organization_id=$1 and school_id=$2 and role='student'`, [M.ORG_V2, M.SCHOOL_V2]);
    log(`  users (UG students)                ${String(us[0].n).padStart(8)} ${('+' + students.length).padStart(8)} ${String(us[0].n + students.length).padStart(8)}`);
  } finally { await v2.end(); }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
