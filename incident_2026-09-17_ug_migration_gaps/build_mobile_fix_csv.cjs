// READ-ONLY: builds the review sheet for the UG mobile-number fix (Option B).
//
// Scope: migrated UG applications (org 12, school 18, programmes 94 + 95, v1_application_id present)
// whose v2_leads.registered_mobile differs from the linked student's login number (users.phone).
// Plan: registered_mobile <- login number, and the old lead number is preserved in alternate_mobile_number.
//
// Statuses:
//   FIX                        - straightforward: alternate number is empty, or already holds the login number (a swap)
//   REVIEW_NUMBER_ALREADY_USED - another live lead in the same programme already carries that login number
//   REVIEW_ALT_HAS_OTHER_NUMBER- alternate number holds a third number we would have to overwrite
//   SKIP_DELETED               - the application is deleted in v2; left alone
//
// Usage: node build_mobile_fix_csv.cjs [output.csv]
// Writes the full sheet plus <output>_for_review.csv (rows to fix, no ids).
const path = require('path');
const fs = require('fs');

const BACKEND = path.join(__dirname, '..', 'new_crm_backend');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });
const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));

const OUT = process.argv[2] || path.join(__dirname, 'ug_mobile_fix_plan.csv');
const OUT_REVIEW = OUT.replace(/\.csv$/i, '') + '_for_review.csv';

const SQL = `
WITH scope AS (
  SELECT l.id, l.org_id, l.program_id, l.form_id, l.is_deleted, l.application_number,
         l.registered_name, l.registered_email, l.registered_mobile, l.country_code,
         l.alternate_mobile_number, l.user_id, l.v1_lead_id, l.v1_application_id, l.created_at,
         u.phone AS login_phone, u.country_code AS login_country_code
    FROM v2_leads l
    JOIN users u ON u.id = l.user_id
   WHERE l.org_id = 12 AND l.school_id = 18 AND l.program_id IN (94,95)
     AND l.v1_application_id IS NOT NULL AND u.phone IS NOT NULL
     AND right(regexp_replace(l.registered_mobile,'\\D','','g'),10)
         IS DISTINCT FROM right(regexp_replace(u.phone,'\\D','','g'),10)
)
SELECT s.*, p.name AS programme,
       (SELECT count(*) FROM v2_leads o
         WHERE o.id <> s.id AND o.org_id = s.org_id AND o.program_id = s.program_id AND NOT o.is_deleted
           AND right(regexp_replace(o.registered_mobile,'\\D','','g'),10)
               = right(regexp_replace(s.login_phone,'\\D','','g'),10))::int AS same_number_elsewhere
  FROM scope s LEFT JOIN programs p ON p.id = s.program_id
 ORDER BY s.program_id, s.id`;

const d10 = (v) => (v ? String(v).replace(/\D/g, '').slice(-10) : '');

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
  await c.end();

  const out = rows.map((r) => {
    const altHasThird = r.alternate_mobile_number && d10(r.alternate_mobile_number) !== d10(r.login_phone);
    let status;
    if (r.is_deleted) status = 'SKIP_DELETED';
    else if (r.same_number_elsewhere > 0) status = 'REVIEW_NUMBER_ALREADY_USED';
    else if (altHasThird) status = 'REVIEW_ALT_HAS_OTHER_NUMBER';
    else status = 'FIX';
    // The old lead number is preserved only where that does not destroy a different number.
    const newAlt = altHasThird ? r.alternate_mobile_number : r.registered_mobile;
    return {
      status,
      proposed_action: status === 'FIX'
        ? `mobile ${d10(r.registered_mobile)} -> ${d10(r.login_phone)}, old number kept as alternate`
        : 'none',
      student_name: r.registered_name, student_email: r.registered_email, programme: r.programme,
      current_mobile: d10(r.registered_mobile), correct_mobile_student_logs_in_with: d10(r.login_phone),
      current_alternate_mobile: d10(r.alternate_mobile_number), alternate_mobile_after_fix: d10(newAlt),
      old_number_preserved: status === 'FIX' ? (altHasThird ? 'no' : 'yes') : '',
      application_number: r.application_number, v2_lead_id: r.id, program_id: r.program_id, form_id: r.form_id,
      is_deleted: r.is_deleted, user_id: r.user_id, v1_lead_id: r.v1_lead_id, v1_application_id: r.v1_application_id,
      same_number_elsewhere: r.same_number_elsewhere,
      created_at: r.created_at.toISOString().slice(0, 10),
      verification_verdict: '', verification_comment: '',
    };
  });
  const order = { FIX: 0, REVIEW_NUMBER_ALREADY_USED: 1, REVIEW_ALT_HAS_OTHER_NUMBER: 2, SKIP_DELETED: 3 };
  out.sort((a, b) => order[a.status] - order[b.status] || a.v2_lead_id - b.v2_lead_id);

  const cols = Object.keys(out[0]);
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const toCsv = (cs, rs) => '﻿' + [cs.join(','), ...rs.map(r => cs.map(k => esc(r[k])).join(','))].join('\r\n') + '\r\n';
  fs.writeFileSync(OUT, toCsv(cols, out));

  const DEV_ONLY = new Set(['status', 'proposed_action', 'application_number', 'v2_lead_id', 'program_id', 'form_id',
    'user_id', 'v1_lead_id', 'v1_application_id', 'same_number_elsewhere', 'is_deleted']);
  const reviewCols = cols.filter(k => !DEV_ONLY.has(k));
  const reviewRows = out.filter(r => r.status === 'FIX');
  fs.writeFileSync(OUT_REVIEW, toCsv(reviewCols, reviewRows));

  const tally = {};
  for (const r of out) { const k = `${r.status} | ${r.programme}`; tally[k] = (tally[k] || 0) + 1; }
  console.log(`rows: ${out.length} -> ${OUT}`);
  console.table(tally);
  console.log(`rows to fix: ${reviewRows.length} -> ${OUT_REVIEW}`);
  const flagged = out.filter(r => r.status.startsWith('REVIEW'));
  if (flagged.length) console.table(flagged.map(r => ({ lead: r.v2_lead_id, name: r.student_name, status: r.status,
    cur: r.current_mobile, login: r.correct_mobile_student_logs_in_with, alt: r.current_alternate_mobile, elsewhere: r.same_number_elsewhere })));
})().catch(e => { console.error(e.message); process.exit(1); });
