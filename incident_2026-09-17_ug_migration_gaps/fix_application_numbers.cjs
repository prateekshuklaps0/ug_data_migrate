// Fills the missing application_number on UG applications (org 12 / school 18, programmes 94 and 95).
//
// Plan = the status=FIX rows of ug_application_number_plan.csv (built by build_application_number_plan.cjs).
// Numbering copies the app exactly (src/models/V2Lead.js -> assignApplicationNumber):
//   <applicationForms.applicationPrefix>-<nextval('application_number_seq')>, retried if that number
//   is already taken. Deleted rows (SKIP_DELETED) are never touched.
//
// SAFETY
//  - Default is a DRY RUN (read-only session). Nothing is written unless --apply is passed.
//    A dry run consumes no sequence numbers; it only reports what it would do.
//  - Every row is re-checked in the transaction with the row locked: exists, org 12 / school 18,
//    programme 94 or 95, type = 'applicant', not deleted, application_number still empty,
//    form_id unchanged and its prefix still the one in the sheet.
//    If ANY row fails, --apply aborts and changes nothing (all or nothing).
//  - app.skip_automation is set for the transaction, so filling a blank field fires no workflows.
//  - One transaction: UPDATE + timeline rows + in-transaction verification. Any mismatch => ROLLBACK.
//  - Before COMMIT it writes a backup, the applied list and rollback.sql into runs/<timestamp>/.
//  - Only application_number and updated_at change.
//
// Usage (from this folder):
//   node fix_application_numbers.cjs            dry run
//   node fix_application_numbers.cjs --apply    apply
// Options: --csv <path>, --env <path>
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const APPLY = args.includes('--apply');
const CSV_PATH = path.resolve(argVal('--csv') || path.join(__dirname, 'ug_application_number_plan.csv'));
const BACKEND = path.join(__dirname, '..', 'new_crm_backend');
const ENV_PATH = path.resolve(argVal('--env') || path.join(BACKEND, '.env'));

require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: ENV_PATH });
const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));

const ORG_ID = 12;
const SCHOOL_ID = 18;
const PROGRAMMES = [94, 95];
const EXPECTED_COUNT = 10;
const SEQUENCE = 'application_number_seq';
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
  const need = ['status', 'v2_lead_id', 'new_number_prefix', 'form_id'];
  const idx = Object.fromEntries(need.map(k => [k, header.indexOf(k)]));
  for (const k of need) if (idx[k] < 0) fail(`CSV is missing column "${k}". Use the full plan CSV, not the review copy.`);
  const plan = []; const seen = new Set();
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    if (r.length !== header.length) fail(`CSV line ${line} has ${r.length} columns, header has ${header.length} (file edited?)`);
    if (r[idx.status] !== 'FIX') return;
    const id = Number(r[idx.v2_lead_id]);
    const formId = Number(r[idx.form_id]);
    const prefix = String(r[idx.new_number_prefix]).trim();
    if (!Number.isInteger(id) || id <= 0) fail(`CSV line ${line}: bad v2_lead_id`);
    if (!Number.isInteger(formId) || formId <= 0) fail(`CSV line ${line}: bad form_id`);
    if (!/^[A-Za-z0-9/_-]{1,32}$/.test(prefix)) fail(`CSV line ${line}: suspicious prefix "${prefix}"`);
    if (seen.has(id)) fail(`lead ${id} appears twice in CSV`);
    seen.add(id); plan.push({ id, formId, prefix });
  });
  if (plan.length !== EXPECTED_COUNT) fail(`CSV has ${plan.length} FIX rows, expected exactly ${EXPECTED_COUNT}`);
  return plan;
};

const LIVE_SQL = (lock) => `
WITH p AS (SELECT * FROM unnest($1::int[], $2::int[], $3::text[]) AS p(lead_id, form_id, prefix)),
lead AS (
  SELECT l.id, l.org_id, l.school_id, l.program_id, l.type::text AS type, l.is_deleted, l.form_id,
         coalesce(l.application_number,'') AS app_no
    FROM v2_leads l WHERE l.id = ANY($1::int[]) ORDER BY l.id ${lock ? 'FOR UPDATE OF l' : ''}
)
SELECT p.lead_id, p.form_id, p.prefix,
       lead.id IS NOT NULL AS lead_exists, lead.org_id, lead.school_id, lead.program_id, lead.type,
       lead.is_deleted, lead.form_id AS live_form_id, lead.app_no,
       coalesce(nullif(btrim(f."applicationPrefix"),''), nullif(btrim(f."applicationInitials"),''), 'NA') AS live_prefix
  FROM p
  LEFT JOIN lead ON lead.id = p.lead_id
  LEFT JOIN "applicationForms" f ON f.id = lead.form_id
 ORDER BY p.lead_id`;

const checkLive = (rows) => {
  const problems = [];
  for (const r of rows) {
    const why = [];
    if (!r.lead_exists) why.push('lead not found');
    else {
      if (r.org_id !== ORG_ID || r.school_id !== SCHOOL_ID) why.push(`org/school is ${r.org_id}/${r.school_id}`);
      if (!PROGRAMMES.includes(r.program_id)) why.push(`programme is ${r.program_id}`);
      if (r.type !== 'applicant') why.push(`type is "${r.type}", not applicant`);
      if (r.is_deleted) why.push('application is deleted now');
      if (r.app_no !== '') why.push(`already has a number: ${r.app_no}`);
      if (r.live_form_id !== r.form_id) why.push(`form changed: now ${r.live_form_id}, sheet said ${r.form_id}`);
      if (r.live_prefix !== r.prefix) why.push(`form prefix is now "${r.live_prefix}", sheet said "${r.prefix}"`);
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
    application_name: 'fix_application_numbers_ug',
  });
  await c.connect();
  const params = [plan.map(p => p.id), plan.map(p => p.formId), plan.map(p => p.prefix)];

  if (!APPLY) {
    await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    const { rows } = await c.query(LIVE_SQL(false), params);
    const seq = (await c.query(`SELECT last_value, is_called FROM ${SEQUENCE}`)).rows[0];
    await c.end();
    const problems = checkLive(rows);
    if (problems.length) {
      console.table(problems.slice(0, 50));
      log(`\nDRY RUN: ${problems.length} row(s) FAILED checks. --apply would ABORT. Do not apply; share this output.`);
      process.exit(2);
    }
    const start = Number(seq.last_value) + (seq.is_called ? 1 : 0);
    log(`\nDRY RUN OK: all ${rows.length} applications passed every check. Nothing was written.`);
    log(`Numbers would run from about ${rows[0].prefix}-${start} (sequence is at ${seq.last_value}).`);
    log('To apply: node fix_application_numbers.cjs --apply');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(__dirname, 'runs', stamp);
  fs.mkdirSync(runDir, { recursive: true });

  const assigned = [];
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

    fs.writeFileSync(path.join(runDir, 'backup_before.csv'), csvOut(['v2_lead_id', 'application_number_before'],
      live.map(r => ({ v2_lead_id: r.lead_id, application_number_before: '' }))));

    // One number per row, from the same sequence the app uses; retried if the value is already taken.
    for (const p of plan) {
      let number = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        const seq = (await c.query(`SELECT nextval('${SEQUENCE}') AS v`)).rows[0].v;
        const candidate = `${p.prefix}-${seq}`;
        const taken = (await c.query(`SELECT 1 FROM v2_leads WHERE application_number = $1 LIMIT 1`, [candidate])).rowCount;
        if (!taken) { number = candidate; break; }
      }
      if (!number) throw new Error(`could not find a free application number for lead ${p.id} after 10 tries`);
      const upd = await c.query(
        `UPDATE v2_leads SET application_number = $1, updated_at = NOW()
          WHERE id = $2 AND org_id = ${ORG_ID} AND school_id = ${SCHOOL_ID} AND is_deleted = false
            AND type = 'applicant' AND (application_number IS NULL OR application_number = '')
        RETURNING id`, [number, p.id]);
      if (upd.rowCount !== 1) throw new Error(`UPDATE touched ${upd.rowCount} rows for lead ${p.id}, expected 1`);
      assigned.push({ id: p.id, number });
    }

    const tl = await c.query(
      `INSERT INTO timelines (v2_lead_id, org_id, school_id, event_type, title, description, metadata, created_by, created_at, updated_at)
       SELECT l.id, l.org_id, l.school_id, 'updated', 'Lead Updated',
              'Set Application Number to "' || p.number || '" - data fix: number was missing on this application',
              jsonb_build_object('fields', jsonb_build_array('applicationNumber'),
                                 'newApplicationNumber', p.number,
                                 'source', 'data_fix_missing_application_number'),
              NULL, NOW(), NOW()
         FROM unnest($1::int[], $2::text[]) AS p(lead_id, number)
         JOIN v2_leads l ON l.id = p.lead_id
    RETURNING id`, [assigned.map(a => a.id), assigned.map(a => a.number)]);
    if (tl.rowCount !== plan.length) throw new Error(`timeline INSERT created ${tl.rowCount} rows, expected ${plan.length}`);

    const ver = (await c.query(
      `SELECT count(*)::int AS ok FROM v2_leads l
         JOIN unnest($1::int[], $2::text[]) AS p(lead_id, number) ON p.lead_id = l.id
        WHERE l.application_number = p.number`, [assigned.map(a => a.id), assigned.map(a => a.number)])).rows[0].ok;
    if (ver !== plan.length) throw new Error(`verification: ${ver} rows carry their number, expected ${plan.length}`);
    const dupes = (await c.query(
      `SELECT count(*)::int AS n FROM v2_leads WHERE application_number = ANY($1::text[])`, [assigned.map(a => a.number)])).rows[0].n;
    if (dupes !== plan.length) throw new Error(`${dupes} rows carry these numbers, expected ${plan.length} (duplicate created)`);
    const auto = (await c.query(
      `SELECT count(*)::int AS n FROM automation_events WHERE table_name='v2_leads' AND row_id = ANY($1::bigint[]) AND created_at >= $2`,
      [params[0], txStart])).rows[0].n;
    if (auto !== 0) throw new Error(`${auto} automation events were emitted; suppression did not work`);

    fs.writeFileSync(path.join(runDir, 'rollback.sql'),
`-- Rollback for fix_application_numbers run ${stamp}. Review before running.
-- Note: the sequence is not rewound; those numbers stay used, which is harmless.
BEGIN;
SET LOCAL app.skip_automation = 'true';
UPDATE v2_leads l SET application_number = NULL, updated_at = NOW()
  FROM (VALUES
  ${assigned.map(a => `(${a.id},'${a.number}')`).join(',\n  ')}
  ) AS v(lead_id, number)
 WHERE l.id = v.lead_id AND l.application_number = v.number;
DELETE FROM timelines WHERE id IN (${tl.rows.map(r => r.id).join(',')}) AND created_by IS NULL
   AND metadata->>'source' = 'data_fix_missing_application_number';
-- Expect UPDATE ${plan.length} and DELETE ${plan.length}. If not, run ROLLBACK; instead of COMMIT.
COMMIT;
`);
    fs.writeFileSync(path.join(runDir, 'applied.csv'), csvOut(['v2_lead_id', 'application_number'],
      assigned.map(a => ({ v2_lead_id: a.id, application_number: a.number }))));

    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
    fail(`${e.message}\nTransaction rolled back. Files in ${runDir} are for diagnosis only.`);
  }

  const post = (await c.query(
    `SELECT count(*) FILTER (WHERE l.application_number IS NOT NULL AND l.application_number <> '')::int AS filled, count(*)::int AS total
       FROM v2_leads l WHERE l.id = ANY($1::int[])`, [params[0]])).rows[0];
  await c.end();
  log(`\nCOMMITTED. Post-check: ${post.filled}/${post.total} applications now have a number.`);
  assigned.forEach(a => log(`  lead ${a.id} -> ${a.number}`));
  log(`Run files (backup, applied list, rollback.sql): ${runDir}`);
  if (post.filled !== plan.length) { console.error('WARNING: post-check mismatch, share this output immediately.'); process.exit(3); }
})().catch(e => fail(e.message));
