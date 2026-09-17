// READ-ONLY: builds the verification CSV for counsellor assignments reverted on 2026-09-17.
// Scope: every assignment/reassignment timeline created by ugadmissions@mastersunion.org (4640466)
// on 2026-09-17 IST (whole day, no time or program filter). Expected counsellor = that account's latest one.
//
// DB credentials come from new_crm_backend/.env (v2 prod). The session is forced READ ONLY.
// Usage: node build_verification_csv.cjs [output.csv]
// Writes the full dev CSV plus a <output>_for_review.csv (needs-fix rows only, no ids / dev columns).
const path = require('path');
const fs = require('fs');

const BACKEND = path.join(__dirname, '..', 'new_crm_backend');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });
const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));

const ADMIN = 4640466;
const OUT = process.argv[2] || path.join(__dirname, 'ug_counsellor_reassignment_verification_2026-09-17.csv');
const OUT_REVIEW = OUT.replace(/\.csv$/i, '') + '_for_review.csv';

const SQL = `
WITH ev AS (
  SELECT t.id, t.v2_lead_id, t.created_at, t.created_by, t.event_type, t.description,
         NULLIF(t.metadata->>'newCounsellorId','')::int AS new_c, NULLIF(t.metadata->>'prevCounsellorId','')::int AS prev_c
    FROM timelines t JOIN v2_leads l ON l.id = t.v2_lead_id
   WHERE t.created_by = ${ADMIN}
     AND t.created_at >= '2026-09-17 00:00+05:30' AND t.created_at < '2026-09-18 00:00+05:30'
     AND t.event_type IN ('assigned','counsellor_reassigned','counsellor_assigned','counsellor_removed')
),
adm AS (SELECT DISTINCT v2_lead_id FROM ev),
hist AS (
  SELECT e.v2_lead_id,
         count(*) FILTER (WHERE e.created_by = ${ADMIN}) AS admin_events_today,
         string_agg(to_char(e.created_at AT TIME ZONE 'Asia/Kolkata','HH24:MI:SS') || ' [' || coalesce(u.email, e.created_by::text) || '] ' || e.description,
                    ' || ' ORDER BY e.created_at, e.id) AS history
    FROM ev e LEFT JOIN users u ON u.id = e.created_by
   WHERE e.v2_lead_id IN (SELECT v2_lead_id FROM adm) GROUP BY 1
),
last AS (
  SELECT DISTINCT ON (v2_lead_id) * FROM ev WHERE v2_lead_id IN (SELECT v2_lead_id FROM adm)
   ORDER BY v2_lead_id, created_at DESC, id DESC
)
SELECT l.id AS lead_id, l.uuid AS lead_uuid, l.application_number,
       l.registered_name AS lead_name, l.registered_email AS lead_email, l.registered_mobile AS lead_mobile,
       p.name AS program, l.form_id,
       l.counsellor_id AS current_counsellor_id, cu.name AS current_counsellor_name, cu.email AS current_counsellor_email,
       last.new_c AS expected_counsellor_id, xu.name AS expected_counsellor_name, xu.email AS expected_counsellor_email, xu.status AS expected_counsellor_status,
       l.previous_counsellor AS previous_counsellor_col, pu.name AS previous_counsellor_name,
       last.id AS source_timeline_id, last.prev_c AS source_prev_counsellor_id, last.event_type AS source_event_type, last.description AS source_timeline_description,
       coalesce(lu.email, last.created_by::text) AS source_created_by,
       to_char(last.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS') AS source_created_at_ist,
       to_char(l.reassigned_on AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS') AS lead_reassigned_on_ist,
       to_char(l.updated_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI:SS') AS lead_updated_at_ist,
       l.is_deleted, h.admin_events_today, h.history AS assignment_history_today_ist,
       (SELECT count(*) FROM timelines o
         WHERE o.v2_lead_id = l.id AND o.created_at > last.created_at AND o.created_by IS DISTINCT FROM ${ADMIN}
           AND o.event_type IN ('assigned','counsellor_reassigned','counsellor_assigned','counsellor_removed')) AS later_assignments_by_others
  FROM last
  JOIN v2_leads l ON l.id = last.v2_lead_id
  JOIN hist h ON h.v2_lead_id = l.id
  LEFT JOIN programs p ON p.id = l.program_id
  LEFT JOIN users cu ON cu.id = l.counsellor_id
  LEFT JOIN users xu ON xu.id = last.new_c
  LEFT JOIN users pu ON pu.id = l.previous_counsellor
  LEFT JOIN users lu ON lu.id = last.created_by`;

(async () => {
  const c = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: String(process.env.DB_SSL).trim() === 'true' ? { rejectUnauthorized: false } : false,
  });
  await c.connect();
  await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  await c.query("SET statement_timeout='300s'");
  const { rows } = await c.query(SQL);
  await c.end();

  for (const r of rows) {
    const matches = r.current_counsellor_id === r.expected_counsellor_id;
    const prevFromTimeline = r.source_prev_counsellor_id;
    const hhmm = r.source_created_at_ist.slice(11, 16);
    // Every assignment up to 17:02 IST was reverted, everything from 17:16 IST onward is intact.
    r.assigned_before_revert_1716_ist = hhmm < '17:16' ? 'yes' : 'no';
    if (r.is_deleted) r.status = 'LEAD_DELETED_SKIP';
    else if (matches) r.status = 'ALREADY_CORRECT';
    // Bulk path stamps previous_counsellor; the single-lead path only records prevCounsellorId in timeline metadata.
    else if (r.current_counsellor_id === r.previous_counsellor_col || (prevFromTimeline != null && r.current_counsellor_id === prevFromTimeline)) r.status = 'REVERTED_NEEDS_FIX';
    else r.status = 'MISMATCH_NEEDS_REVIEW';
    r.proposed_action = r.status === 'REVERTED_NEEDS_FIX' || r.status === 'MISMATCH_NEEDS_REVIEW'
      ? `set counsellor_id ${r.current_counsellor_id ?? 'NULL'} -> ${r.expected_counsellor_id ?? 'NULL'}` : 'none';
    r.verification_verdict = '';
    r.verification_comment = '';
  }
  const order = { REVERTED_NEEDS_FIX: 0, MISMATCH_NEEDS_REVIEW: 1, ALREADY_CORRECT: 2, LEAD_DELETED_SKIP: 3 };
  rows.sort((a, b) => order[a.status] - order[b.status] || a.lead_id - b.lead_id);

  const cols = ['status', 'proposed_action', 'lead_id', 'application_number', 'lead_name', 'lead_email', 'lead_mobile', 'program', 'form_id',
    'current_counsellor_id', 'current_counsellor_name', 'current_counsellor_email',
    'expected_counsellor_id', 'expected_counsellor_name', 'expected_counsellor_email', 'expected_counsellor_status',
    'previous_counsellor_col', 'previous_counsellor_name',
    'source_timeline_id', 'source_event_type', 'source_timeline_description', 'source_created_by', 'source_created_at_ist', 'assigned_before_revert_1716_ist',
    'admin_events_today', 'later_assignments_by_others', 'assignment_history_today_ist', 'lead_reassigned_on_ist', 'lead_updated_at_ist', 'lead_uuid', 'verification_verdict', 'verification_comment'];
  const esc = (v) => { if (v == null) return ''; const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const toCsv = (cs, rs) => '﻿' + [cs.join(','), ...rs.map(r => cs.map(k => esc(r[k])).join(','))].join('\r\n') + '\r\n';
  fs.writeFileSync(OUT, toCsv(cols, rows));

  // Review copy: only leads that need fixing, no dev-only columns (status, action, ids, application number).
  const DEV_ONLY = new Set(['status', 'proposed_action', 'lead_id', 'application_number', 'form_id', 'previous_counsellor_col', 'lead_uuid']);
  const reviewCols = cols.filter(k => !DEV_ONLY.has(k) && !/(^|_)(id|uuid)(_|$)/.test(k));
  const reviewRows = rows.filter(r => r.status !== 'ALREADY_CORRECT' && r.status !== 'LEAD_DELETED_SKIP');
  fs.writeFileSync(OUT_REVIEW, toCsv(reviewCols, reviewRows));
  console.log(`review rows: ${reviewRows.length} -> ${OUT_REVIEW}\nreview columns: ${reviewCols.join(', ')}`);

  const tally = {};
  for (const r of rows) { const k = `${r.status} | ${r.program}`; tally[k] = (tally[k] || 0) + 1; }
  console.log(`rows: ${rows.length} -> ${OUT}`); console.table(tally);
  const pairs = {};
  for (const r of rows.filter(r => r.status !== 'ALREADY_CORRECT')) { const k = `${r.status}: ${r.current_counsellor_name} -> ${r.expected_counsellor_name}`; pairs[k] = (pairs[k] || 0) + 1; }
  console.table(pairs);
  const review = rows.filter(r => r.status === 'MISMATCH_NEEDS_REVIEW');
  if (review.length) console.table(review.map(r => ({ lead: r.lead_id, cur: r.current_counsellor_name, exp: r.expected_counsellor_name, prevcol: r.previous_counsellor_name, hist: r.assignment_history_today_ist.slice(0, 200) })));
})().catch(e => { console.error(e.message); process.exit(1); });
