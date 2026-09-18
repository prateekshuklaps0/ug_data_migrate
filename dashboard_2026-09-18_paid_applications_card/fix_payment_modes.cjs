// Fills the missing payment_mode on UG paid applications (org 12 / school 18, forms 104 and 105).
//
// Plan = the status=FIX rows of ug_payment_mode_plan.csv (built by build_payment_mode_plan.cjs).
// The value comes from v1 "ApplicationManager"."paymentMethod" for the linked application,
// lowercased to match v2's own convention ('online', 'coupon') and the applicants listing,
// which filters on LOWER(payment_mode).
//
// This only fills a BLANK field. It never overwrites a mode v2 already has.
//
// SAFETY
//  - Default is a DRY RUN (read-only session). Nothing is written unless --apply is passed.
//  - Every row is re-checked in the transaction with the row locked: exists, org 12 / school 18,
//    form 104 or 105, type = 'applicant', not deleted, status = 'active', payment still
//    completed/paid, payment_mode still blank, and the same v1_application_id as the sheet.
//    If ANY row fails, --apply aborts and changes nothing (all or nothing). If the data has
//    moved on, rebuild the plan CSV and get it signed off again.
//  - app.skip_automation is set for the transaction, so filling a blank field fires no workflows.
//  - One transaction: UPDATE + timeline rows + in-transaction verification. Any mismatch => ROLLBACK.
//  - Before COMMIT it writes a backup, the applied list and rollback.sql into runs/<timestamp>/.
//  - Only payment_mode and updated_at change. payment_completed_at is NOT touched — that is a
//    separate, more careful pass.
//
// Usage (from this folder):
//   node fix_payment_modes.cjs            dry run
//   node fix_payment_modes.cjs --apply    apply
// Options: --csv <path>, --env <path>
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = args.includes('--apply');
const CSV_PATH = path.resolve(argVal('--csv') || path.join(__dirname, 'ug_payment_mode_plan.csv'));
const BACKEND = path.join(__dirname, '..', 'new_crm_backend');
const ENV_PATH = path.resolve(argVal('--env') || path.join(BACKEND, '.env'));

require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: ENV_PATH });
const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));

const ORG_ID = 12;
const SCHOOL_ID = 18;
const FORMS = [104, 105];
const EXPECTED_COUNT = 536;
const VALID_MODES = new Set(['online', 'offline', 'cash', 'coupon']);
const PROD_HOST = 'anandi.c1nvajieufmh.ap-south-1.rds.amazonaws.com';
const ALLOWED_HOSTS = [PROD_HOST, ...(process.env.FIX_ALLOW_TEST_HOST ? [process.env.FIX_ALLOW_TEST_HOST] : [])];

const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(`\nABORTED: ${msg}\nNothing was changed.`); process.exit(1); };

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
  const need = ['status', 'v2_lead_id', 'new_payment_mode', 'v1_application_id'];
  const idx = Object.fromEntries(need.map(k => [k, header.indexOf(k)]));
  for (const k of need) if (idx[k] < 0) fail(`CSV is missing column "${k}". Use the full plan CSV, not the review copy.`);
  const plan = []; const seen = new Set();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    if (r.length !== header.length) fail(`CSV line ${line} has ${r.length} columns, header has ${header.length} (file edited?)`);
    if (r[idx.status] !== 'FIX') return;
    const id = Number(r[idx.v2_lead_id]);
    const appId = Number(r[idx.v1_application_id]);
    const mode = String(r[idx.new_payment_mode]).trim();
    if (!Number.isInteger(id) || id <= 0) fail(`CSV line ${line}: bad v2_lead_id`);
    if (!Number.isInteger(appId) || appId <= 0) fail(`CSV line ${line}: bad v1_application_id`);
    if (!VALID_MODES.has(mode)) fail(`CSV line ${line}: payment mode "${mode}" is not one of ${[...VALID_MODES].join(', ')}`);
    if (seen.has(id)) fail(`lead ${id} appears twice in CSV`);
    seen.add(id); plan.push({ id, appId, mode });
  });
  if (plan.length !== EXPECTED_COUNT) fail(`CSV has ${plan.length} FIX rows, expected exactly ${EXPECTED_COUNT}`);
  return plan;
};

const LIVE_SQL = (lock) => `
WITH p AS (SELECT * FROM unnest($1::int[], $2::bigint[], $3::text[]) AS p(lead_id, app_id, mode)),
lead AS (
  SELECT l.id, l.org_id, l.school_id, l.form_id, l.type::text AS type, l.is_deleted,
         l.status::text AS status, coalesce(l.payment_status,'') AS payment_status,
         coalesce(l.payment_mode,'') AS payment_mode, l.v1_application_id
    FROM v2_leads l WHERE l.id = ANY($1::int[]) ORDER BY l.id ${lock ? 'FOR UPDATE OF l' : ''}
)
SELECT p.lead_id, p.app_id, p.mode,
       lead.id IS NOT NULL AS lead_exists, lead.org_id, lead.school_id, lead.form_id, lead.type,
       lead.is_deleted, lead.status, lead.payment_status, lead.payment_mode, lead.v1_application_id
  FROM p LEFT JOIN lead ON lead.id = p.lead_id
 ORDER BY p.lead_id`;

const checkLive = (rows) => {
  const problems = [];
  for (const r of rows) {
    const why = [];
    if (!r.lead_exists) why.push('lead not found');
    else {
      if (r.org_id !== ORG_ID || r.school_id !== SCHOOL_ID) why.push(`org/school is ${r.org_id}/${r.school_id}`);
      if (!FORMS.includes(r.form_id)) why.push(`form is ${r.form_id}`);
      if (r.type !== 'applicant') why.push(`type is "${r.type}", not applicant`);
      if (r.is_deleted) why.push('application is deleted now');
      if (r.status !== 'active') why.push(`status is "${r.status}", not active`);
      if (!/^(completed|paid)$/i.test(r.payment_status)) why.push(`payment status is "${r.payment_status}"`);
      if (r.payment_mode !== '') why.push(`payment mode is no longer blank: "${r.payment_mode}"`);
      if (String(r.v1_application_id) !== String(r.app_id)) why.push(`v1 application link changed: now ${r.v1_application_id}, sheet said ${r.app_id}`);
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

  const tally = plan.reduce((a, p) => (a[p.mode] = (a[p.mode] || 0) + 1, a), {});
  log(`Mode      : ${APPLY ? 'APPLY (will write)' : 'DRY RUN (read-only, nothing is written)'}`);
  log(`Database  : ${process.env.DB_USER}@${host}/${process.env.DB_NAME}`);
  log(`CSV       : ${CSV_PATH}`);
  log(`Planned   : ${plan.length} applications  (${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join(', ')})`);

  const c = new Client({
    host, port: Number(process.env.DB_PORT) || 5432, user: (process.env.DB_USER || '').trim(),
    password: process.env.DB_PASSWORD, database: (process.env.DB_NAME || '').trim(),
    ssl: String(process.env.DB_SSL).trim() === 'true' ? { rejectUnauthorized: false } : false,
    application_name: 'fix_payment_modes_ug',
  });
  await c.connect();
  const params = [plan.map(p => p.id), plan.map(p => p.appId), plan.map(p => p.mode)];
  // Queries that do not need the v1 link get their own pair, because Postgres rejects a
  // prepared statement that carries a parameter it never references.
  const idMode = [plan.map(p => p.id), plan.map(p => p.mode)];

  if (!APPLY) {
    await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    const { rows } = await c.query(LIVE_SQL(false), params);
    await c.end();
    const problems = checkLive(rows);
    if (problems.length) {
      console.table(problems.slice(0, 50));
      log(`\nDRY RUN: ${problems.length} row(s) FAILED checks. --apply would ABORT.`);
      log('Rebuild the plan (node build_payment_mode_plan.cjs), get it signed off again, then retry.');
      process.exit(2);
    }
    log(`\nDRY RUN OK: all ${rows.length} applications passed every check. Nothing was written.`);
    log('To apply: node fix_payment_modes.cjs --apply');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(__dirname, 'runs', stamp);
  fs.mkdirSync(runDir, { recursive: true });

  let timelineIds = [];
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL app.skip_automation = 'true'`);
    await c.query(`SET LOCAL lock_timeout = '15s'`);
    await c.query(`SET LOCAL statement_timeout = '300s'`);
    const txStart = (await c.query('SELECT now() AS t')).rows[0].t;

    const live = (await c.query(LIVE_SQL(true), params)).rows;
    if (live.length !== plan.length) throw new Error(`live check returned ${live.length} rows, expected ${plan.length}`);
    const problems = checkLive(live);
    if (problems.length) {
      fs.writeFileSync(path.join(runDir, 'failed_checks.csv'), csvOut(['v2_lead_id', 'reason'], problems));
      throw new Error(`${problems.length} row(s) failed checks (see ${path.join(runDir, 'failed_checks.csv')})`);
    }

    // payment_mode was blank on every row that passed the checks; the backup records that.
    fs.writeFileSync(path.join(runDir, 'backup_before.csv'), csvOut(
      ['v2_lead_id', 'payment_mode_before', 'payment_status_before', 'v1_application_id'],
      live.map(r => ({ v2_lead_id: r.lead_id, payment_mode_before: '', payment_status_before: r.payment_status, v1_application_id: r.v1_application_id }))));

    const upd = await c.query(
      `UPDATE v2_leads l SET payment_mode = p.mode, updated_at = NOW()
         FROM unnest($1::int[], $2::text[]) AS p(lead_id, mode)
        WHERE l.id = p.lead_id
          AND l.org_id = ${ORG_ID} AND l.school_id = ${SCHOOL_ID}
          AND l.form_id = ANY(ARRAY[${FORMS.join(',')}]::int[])
          AND l.type = 'applicant' AND l.is_deleted = false AND l.status = 'active'
          AND l.payment_mode IS NULL
       RETURNING l.id`, idMode);
    if (upd.rowCount !== plan.length) throw new Error(`UPDATE touched ${upd.rowCount} rows, expected ${plan.length}`);

    const tl = await c.query(
      `INSERT INTO timelines (v2_lead_id, org_id, school_id, event_type, title, description, metadata, created_by, created_at, updated_at)
       SELECT l.id, l.org_id, l.school_id, 'updated', 'Lead Updated',
              'Set Payment Mode to "' || p.mode || '" - data fix: mode was not copied from the old CRM',
              jsonb_build_object('fields', jsonb_build_array('paymentMode'),
                                 'newPaymentMode', p.mode,
                                 'source', 'data_fix_missing_payment_mode'),
              NULL, NOW(), NOW()
         FROM unnest($1::int[], $2::text[]) AS p(lead_id, mode)
         JOIN v2_leads l ON l.id = p.lead_id
    RETURNING id`, idMode);
    if (tl.rowCount !== plan.length) throw new Error(`timeline INSERT created ${tl.rowCount} rows, expected ${plan.length}`);
    timelineIds = tl.rows.map(r => r.id);

    const ver = (await c.query(
      `SELECT count(*)::int AS ok FROM v2_leads l
         JOIN unnest($1::int[], $2::text[]) AS p(lead_id, mode) ON p.lead_id = l.id
        WHERE l.payment_mode = p.mode`, idMode)).rows[0].ok;
    if (ver !== plan.length) throw new Error(`verification: ${ver} rows carry their mode, expected ${plan.length}`);

    const collateral = (await c.query(
      `SELECT count(*)::int AS n FROM v2_leads
        WHERE updated_at >= $1 AND id <> ALL($2::int[])
          AND org_id = ${ORG_ID} AND school_id = ${SCHOOL_ID}
          AND form_id = ANY(ARRAY[${FORMS.join(',')}]::int[])`, [txStart, params[0]])).rows[0].n;
    if (collateral !== 0) log(`NOTE: ${collateral} other UG row(s) were updated by the app during this transaction (not by us).`);

    const auto = (await c.query(
      `SELECT count(*)::int AS n FROM automation_events WHERE table_name='v2_leads' AND row_id = ANY($1::bigint[]) AND created_at >= $2`,
      [params[0], txStart])).rows[0].n;
    if (auto !== 0) throw new Error(`${auto} automation events were emitted; suppression did not work`);

    fs.writeFileSync(path.join(runDir, 'rollback.sql'),
`-- Rollback for fix_payment_modes run ${stamp}. Review before running.
-- Puts payment_mode back to NULL on exactly the rows this run filled.
BEGIN;
SET LOCAL app.skip_automation = 'true';
UPDATE v2_leads l SET payment_mode = NULL, updated_at = NOW()
  FROM (VALUES
  ${plan.map(p => `(${p.id},'${p.mode}')`).join(',\n  ')}
  ) AS v(lead_id, mode)
 WHERE l.id = v.lead_id AND l.payment_mode = v.mode;
DELETE FROM timelines WHERE id IN (${timelineIds.join(',')}) AND created_by IS NULL
   AND metadata->>'source' = 'data_fix_missing_payment_mode';
-- Expect UPDATE ${plan.length} and DELETE ${plan.length}. If not, run ROLLBACK; instead of COMMIT.
COMMIT;
`);
    fs.writeFileSync(path.join(runDir, 'applied.csv'), csvOut(['v2_lead_id', 'payment_mode', 'v1_application_id'],
      plan.map(p => ({ v2_lead_id: p.id, payment_mode: p.mode, v1_application_id: p.appId }))));

    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
    fail(`${e.message}\nTransaction rolled back. Files in ${runDir} are for diagnosis only.`);
  }

  const post = (await c.query(
    `SELECT count(*) FILTER (WHERE payment_mode IS NOT NULL)::int AS filled, count(*)::int AS total
       FROM v2_leads WHERE id = ANY($1::int[])`, [params[0]])).rows[0];
  const card = (await c.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE payment_mode ILIKE 'online')::int AS online,
            count(*) FILTER (WHERE payment_mode ILIKE 'coupon')::int AS coupon,
            count(*) FILTER (WHERE payment_mode IS NULL)::int AS still_blank
       FROM v2_leads
      WHERE org_id = ${ORG_ID} AND school_id = ${SCHOOL_ID}
        AND form_id = ANY(ARRAY[${FORMS.join(',')}]::int[])
        AND type = 'applicant' AND is_deleted = false AND status = 'active'
        AND (payment_status ILIKE 'completed' OR payment_status ILIKE 'paid')`)).rows[0];
  await c.end();
  log(`\nCOMMITTED. Post-check: ${post.filled}/${post.total} applications now have a payment mode.`);
  log(`Dashboard card now reads: Total ${card.total}, Online ${card.online}, Coupon ${card.coupon}, still blank ${card.still_blank}.`);
  log(`Run files (backup, applied list, rollback.sql): ${runDir}`);
  if (post.filled !== plan.length) { console.error('WARNING: post-check mismatch, share this output immediately.'); process.exit(3); }
})().catch(e => fail(e.message));
