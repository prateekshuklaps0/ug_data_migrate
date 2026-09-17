// Restores counsellor assignments made by ugadmissions@mastersunion.org (4640466) on 2026-09-17 that were
// reverted by a manual DB query (between 17:02 and 17:16 IST). Approved plan =
// the REVERTED_NEEDS_FIX rows of ug_counsellor_reassignment_verification_2026-09-17.csv.
//
// SAFETY
//  - Default is a DRY RUN (read-only session). Nothing is written unless --apply is passed.
//  - Every lead is re-checked against the live DB (inside the transaction, rows locked):
//      lead exists, org 12, not deleted
//      current counsellor_id still equals the CSV's current_counsellor_id
//      that account's latest assignment timeline today is still the CSV's source_timeline_id
//      and points to the CSV's expected counsellor
//      nobody assigned the lead again after that timeline
//      expected counsellor user exists and is active
//    If ANY lead fails a check, --apply aborts and changes nothing (all or nothing).
//  - Mirrors the app's manual bulk-assign path: SET LOCAL app.skip_automation so no automations/emails fire.
//  - One transaction: UPDATE + timeline rows + in-transaction verification. Any mismatch => ROLLBACK.
//  - Before COMMIT it writes a backup of the old rows and a rollback.sql into runs/<timestamp>/.
//  - Only counsellor_id and updated_at change. previous_counsellor / reassigned_by / reassigned_on already
//    hold the values the admin's assignment wrote (the revert did not touch them).
//
// Usage (from this folder):
//   node fix_counsellor_assignments.cjs            dry run
//   node fix_counsellor_assignments.cjs --apply    apply
// Options: --csv <path> (default: the dev verification CSV in this folder), --env <path> (default: ../new_crm_backend/.env)
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = args.includes('--apply');
const CSV_PATH = path.resolve(argVal('--csv') || path.join(__dirname, 'ug_counsellor_reassignment_verification_2026-09-17.csv'));
const BACKEND = path.join(__dirname, '..', 'new_crm_backend');
const ENV_PATH = path.resolve(argVal('--env') || path.join(BACKEND, '.env'));

require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: ENV_PATH });
const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));

const ADMIN_ID = 4640466;
const ORG_ID = 12;
const EXPECTED_COUNT = 949; // approved rows
const PROD_HOST = 'anandi.c1nvajieufmh.ap-south-1.rds.amazonaws.com';
const ALLOWED_HOSTS = [PROD_HOST, ...(process.env.FIX_ALLOW_TEST_HOST ? [process.env.FIX_ALLOW_TEST_HOST] : [])];
const ASSIGN_EVENTS = ['assigned', 'counsellor_reassigned', 'counsellor_assigned', 'counsellor_removed'];

const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(`\nABORTED: ${msg}\nNothing was changed.`); process.exit(1); };

// RFC 4180 CSV parser (quoted fields, embedded commas/newlines, BOM).
const parseCsv = (text) => {
  text = text.replace(/^﻿/, '');
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => !(r.length === 1 && r[0] === ''));
};

const toInt = (v, what, lineNo) => {
  if (!/^\d+$/.test(String(v).trim())) fail(`CSV line ${lineNo}: ${what} is not a whole number: "${v}"`);
  return Number(v);
};

const loadPlan = () => {
  if (!fs.existsSync(CSV_PATH)) fail(`CSV not found: ${CSV_PATH}`);
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  const header = rows[0];
  const need = ['status', 'lead_id', 'current_counsellor_id', 'expected_counsellor_id', 'source_timeline_id'];
  const idx = Object.fromEntries(need.map(k => [k, header.indexOf(k)]));
  for (const k of need) if (idx[k] < 0) fail(`CSV is missing column "${k}". Use the full dev CSV, not the review copy.`);
  const plan = []; const seen = new Set();
  rows.slice(1).forEach((r, i) => {
    if (r.length !== header.length) fail(`CSV line ${i + 2} has ${r.length} columns, header has ${header.length} (file edited/corrupted?)`);
    if (r[idx.status] !== 'REVERTED_NEEDS_FIX') return;
    const p = {
      leadId: toInt(r[idx.lead_id], 'lead_id', i + 2),
      oldC: toInt(r[idx.current_counsellor_id], 'current_counsellor_id', i + 2),
      newC: toInt(r[idx.expected_counsellor_id], 'expected_counsellor_id', i + 2),
      srcTl: toInt(r[idx.source_timeline_id], 'source_timeline_id', i + 2),
    };
    if (seen.has(p.leadId)) fail(`lead ${p.leadId} appears twice in CSV`);
    if (p.oldC === p.newC) fail(`lead ${p.leadId}: current and expected counsellor are the same`);
    seen.add(p.leadId); plan.push(p);
  });
  if (plan.length !== EXPECTED_COUNT) fail(`CSV has ${plan.length} REVERTED_NEEDS_FIX rows, expected exactly ${EXPECTED_COUNT}`);
  return plan;
};

// Live state for every planned lead. FOR UPDATE locks the lead rows when run inside the apply transaction.
const LIVE_SQL = (lock) => `
WITH p AS (SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::int[]) AS p(lead_id, old_c, new_c, src_tl)),
lead AS (
  SELECT l.id, l.org_id, l.school_id, l.is_deleted, l.counsellor_id
    FROM v2_leads l WHERE l.id = ANY($1::int[]) ORDER BY l.id ${lock ? 'FOR UPDATE OF l' : ''}
),
adm_last AS (
  SELECT DISTINCT ON (t.v2_lead_id) t.v2_lead_id, t.id, t.created_at, NULLIF(t.metadata->>'newCounsellorId','')::int AS new_c
    FROM timelines t
   WHERE t.v2_lead_id = ANY($1::int[]) AND t.created_by = ${ADMIN_ID}
     AND t.created_at >= '2026-09-17 00:00+05:30' AND t.created_at < '2026-09-18 00:00+05:30'
     AND t.event_type = ANY($5::text[])
   ORDER BY t.v2_lead_id, t.created_at DESC, t.id DESC
)
SELECT p.lead_id, p.old_c, p.new_c, p.src_tl,
       lead.id IS NOT NULL AS lead_exists, lead.org_id, lead.school_id, lead.is_deleted, lead.counsellor_id AS live_c,
       a.id AS live_src_tl, a.new_c AS live_src_new_c,
       (SELECT count(*) FROM timelines o
         WHERE o.v2_lead_id = p.lead_id AND o.event_type = ANY($5::text[])
           AND (o.created_at > a.created_at OR (o.created_at = a.created_at AND o.id > a.id)))::int AS later_assignments,
       nu.id IS NOT NULL AS new_user_exists, nu.status AS new_user_status, nu.name AS new_name, ou.name AS old_name
  FROM p
  LEFT JOIN lead ON lead.id = p.lead_id
  LEFT JOIN adm_last a ON a.v2_lead_id = p.lead_id
  LEFT JOIN users nu ON nu.id = p.new_c
  LEFT JOIN users ou ON ou.id = p.old_c
 ORDER BY p.lead_id`;

const checkLive = (rows) => {
  const problems = [];
  for (const r of rows) {
    const why = [];
    if (!r.lead_exists) why.push('lead not found');
    else {
      if (r.org_id !== ORG_ID) why.push(`org_id is ${r.org_id}`);
      if (r.is_deleted) why.push('lead is deleted');
      if (r.live_c !== r.old_c) why.push(r.live_c === r.new_c ? 'already fixed (counsellor already correct)' : `counsellor changed since CSV: now ${r.live_c}, CSV said ${r.old_c}`);
    }
    if (r.live_src_tl !== r.src_tl) why.push(`latest admin assignment timeline is ${r.live_src_tl}, CSV said ${r.src_tl}`);
    if (r.live_src_new_c !== r.new_c) why.push(`latest admin assignment points to ${r.live_src_new_c}, CSV said ${r.new_c}`);
    if (r.later_assignments > 0) why.push(`${r.later_assignments} newer assignment timeline(s) exist`);
    if (!r.new_user_exists) why.push('expected counsellor user not found');
    else if (r.new_user_status !== 'active') why.push(`expected counsellor status is ${r.new_user_status}`);
    if (why.length) problems.push({ lead_id: r.lead_id, reason: why.join('; ') });
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
  log(`Planned   : ${plan.length} leads`);

  const c = new Client({
    host, port: Number(process.env.DB_PORT) || 5432, user: (process.env.DB_USER || '').trim(),
    password: process.env.DB_PASSWORD, database: (process.env.DB_NAME || '').trim(),
    ssl: String(process.env.DB_SSL).trim() === 'true' ? { rejectUnauthorized: false } : false,
    application_name: 'fix_counsellor_assignments_2026-09-17',
  });
  await c.connect();

  const params = [plan.map(p => p.leadId), plan.map(p => p.oldC), plan.map(p => p.newC), plan.map(p => p.srcTl), ASSIGN_EVENTS];

  if (!APPLY) {
    await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    const { rows } = await c.query(LIVE_SQL(false), params);
    await c.end();
    const problems = checkLive(rows);
    const pairs = {};
    for (const r of rows) { const k = `${r.old_name} -> ${r.new_name}`; pairs[k] = (pairs[k] || 0) + 1; }
    console.table(pairs);
    if (problems.length) {
      console.table(problems.slice(0, 50));
      log(`\nDRY RUN: ${problems.length} lead(s) FAILED checks${problems.length > 50 ? ' (first 50 shown)' : ''}. --apply would ABORT. Do not apply; share this output.`);
      process.exit(2);
    }
    log(`\nDRY RUN OK: all ${rows.length} leads passed every check. Nothing was written.`);
    log('To apply: node fix_counsellor_assignments.cjs --apply');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(__dirname, 'runs', stamp);
  fs.mkdirSync(runDir, { recursive: true });

  let committed = false;
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL app.skip_automation = 'true'`);
    await c.query(`SET LOCAL lock_timeout = '15s'`);
    await c.query(`SET LOCAL statement_timeout = '120s'`);
    const txStart = (await c.query('SELECT now() AS t')).rows[0].t;

    // 1) Lock rows and re-check everything inside the transaction.
    const live = (await c.query(LIVE_SQL(true), params)).rows;
    if (live.length !== plan.length) throw new Error(`live check returned ${live.length} rows, expected ${plan.length}`);
    const problems = checkLive(live);
    if (problems.length) {
      fs.writeFileSync(path.join(runDir, 'failed_checks.csv'), csvOut(['lead_id', 'reason'], problems));
      throw new Error(`${problems.length} lead(s) failed checks (see ${path.join(runDir, 'failed_checks.csv')})`);
    }

    // 2) Backup of the exact rows about to change (full row as JSON) + rollback SQL, written before any UPDATE.
    const backup = (await c.query(
      `SELECT id AS lead_id, counsellor_id, previous_counsellor, reassigned_by, reassigned_on, updated_at, to_jsonb(v2_leads) AS full_row
         FROM v2_leads WHERE id = ANY($1::int[]) ORDER BY id`, [params[0]])).rows;
    if (backup.length !== plan.length) throw new Error(`backup returned ${backup.length} rows, expected ${plan.length}`);
    fs.writeFileSync(path.join(runDir, 'backup_before.csv'),
      csvOut(['lead_id', 'counsellor_id', 'previous_counsellor', 'reassigned_by', 'reassigned_on', 'updated_at'], backup));
    fs.writeFileSync(path.join(runDir, 'backup_before_full_rows.ndjson'), backup.map(b => JSON.stringify(b.full_row)).join('\n') + '\n');

    // 3) Update, guarded per row on the old counsellor (plus org / not deleted).
    const upd = await c.query(
      `UPDATE v2_leads l
          SET counsellor_id = p.new_c, updated_at = NOW()
         FROM unnest($1::int[], $2::int[], $3::int[]) AS p(lead_id, old_c, new_c)
        WHERE l.id = p.lead_id AND l.counsellor_id = p.old_c AND l.org_id = ${ORG_ID} AND l.is_deleted = false
    RETURNING l.id`, params.slice(0, 3));
    if (upd.rowCount !== plan.length) throw new Error(`UPDATE touched ${upd.rowCount} rows, expected ${plan.length}`);

    // 4) Timeline row per lead so the change is visible on the lead profile.
    const tl = await c.query(
      `INSERT INTO timelines (v2_lead_id, org_id, school_id, event_type, title, description, metadata, created_by, created_at, updated_at)
       SELECT l.id, l.org_id, l.school_id, 'assigned', 'Counsellor Assignment Updated',
              'Counsellor assignment restored to ' || coalesce(nu.name, nu.email, p.new_c::text) || ' (data fix for 17 Sep 2026 assignment)',
              jsonb_build_object('newCounsellorId', p.new_c, 'newCounsellorName', coalesce(nu.name, nu.email),
                                 'prevCounsellorId', p.old_c, 'prevCounsellorName', coalesce(ou.name, ou.email),
                                 'assignmentMethod', 'data_fix', 'sourceTimelineId', p.src_tl),
              NULL, NOW(), NOW()
         FROM unnest($1::int[], $2::int[], $3::int[], $4::int[]) AS p(lead_id, old_c, new_c, src_tl)
         JOIN v2_leads l ON l.id = p.lead_id
         LEFT JOIN users nu ON nu.id = p.new_c
         LEFT JOIN users ou ON ou.id = p.old_c
    RETURNING id, v2_lead_id`, params.slice(0, 4));
    if (tl.rowCount !== plan.length) throw new Error(`timeline INSERT created ${tl.rowCount} rows, expected ${plan.length}`);

    // 5) Verify inside the transaction.
    const ver = (await c.query(
      `SELECT count(*)::int AS ok FROM v2_leads l
         JOIN unnest($1::int[], $2::int[]) AS p(lead_id, new_c) ON p.lead_id = l.id
        WHERE l.counsellor_id = p.new_c`, [params[0], params[2]])).rows[0].ok;
    if (ver !== plan.length) throw new Error(`verification: ${ver} leads have the expected counsellor, expected ${plan.length}`);
    const auto = (await c.query(
      `SELECT count(*)::int AS n FROM automation_events WHERE table_name = 'v2_leads' AND row_id = ANY($1::bigint[]) AND created_at >= $2`,
      [params[0], txStart])).rows[0].n;
    if (auto !== 0) throw new Error(`${auto} automation events were emitted; automation suppression did not work`);

    // 6) Rollback script (restores old counsellor only where it still holds our value, removes our timeline rows).
    const tlIds = tl.rows.map(r => r.id);
    const pairsSql = plan.map(p => `(${p.leadId},${p.oldC},${p.newC})`).join(',\n  ');
    fs.writeFileSync(path.join(runDir, 'rollback.sql'),
`-- Rollback for fix_counsellor_assignments run ${stamp}. Review before running.
BEGIN;
SET LOCAL app.skip_automation = 'true';
UPDATE v2_leads l SET counsellor_id = v.old_c, updated_at = NOW()
  FROM (VALUES
  ${pairsSql}
  ) AS v(lead_id, old_c, new_c)
 WHERE l.id = v.lead_id AND l.counsellor_id = v.new_c;
DELETE FROM timelines WHERE id IN (${tlIds.join(',')}) AND created_by IS NULL AND metadata->>'assignmentMethod' = 'data_fix';
-- Expect UPDATE ${plan.length} and DELETE ${plan.length}. If not, run ROLLBACK; instead of COMMIT.
COMMIT;
`);
    fs.writeFileSync(path.join(runDir, 'applied.csv'), csvOut(['lead_id', 'old_counsellor_id', 'new_counsellor_id', 'source_timeline_id', 'new_timeline_id'],
      plan.map(p => ({ lead_id: p.leadId, old_counsellor_id: p.oldC, new_counsellor_id: p.newC, source_timeline_id: p.srcTl,
        new_timeline_id: tl.rows.find(r => r.v2_lead_id === p.leadId)?.id }))));

    await c.query('COMMIT');
    committed = true;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
    fail(`${e.message}\nTransaction rolled back. Files in ${runDir} are for diagnosis only.`);
  }

  // 7) Fresh post-commit verification on the same connection (new snapshot).
  const post = (await c.query(
    `SELECT count(*) FILTER (WHERE l.counsellor_id = p.new_c)::int AS correct, count(*)::int AS total
       FROM unnest($1::int[], $2::int[]) AS p(lead_id, new_c) JOIN v2_leads l ON l.id = p.lead_id`,
    [params[0], params[2]])).rows[0];
  await c.end();
  log(`\nCOMMITTED. Post-check: ${post.correct}/${post.total} leads now have the expected counsellor.`);
  log(`Run files (backup, applied list, rollback.sql): ${runDir}`);
  if (!committed || post.correct !== plan.length) { console.error('WARNING: post-check mismatch, share this output immediately.'); process.exit(3); }
})().catch(e => fail(e.message));
