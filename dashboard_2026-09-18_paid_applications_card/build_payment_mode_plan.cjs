// READ-ONLY: builds the review sheet for UG paid applications whose payment_mode
// is blank in v2 but present in v1.
//
// Scope: org 12 / school 18, forms 104 (UG School of Business) and 105 (UG DS&AI),
// type='applicant', not deleted, status='active', payment_status completed/paid,
// payment_mode IS NULL, and linked to a v1 application (v1_application_id).
//
// Source of truth: v1 "ApplicationManager"."paymentMethod" for that application id.
// v1 stores it capitalised ('Online', 'Coupon'); v2's own rows are lowercase, and
// the applicants listing filters on LOWER(payment_mode), so we write lowercase.
//
// Anything whose v1 value is missing, unrecognised, or whose v1 payment status is
// not completed is held back as REVIEW rather than guessed.
//
// Usage: node build_payment_mode_plan.cjs [output.csv]
// Writes the full sheet plus <output>_for_review.csv (rows to fix, no ids).
const path = require('path');
const fs = require('fs');

const BACKEND = path.join(__dirname, '..', 'new_crm_backend');
const OLD = path.join(__dirname, '..', 'old_crm_backend');
const dotenv = require(path.join(BACKEND, 'node_modules', 'dotenv'));
const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));

const env2 = dotenv.parse(fs.readFileSync(path.join(BACKEND, '.env')));
const env1 = dotenv.parse(fs.readFileSync(path.join(OLD, '.env')));

const OUT = process.argv[2] || path.join(__dirname, 'ug_payment_mode_plan.csv');
const OUT_REVIEW = OUT.replace(/\.csv$/i, '') + '_for_review.csv';

const VALID_MODES = new Set(['online', 'offline', 'cash', 'coupon']);

const mk = (e) => new Client({
  host: (e.DB_READ_HOST || e.DB_HOST).trim(),
  port: Number(e.DB_PORT) || 5432,
  user: e.DB_USER.trim(),
  database: e.DB_NAME.trim(),
  password: e.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

const V2_SQL = `
SELECT l.id, l.v1_lead_id, l.v1_application_id, l.application_number,
       l.registered_name, l.registered_email, l.program_id, l.form_id,
       l.payment_status, l.payment_mode, l.payment_completed_at, l.created_at,
       p.name AS programme
  FROM v2_leads l
  LEFT JOIN programs p ON p.id = l.program_id
 WHERE l.org_id = 12 AND l.school_id = 18 AND l.form_id IN (104, 105)
   AND l.type = 'applicant' AND l.is_deleted = false AND l.status = 'active'
   AND (l.payment_status ILIKE 'completed' OR l.payment_status ILIKE 'paid')
   AND l.payment_mode IS NULL
   AND l.v1_application_id IS NOT NULL
 ORDER BY l.form_id, l.id`;

const V1_SQL = `
SELECT am.id, am."paymentMethod", am."paymentStatus", am."applicationNum", am."updatedAt"
  FROM "ApplicationManager" am
 WHERE am.id = ANY($1::bigint[])`;

const ist = (d) => (d ? new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' IST' : '');

(async () => {
  const v2 = mk(env2);
  await v2.connect();
  await v2.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  await v2.query("SET statement_timeout='300s'");
  const { rows } = await v2.query(V2_SQL);
  await v2.end();

  const appIds = rows.map(r => Number(r.v1_application_id));
  const v1 = mk(env1);
  await v1.connect();
  await v1.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  await v1.query("SET statement_timeout='300s'");
  const v1Rows = (await v1.query(V1_SQL, [appIds])).rows;
  await v1.end();

  const byId = new Map(v1Rows.map(r => [String(r.id), r]));

  const out = rows.map((r) => {
    const src = byId.get(String(r.v1_application_id));
    const rawMode = src && src.paymentMethod != null ? String(src.paymentMethod).trim() : '';
    const mode = rawMode.toLowerCase();
    const v1Paid = src && /^(completed|paid)$/i.test(String(src.paymentStatus || '').trim());

    let status;
    if (!src) status = 'REVIEW_NOT_FOUND_IN_V1';
    else if (!rawMode) status = 'REVIEW_NO_MODE_IN_V1';
    else if (!VALID_MODES.has(mode)) status = 'REVIEW_UNKNOWN_MODE';
    else if (!v1Paid) status = 'REVIEW_V1_NOT_PAID';
    else status = 'FIX';

    return {
      status,
      proposed_action: status === 'FIX' ? `set payment mode to "${mode}"` : 'hold for review',
      student_name: r.registered_name,
      student_email: r.registered_email,
      programme: r.programme,
      application_number: r.application_number || '(none)',
      payment_status: r.payment_status,
      current_payment_mode: '(blank)',
      payment_mode_in_old_crm: rawMode || '(blank)',
      new_payment_mode: status === 'FIX' ? mode : '',
      payment_date: ist(r.payment_completed_at) || '(not recorded)',
      registered_on: ist(r.created_at),
      v2_lead_id: r.id, form_id: r.form_id, program_id: r.program_id,
      v1_lead_id: r.v1_lead_id, v1_application_id: r.v1_application_id,
      verification_verdict: '', verification_comment: '',
    };
  });

  out.sort((a, b) => (a.status === b.status ? a.v2_lead_id - b.v2_lead_id : a.status === 'FIX' ? -1 : 1));

  const cols = Object.keys(out[0]);
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const toCsv = (cs, rs) => '﻿' + [cs.join(','), ...rs.map(r => cs.map(k => esc(r[k])).join(','))].join('\r\n') + '\r\n';
  fs.writeFileSync(OUT, toCsv(cols, out));

  const DEV_ONLY = new Set(['status', 'proposed_action', 'v2_lead_id', 'form_id', 'program_id',
    'v1_lead_id', 'v1_application_id']);
  const reviewCols = cols.filter(k => !DEV_ONLY.has(k));
  const reviewRows = out.filter(r => r.status === 'FIX');
  fs.writeFileSync(OUT_REVIEW, toCsv(reviewCols, reviewRows));

  const tally = {};
  for (const r of out) {
    const k = `${r.status} | ${r.new_payment_mode || '-'}`;
    tally[k] = (tally[k] || 0) + 1;
  }
  console.log(`rows in scope: ${out.length} -> ${OUT}`);
  console.table(tally);
  console.log(`rows to fix: ${reviewRows.length} -> ${OUT_REVIEW}`);
})().catch(e => { console.error(e.message); process.exit(1); });
