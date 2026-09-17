// READ-ONLY: builds the review sheet for UG applications that have no application_number.
//
// Scope: org 12 / school 18, programmes 94 (School of Business) and 95 (Data Science and AI),
// type = 'applicant', application_number null or empty.
//
// Numbers are generated the way the app does it (src/models/V2Lead.js -> assignApplicationNumber):
//   <applicationForms.applicationPrefix>-<nextval('application_number_seq')>
// e.g. UG/SOB-89043. The digits are drawn at apply time, so the sheet shows the prefix and the
// next sequence value as a preview, not a reserved number.
//
// Usage: node build_application_number_plan.cjs [output.csv]
// Writes the full sheet plus <output>_for_review.csv (rows to fix, no ids).
const path = require('path');
const fs = require('fs');

const BACKEND = path.join(__dirname, '..', 'new_crm_backend');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });
const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));

const OUT = process.argv[2] || path.join(__dirname, 'ug_application_number_plan.csv');
const OUT_REVIEW = OUT.replace(/\.csv$/i, '') + '_for_review.csv';

const SQL = `
SELECT l.id, l.org_id, l.school_id, l.program_id, l.form_id, l.type, l.is_deleted,
       l.registered_name, l.registered_email, l.application_number,
       l.application_form_initiated, l.application_form_submitted,
       l.application_stage_id, l.v1_lead_id, l.v1_application_id, l.created_at, l.updated_at,
       p.name AS programme,
       coalesce(nullif(btrim(f."applicationPrefix"),''), nullif(btrim(f."applicationInitials"),''), 'NA') AS prefix,
       st."stageName" AS application_stage
  FROM v2_leads l
  LEFT JOIN programs p ON p.id = l.program_id
  LEFT JOIN "applicationForms" f ON f.id = l.form_id
  LEFT JOIN "applicationStage" st ON st.id = l.application_stage_id
 WHERE l.org_id = 12 AND l.school_id = 18 AND l.program_id IN (94,95)
   AND l.type = 'applicant'
   AND (l.application_number IS NULL OR l.application_number = '')
 ORDER BY l.program_id, l.id`;

(async () => {
  const c = new Client({
    host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    ssl: String(process.env.DB_SSL).trim() === 'true' ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  await c.query("SET statement_timeout='300s'");
  const { rows } = await c.query(SQL);
  // last_value of the sequence, read without consuming a number.
  const seq = (await c.query(`SELECT last_value, is_called FROM application_number_seq`)).rows[0];
  await c.end();

  const nextPreview = Number(seq.last_value) + (seq.is_called ? 1 : 0);
  let n = 0;
  const out = rows.map((r) => {
    const status = r.is_deleted ? 'SKIP_DELETED' : 'FIX';
    return {
      status,
      proposed_action: status === 'FIX' ? `assign application number ${r.prefix}-<next number>` : 'none',
      student_name: r.registered_name, student_email: r.registered_email, programme: r.programme,
      current_application_number: r.application_number || '(empty)',
      new_number_prefix: r.prefix,
      example_number: status === 'FIX' ? `${r.prefix}-${nextPreview + (n++)}` : '',
      application_stage: r.application_stage || '(none)',
      form_initiated: r.application_form_initiated, form_submitted: r.application_form_submitted,
      created_at: r.created_at.toISOString().slice(0, 10),
      v2_lead_id: r.id, program_id: r.program_id, form_id: r.form_id,
      v1_lead_id: r.v1_lead_id, v1_application_id: r.v1_application_id, is_deleted: r.is_deleted,
      verification_verdict: '', verification_comment: '',
    };
  });
  out.sort((a, b) => (a.status === b.status ? a.v2_lead_id - b.v2_lead_id : a.status === 'FIX' ? -1 : 1));

  const cols = Object.keys(out[0]);
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const toCsv = (cs, rs) => '﻿' + [cs.join(','), ...rs.map(r => cs.map(k => esc(r[k])).join(','))].join('\r\n') + '\r\n';
  fs.writeFileSync(OUT, toCsv(cols, out));

  const DEV_ONLY = new Set(['status', 'proposed_action', 'v2_lead_id', 'program_id', 'form_id',
    'v1_lead_id', 'v1_application_id', 'is_deleted']);
  const reviewCols = cols.filter(k => !DEV_ONLY.has(k));
  const reviewRows = out.filter(r => r.status === 'FIX');
  fs.writeFileSync(OUT_REVIEW, toCsv(reviewCols, reviewRows));

  const tally = {};
  for (const r of out) { const k = `${r.status} | ${r.programme}`; tally[k] = (tally[k] || 0) + 1; }
  console.log(`rows: ${out.length} -> ${OUT}`);
  console.table(tally);
  console.log(`sequence now at ${seq.last_value}; numbers will start around ${nextPreview}`);
  console.log(`rows to fix: ${reviewRows.length} -> ${OUT_REVIEW}`);
})().catch(e => { console.error(e.message); process.exit(1); });
