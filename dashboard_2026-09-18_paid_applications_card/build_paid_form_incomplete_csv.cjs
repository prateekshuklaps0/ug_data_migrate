// READ-ONLY: reproduces the "Total Paid Applications" card on /admin/dashboard-v2
// for the UG scope (forms 104 + 105) and lists the rows behind the
// "Form Incomplete" bar.
//
// The card is built by src/v2/services/adminDashboardV2Service.js -> getPaymentOverview
// -> fetchPaidOverviewCounts. The where clause below is that service's, spelled out:
//   org_id = 12, type = 'applicant', is_deleted = false, status = 'active',
//   form_id IN (user's allocated forms), payment_status ILIKE 'completed' OR 'paid'.
// "Form Completed" is form_percentage_filled = 100; "Form Incomplete" is 0..99.
//
// Usage: node build_paid_form_incomplete_csv.cjs [output.csv]
// Writes the full sheet plus <output>_for_review.csv (no ids).
const path = require('path');
const fs = require('fs');

const BACKEND = path.join(__dirname, '..', 'new_crm_backend');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });
const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));

const OUT = process.argv[2] || path.join(__dirname, 'ug_paid_form_incomplete.csv');
const OUT_REVIEW = OUT.replace(/\.csv$/i, '') + '_for_review.csv';

const FORM_IDS = [104, 105];

const BASE = `
  FROM v2_leads l
  LEFT JOIN programs p ON p.id = l.program_id
  LEFT JOIN users c ON c.id = l.counsellor_id
  LEFT JOIN "applicationStage" st ON st.id = l.application_stage_id
 WHERE l.org_id = 12
   AND l.form_id = ANY($1::int[])
   AND l.type = 'applicant'
   AND l.is_deleted = false
   AND l.status = 'active'
   AND (l.payment_status ILIKE 'completed' OR l.payment_status ILIKE 'paid')`;

const COUNTS_SQL = `
SELECT count(*)::int AS total,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'online')::int  AS online,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'offline')::int AS offline,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'cash')::int    AS cash,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'coupon')::int  AS coupon,
       count(*) FILTER (WHERE l.payment_mode IS NULL)::int         AS mode_missing,
       count(*) FILTER (WHERE l.form_percentage_filled = 100)::int AS form_completed,
       count(*) FILTER (WHERE l.form_percentage_filled BETWEEN 0 AND 99)::int AS form_incomplete,
       count(*) FILTER (WHERE l.form_percentage_filled IS NULL)::int AS pct_missing,
       count(*) FILTER (WHERE l.payment_completed_at IS NULL)::int AS payment_date_missing
${BASE}`;

const ROWS_SQL = `
SELECT l.id, l.form_id, l.application_number, l.registered_name, l.registered_email,
       l.registered_mobile, l.form_percentage_filled, l.payment_status, l.payment_mode,
       l.payment_completed_at, l.application_form_initiated, l.application_form_submitted,
       l.form_completion_date, l.created_at, l.v1_lead_id,
       p.name AS programme, st."stageName" AS application_stage,
       c.name AS counsellor_name, c.email AS counsellor_email
${BASE}
   AND l.form_percentage_filled BETWEEN 0 AND 99
 ORDER BY l.form_id, l.form_percentage_filled DESC, l.id`;

const ist = (d) => (d ? new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' IST' : '');
const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : '');

(async () => {
  const c = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    ssl: String(process.env.DB_SSL).trim() === 'true' ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  await c.query("SET statement_timeout='300s'");
  const counts = (await c.query(COUNTS_SQL, [FORM_IDS])).rows[0];
  const { rows } = await c.query(ROWS_SQL, [FORM_IDS]);
  await c.end();

  const out = rows.map((r) => ({
    student_name: r.registered_name,
    student_email: r.registered_email,
    student_mobile: r.registered_mobile,
    programme: r.programme,
    application_number: r.application_number || '(none)',
    form_filled_percent: `${Number(r.form_percentage_filled)}%`,
    form_ever_opened: yn(r.application_form_initiated),
    form_marked_submitted: yn(r.application_form_submitted),
    payment_status: r.payment_status,
    payment_mode: r.payment_mode || '(not recorded)',
    payment_date: ist(r.payment_completed_at) || '(not recorded)',
    counsellor: r.counsellor_name || r.counsellor_email || '(none)',
    application_stage: r.application_stage || '(none)',
    registered_on: ist(r.created_at),
    v2_lead_id: r.id, form_id: r.form_id, v1_lead_id: r.v1_lead_id,
    verification_verdict: '', verification_comment: '',
  }));

  const cols = Object.keys(out[0]);
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const toCsv = (cs, rs) => '﻿' + [cs.join(','), ...rs.map(r => cs.map(k => esc(r[k])).join(','))].join('\r\n') + '\r\n';
  fs.writeFileSync(OUT, toCsv(cols, out));

  const DEV_ONLY = new Set(['v2_lead_id', 'form_id', 'v1_lead_id']);
  fs.writeFileSync(OUT_REVIEW, toCsv(cols.filter(k => !DEV_ONLY.has(k)), out));

  console.log('Card reproduced from prod (no date filter, forms 104 + 105):');
  console.table([counts]);
  console.log(`\n${out.length} rows behind "Form Incomplete" -> ${OUT}`);
  console.log(`reviewer copy -> ${OUT_REVIEW}`);
})().catch(e => { console.error(e.message); process.exit(1); });
