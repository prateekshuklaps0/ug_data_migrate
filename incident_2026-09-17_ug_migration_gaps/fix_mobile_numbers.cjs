// Option B data fix: for migrated UG applications, set v2_leads.registered_mobile to the number the
// student actually logs in with (users.phone), keeping the old lead number in alternate_mobile_number.
//
// Plan = the status=FIX rows of ug_mobile_fix_plan.csv (built by build_mobile_fix_csv.cjs, signed off by the team).
// Rows flagged REVIEW_* or SKIP_DELETED are never touched.
//
// SAFETY
//  - Default is a DRY RUN (read-only session). Nothing is written unless --apply is passed.
//  - Every row is re-checked against the live DB inside the transaction, with the rows locked:
//      lead exists, org 12 / school 18 / programme 94 or 95, migrated (v1_application_id), not deleted
//      registered_mobile still equals the sheet's current_mobile
//      the linked user's phone still equals the sheet's correct number
//      alternate_mobile_number still equals the sheet's current value
//      the target number is not already used by another live lead in the same programme
//    If ANY row fails, --apply aborts and changes nothing (all or nothing).
//  - app.skip_automation is set for the transaction, so correcting stored data fires no workflows or messages.
//  - One transaction: UPDATE + timeline rows + in-transaction verification. Any mismatch => ROLLBACK.
//  - Before COMMIT it writes a backup, the applied list and rollback.sql into runs/<timestamp>/.
//  - Only registered_mobile, alternate_mobile_number and updated_at change.
//
// Usage (from this folder):
//   node fix_mobile_numbers.cjs            dry run
//   node fix_mobile_numbers.cjs --apply    apply
// Options: --csv <path> (default ug_mobile_fix_plan.csv here), --env <path> (default ../new_crm_backend/.env)
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = args.includes('--apply');
const CSV_PATH = path.resolve(argVal('--csv') || path.join(__dirname, 'ug_mobile_fix_plan.csv'));
const BACKEND = path.join(__dirname, '..', 'new_crm_backend');
const ENV_PATH = path.resolve(argVal('--env') || path.join(BACKEND, '.env'));

require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: ENV_PATH });
const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));

const ORG_ID = 12;
const SCHOOL_ID = 18;
const PROGRAMMES = [94, 95];
const EXPECTED_COUNT = 64; // status=FIX rows signed off by the team
const PROD_HOST = 'anandi.c1nvajieufmh.ap-south-1.rds.amazonaws.com';
const ALLOWED_HOSTS = [PROD_HOST, ...(process.env.FIX_ALLOW_TEST_HOST ? [process.env.FIX_ALLOW_TEST_HOST] : [])];

const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(`\nABORTED: ${msg}\nNothing was changed.`); process.exit(1); };
const d10 = (v) => (v == null ? '' : String(v).replace(/\D/g, '').slice(-10));

// RFC 4180 CSV parser (quoted fields, embedded commas/newlines, BOM).
const parseCsv = (text) => {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
};

const loadPlan = () => {
  if (!fs.existsSync(CSV_PATH)) fail(`CSV not found: ${CSV_PATH}`);
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  const header = rows[0];
  const need = ['status', 'v2_lead_id', 'current_mobile', 'correct_mobile_student_logs_in_with',
    'current_alternate_mobile', 'alternate_mobile_after_fix'];
  const idx = Object.fromEntries(need.map(k => [k, header.indexOf(k)]));
  for (const k of need) if (idx[k] < 0) fail(`CSV is missing column "${k}". Use the full plan CSV, not the review copy.`);
  const plan = []; const seen = new Set();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    if (r.length !== header.length) fail(`CSV line ${line} has ${r.length} columns, header has ${header.length} (file edited?)`);
    if (r[idx.status] !== 'FIX') return;
    const id = Number(r[idx.v2_lead_id]);
    if (!Number.isInteger(id) || id <= 0) fail(`CSV line ${line}: bad v2_lead_id "${r[idx.v2_lead_id]}"`);
    const p = { id, oldMob: d10(r[idx.current_mobile]), newMob: d10(r[idx.correct_mobile_student_logs_in_with]),
      oldAlt: d10(r[idx.current_alternate_mobile]), newAlt: d10(r[idx.alternate_mobile_after_fix]) };
    if (p.oldMob.length !== 10 || p.newMob.length !== 10) fail(`CSV line ${line}: mobile is not 10 digits`);
    if (p.oldMob === p.newMob) fail(`CSV line ${line}: current and correct mobile are the same`);
    if (p.newAlt !== p.oldMob) fail(`CSV line ${line}: alternate_mobile_after_fix should be the old lead number`);
    if (seen.has(p.id)) fail(`lead ${p.id} appears twice in CSV`);
    seen.add(p.id); plan.push(p);
  });
  if (plan.length !== EXPECTED_COUNT) fail(`CSV has ${plan.length} FIX rows, expected exactly ${EXPECTED_COUNT}`);
  return plan;
};

const LIVE_SQL = (lock) => `
WITH p AS (SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[]) AS p(lead_id, old_mob, new_mob, old_alt)),
lead AS (
  SELECT l.id, l.org_id, l.school_id, l.program_id, l.is_deleted, l.v1_application_id, l.user_id,
         l.registered_mobile, l.alternate_mobile_number
    FROM v2_leads l WHERE l.id = ANY($1::int[]) ORDER BY l.id ${lock ? 'FOR UPDATE OF l' : ''}
)
SELECT p.lead_id, p.old_mob, p.new_mob, p.old_alt,
       lead.id IS NOT NULL AS lead_exists, lead.org_id, lead.school_id, lead.program_id, lead.is_deleted,
       lead.v1_application_id, lead.user_id,
       right(regexp_replace(lead.registered_mobile,'\\D','','g'),10) AS live_mob,
       coalesce(right(regexp_replace(lead.alternate_mobile_number,'\\D','','g'),10),'') AS live_alt,
       coalesce(right(regexp_replace(u.phone,'\\D','','g'),10),'') AS live_login,
       (SELECT count(*) FROM v2_leads o
         WHERE o.id <> p.lead_id AND o.org_id = ${ORG_ID} AND o.program_id = lead.program_id AND NOT o.is_deleted
           AND right(regexp_replace(o.registered_mobile,'\\D','','g'),10) = p.new_mob)::int AS same_number_elsewhere
  FROM p
  LEFT JOIN lead ON lead.id = p.lead_id
  LEFT JOIN users u ON u.id = lead.user_id
 ORDER BY p.lead_id`;

const checkLive = (rows) => {
  const problems = [];
  for (const r of rows) {
    const why = [];
    if (!r.lead_exists) why.push('lead not found');
    else {
      if (r.org_id !== ORG_ID || r.school_id !== SCHOOL_ID) why.push(`org/school is ${r.org_id}/${r.school_id}`);
      if (!PROGRAMMES.includes(r.program_id)) why.push(`programme is ${r.program_id}`);
      if (!r.v1_application_id) why.push('not a migrated application');
      if (r.is_deleted) why.push('application is deleted now');
      if (r.live_mob !== r.old_mob) why.push(r.live_mob === r.new_mob ? 'already fixed' : `mobile changed since the sheet: now ${r.live_mob}, sheet said ${r.old_mob}`);
      if (r.live_alt !== r.old_alt) why.push(`alternate changed since the sheet: now "${r.live_alt}", sheet said "${r.old_alt}"`);
      if (!r.user_id) why.push('no linked user');
      else if (r.live_login !== r.new_mob) why.push(`student's login number is now ${r.live_login}, sheet said ${r.new_mob}`);
      if (r.same_number_elsewhere > 0) why.push(`${r.same_number_elsewhere} other live lead(s) in this programme already use ${r.new_mob}`);
    }
    if (why.length) problems.push({ v2_lead_id: r.lead_id, reason: why.join('; ') });
  }
  return problems;
};

const csvOut = (cols, rows) => [cols.join(','), ...rows.map(r => cols.map(k => {
  const v = r[k]; if (v == null) return ''; const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(','))].join('\n') + '\n';

(async () => {
  const plan = loadPlan();
  const host = (process.env.DB_HOST || '').trim();
  if (!ALLOWED_HOSTS.includes(host)) fail(`DB_HOST in ${ENV_PATH} is "${host}", expected v2 prod ${PROD_HOST}`);

  log(`Mode      : ${APPLY ? 'APPLY (will write)' : 'DRY RUN (read-only, nothing is written)'}`);
  log(`Database  : ${process.env.DB_USER}@${host}/${process.env.DB_NAME}`);
  log(`CSV       : ${CSV_PATH}`);
  log(`Planned   : ${plan.length} applications`);

  const c = new Client({
    host, port: Number(process.env.DB_PORT) || 5432, user: (process.env.DB_USER || '').trim(),
    password: process.env.DB_PASSWORD, database: (process.env.DB_NAME || '').trim(),
    ssl: String(process.env.DB_SSL).trim() === 'true' ? { rejectUnauthorized: false } : false,
    application_name: 'fix_mobile_numbers_ug',
  });
  await c.connect();
  const params = [plan.map(p => p.id), plan.map(p => p.oldMob), plan.map(p => p.newMob), plan.map(p => p.oldAlt)];

  if (!APPLY) {
    await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    const { rows } = await c.query(LIVE_SQL(false), params);
    await c.end();
    const problems = checkLive(rows);
    if (problems.length) {
      console.table(problems.slice(0, 50));
      log(`\nDRY RUN: ${problems.length} row(s) FAILED checks. --apply would ABORT. Do not apply; share this output.`);
      process.exit(2);
    }
    log(`\nDRY RUN OK: all ${rows.length} applications passed every check. Nothing was written.`);
    log('To apply: node fix_mobile_numbers.cjs --apply');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(__dirname, 'runs', stamp);
  fs.mkdirSync(runDir, { recursive: true });

  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL app.skip_automation = 'true'`);
    await c.query(`SET LOCAL lock_timeout = '15s'`);
    await c.query(`SET LOCAL statement_timeout = '120s'`);
    const txStart = (await c.query('SELECT now() AS t')).rows[0].t;

    const live = (await c.query(LIVE_SQL(true), params)).rows;
    if (live.length !== plan.length) throw new Error(`live check returned ${live.length} rows, expected ${plan.length}`);
    const problems = checkLive(live);
    if (problems.length) {
      fs.writeFileSync(path.join(runDir, 'failed_checks.csv'), csvOut(['v2_lead_id', 'reason'], problems));
      throw new Error(`${problems.length} row(s) failed checks (see ${path.join(runDir, 'failed_checks.csv')})`);
    }

    const backup = (await c.query(
      `SELECT id AS v2_lead_id, registered_mobile, alternate_mobile_number, country_code, updated_at
         FROM v2_leads WHERE id = ANY($1::int[]) ORDER BY id`, [params[0]])).rows;
    if (backup.length !== plan.length) throw new Error(`backup returned ${backup.length} rows, expected ${plan.length}`);
    fs.writeFileSync(path.join(runDir, 'backup_before.csv'),
      csvOut(['v2_lead_id', 'registered_mobile', 'alternate_mobile_number', 'country_code', 'updated_at'], backup));

    // registered_mobile <- login number, old lead number preserved as the alternate.
    const upd = await c.query(
      `UPDATE v2_leads l
          SET registered_mobile = p.new_mob, alternate_mobile_number = p.old_mob, updated_at = NOW()
         FROM unnest($1::int[], $2::text[], $3::text[]) AS p(lead_id, old_mob, new_mob)
        WHERE l.id = p.lead_id
          AND right(regexp_replace(l.registered_mobile,'\\D','','g'),10) = p.old_mob
          AND l.org_id = ${ORG_ID} AND l.school_id = ${SCHOOL_ID} AND l.is_deleted = false
    RETURNING l.id`, params.slice(0, 3));
    if (upd.rowCount !== plan.length) throw new Error(`UPDATE touched ${upd.rowCount} rows, expected ${plan.length}`);

    const tl = await c.query(
      `INSERT INTO timelines (v2_lead_id, org_id, school_id, event_type, title, description, metadata, created_by, created_at, updated_at)
       SELECT l.id, l.org_id, l.school_id, 'updated', 'Lead Updated',
              'Changed Registered Mobile from "' || p.old_mob || '" to "' || p.new_mob ||
              '" - data fix: corrected to the number the student logs in with; old number kept as alternate',
              jsonb_build_object('fields', jsonb_build_array('registeredMobile','alternateMobileNumber'),
                                 'prevMobile', p.old_mob, 'newMobile', p.new_mob,
                                 'prevAlternate', p.old_alt, 'newAlternate', p.old_mob,
                                 'source', 'data_fix_v1_migration_mobile'),
              NULL, NOW(), NOW()
         FROM unnest($1::int[], $2::text[], $3::text[], $4::text[]) AS p(lead_id, old_mob, new_mob, old_alt)
         JOIN v2_leads l ON l.id = p.lead_id
    RETURNING id, v2_lead_id`, params);
    if (tl.rowCount !== plan.length) throw new Error(`timeline INSERT created ${tl.rowCount} rows, expected ${plan.length}`);

    const ver = (await c.query(
      `SELECT count(*)::int AS ok FROM v2_leads l
         JOIN unnest($1::int[], $2::text[], $3::text[]) AS p(lead_id, new_mob, old_mob) ON p.lead_id = l.id
        WHERE right(regexp_replace(l.registered_mobile,'\\D','','g'),10) = p.new_mob
          AND right(regexp_replace(l.alternate_mobile_number,'\\D','','g'),10) = p.old_mob`,
      [params[0], params[2], params[1]])).rows[0].ok;
    if (ver !== plan.length) throw new Error(`verification: ${ver} rows correct, expected ${plan.length}`);
    const auto = (await c.query(
      `SELECT count(*)::int AS n FROM automation_events WHERE table_name='v2_leads' AND row_id = ANY($1::bigint[]) AND created_at >= $2`,
      [params[0], txStart])).rows[0].n;
    if (auto !== 0) throw new Error(`${auto} automation events were emitted; suppression did not work`);

    const tlIds = tl.rows.map(r => r.id);
    fs.writeFileSync(path.join(runDir, 'rollback.sql'),
`-- Rollback for fix_mobile_numbers run ${stamp}. Review before running.
BEGIN;
SET LOCAL app.skip_automation = 'true';
UPDATE v2_leads l SET registered_mobile = v.old_mob, alternate_mobile_number = NULLIF(v.old_alt,''), updated_at = NOW()
  FROM (VALUES
  ${plan.map(p => `(${p.id},'${p.oldMob}','${p.newMob}','${p.oldAlt}')`).join(',\n  ')}
  ) AS v(lead_id, old_mob, new_mob, old_alt)
 WHERE l.id = v.lead_id
   AND right(regexp_replace(l.registered_mobile,'\\D','','g'),10) = v.new_mob;
DELETE FROM timelines WHERE id IN (${tlIds.join(',')}) AND created_by IS NULL
   AND metadata->>'source' = 'data_fix_v1_migration_mobile';
-- Expect UPDATE ${plan.length} and DELETE ${plan.length}. If not, run ROLLBACK; instead of COMMIT.
COMMIT;
`);
    fs.writeFileSync(path.join(runDir, 'applied.csv'), csvOut(
      ['v2_lead_id', 'old_mobile', 'new_mobile', 'old_alternate', 'new_alternate', 'new_timeline_id'],
      plan.map(p => ({ v2_lead_id: p.id, old_mobile: p.oldMob, new_mobile: p.newMob, old_alternate: p.oldAlt,
        new_alternate: p.oldMob, new_timeline_id: tl.rows.find(r => r.v2_lead_id === p.id)?.id }))));

    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
    fail(`${e.message}\nTransaction rolled back. Files in ${runDir} are for diagnosis only.`);
  }

  const post = (await c.query(
    `SELECT count(*) FILTER (WHERE right(regexp_replace(l.registered_mobile,'\\D','','g'),10) = p.new_mob)::int AS correct,
            count(*)::int AS total
       FROM unnest($1::int[], $2::text[]) AS p(lead_id, new_mob) JOIN v2_leads l ON l.id = p.lead_id`,
    [params[0], params[2]])).rows[0];
  await c.end();
  log(`\nCOMMITTED. Post-check: ${post.correct}/${post.total} applications now carry the student's login number.`);
  log(`Run files (backup, applied list, rollback.sql): ${runDir}`);
  if (post.correct !== plan.length) { console.error('WARNING: post-check mismatch, share this output immediately.'); process.exit(3); }
})().catch(e => fail(e.message));
