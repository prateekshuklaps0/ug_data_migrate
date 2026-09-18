// READ-ONLY: turns ug_payment_mode_plan.csv into plain SELECT statements you can paste
// into a DB client to inspect exactly what fix_payment_modes.cjs will change.
//
// The mapping is written out row by row from the SAME csv the fix script reads, so what
// you inspect and what gets written cannot drift apart.
//
// Writes:
//   verify_before_update_v2.sql  - run on v2 (anandi)     : the rows that will change
//   verify_source_values_v1.sql  - run on v1 (LeadsRDS)   : the values being copied
//   verify_after_update_v2.sql   - run on v2 AFTER applying
//
// Usage: node make_verification_sql.cjs [plan.csv]
const path = require('path');
const fs = require('fs');

const CSV_PATH = path.resolve(process.argv[2] || path.join(__dirname, 'ug_payment_mode_plan.csv'));

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

const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf8'));
const header = rows[0];
const col = (n) => { const i = header.indexOf(n); if (i < 0) throw new Error(`missing column ${n}`); return i; };
const iStatus = col('status'), iLead = col('v2_lead_id'), iMode = col('new_payment_mode'), iApp = col('v1_application_id');

const plan = rows.slice(1).filter(r => r[iStatus] === 'FIX').map(r => ({
  id: Number(r[iLead]), mode: String(r[iMode]).trim(), appId: Number(r[iApp]),
}));
if (!plan.length) throw new Error('no FIX rows in plan');
for (const p of plan) {
  if (!Number.isInteger(p.id) || !Number.isInteger(p.appId)) throw new Error('bad id in plan');
  if (!['online', 'offline', 'cash', 'coupon'].includes(p.mode)) throw new Error(`bad mode ${p.mode}`);
}

const values = plan.map(p => `(${p.id},'${p.mode}')`).join(',\n  ');
const appIds = plan.map(p => p.appId).join(',');
const N = plan.length;
const tally = plan.reduce((a, p) => (a[p.mode] = (a[p.mode] || 0) + 1, a), {});

const SCOPE = `l.org_id = 12
   AND l.school_id = 18
   AND l.form_id IN (104,105)
   AND l.type = 'applicant'
   AND l.is_deleted = false
   AND l.status = 'active'
   AND (l.payment_status ILIKE 'completed' OR l.payment_status ILIKE 'paid')`;

fs.writeFileSync(path.join(__dirname, 'verify_before_update_v2.sql'),
`-- Run on v2 (anandi) BEFORE applying. Read-only: these are SELECTs, nothing is written.
-- Generated from ${path.basename(CSV_PATH)} (${N} rows: ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}).

-- ============================================================
-- 1. THE ROWS THAT WILL CHANGE.  Expect exactly ${N} rows.
--    payment_mode_now must be "(blank)" on every single one.
-- ============================================================
WITH plan(lead_id, new_mode) AS (VALUES
  ${values}
)
SELECT l.id                                  AS v2_lead_id,
       l.registered_name                     AS student_name,
       l.registered_email                    AS student_email,
       l.application_number,
       l.form_id,
       l.payment_status,
       coalesce(l.payment_mode,'(blank)')    AS payment_mode_now,
       p.new_mode                            AS payment_mode_after,
       l.payment_completed_at,
       l.v1_application_id
  FROM plan p
  JOIN v2_leads l ON l.id = p.lead_id
 WHERE ${SCOPE}
   AND l.payment_mode IS NULL
 ORDER BY p.new_mode, l.id;

-- ============================================================
-- 2. SUMMARY of the same set.  Expect: ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}
--    and blank_now = ${N}, already_has_mode = 0.
-- ============================================================
WITH plan(lead_id, new_mode) AS (VALUES
  ${values}
)
SELECT p.new_mode                                                   AS payment_mode_after,
       count(*)::int                                                AS rows,
       count(*) FILTER (WHERE l.payment_mode IS NULL)::int          AS blank_now,
       count(*) FILTER (WHERE l.payment_mode IS NOT NULL)::int      AS already_has_mode,
       count(*) FILTER (WHERE l.payment_completed_at IS NULL)::int  AS no_payment_date
  FROM plan p JOIN v2_leads l ON l.id = p.lead_id
 GROUP BY 1 ORDER BY 1;

-- ============================================================
-- 3. SAFETY CHECK: any planned row that no longer qualifies.
--    Expect 0 rows.  If anything comes back, rebuild the plan
--    (node build_payment_mode_plan.cjs) before applying.
-- ============================================================
WITH plan(lead_id, new_mode) AS (VALUES
  ${values}
)
SELECT p.lead_id,
       l.id IS NULL                                  AS lead_missing,
       l.org_id, l.school_id, l.form_id, l.type::text AS type,
       l.is_deleted, l.status::text                   AS status,
       l.payment_status, l.payment_mode
  FROM plan p
  LEFT JOIN v2_leads l ON l.id = p.lead_id
 WHERE l.id IS NULL
    OR l.org_id <> 12 OR l.school_id <> 18
    OR l.form_id NOT IN (104,105)
    OR l.type::text <> 'applicant'
    OR l.is_deleted <> false
    OR l.status::text <> 'active'
    OR NOT (l.payment_status ILIKE 'completed' OR l.payment_status ILIKE 'paid')
    OR l.payment_mode IS NOT NULL;

-- ============================================================
-- 4. BLAST RADIUS: every paid UG application that is currently blank.
--    total_blank must equal ${N} - i.e. the plan covers all of them and
--    nothing outside the plan will be left behind or touched.
-- ============================================================
SELECT count(*)::int AS total_blank_paid_ug
  FROM v2_leads l
 WHERE ${SCOPE}
   AND l.payment_mode IS NULL;

-- ============================================================
-- 5. THE CARD AS IT READS NOW (what the dashboard shows today).
-- ============================================================
SELECT count(*)::int                                            AS total_paid,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'online')::int  AS online,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'offline')::int AS offline,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'cash')::int    AS cash,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'coupon')::int  AS coupon,
       count(*) FILTER (WHERE l.payment_mode IS NULL)::int         AS blank
  FROM v2_leads l
 WHERE ${SCOPE};
`);

fs.writeFileSync(path.join(__dirname, 'verify_source_values_v1.sql'),
`-- Run on v1 (LeadsRDS / leadmatrix-production) BEFORE applying. Read-only.
-- This is where the values come from. Expect ${N} rows,
-- ${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}, all with paymentStatus completed.

-- 1. What the old CRM holds for each application being fixed.
SELECT am.id                AS v1_application_id,
       am."applicationNum"  AS application_number,
       am."paymentMethod"   AS payment_method_in_v1,
       am."paymentStatus"   AS payment_status_in_v1,
       lower(btrim(am."paymentMethod")) AS value_that_will_be_written
  FROM "ApplicationManager" am
 WHERE am.id IN (${appIds})
 ORDER BY am."paymentMethod", am.id;

-- 2. Summary. Expect exactly ${N} rows and no unexpected method.
SELECT coalesce(am."paymentMethod",'(NULL)') AS payment_method_in_v1,
       coalesce(am."paymentStatus",'(NULL)') AS payment_status_in_v1,
       count(*)::int                         AS rows
  FROM "ApplicationManager" am
 WHERE am.id IN (${appIds})
 GROUP BY 1,2 ORDER BY 3 DESC;

-- 3. Any application id in the plan that v1 does not have. Expect 0.
SELECT count(*)::int AS missing_in_v1
  FROM unnest(ARRAY[${appIds}]::bigint[]) AS t(id)
 WHERE NOT EXISTS (SELECT 1 FROM "ApplicationManager" am WHERE am.id = t.id);
`);

fs.writeFileSync(path.join(__dirname, 'verify_after_update_v2.sql'),
`-- Run on v2 (anandi) AFTER applying. Read-only.

-- 1. Every planned row now carries its mode. Expect ${N} and 0 still blank.
WITH plan(lead_id, new_mode) AS (VALUES
  ${values}
)
SELECT count(*)::int                                              AS planned,
       count(*) FILTER (WHERE l.payment_mode = p.new_mode)::int   AS correct,
       count(*) FILTER (WHERE l.payment_mode IS NULL)::int        AS still_blank,
       count(*) FILTER (WHERE l.payment_mode IS NOT NULL
                          AND l.payment_mode <> p.new_mode)::int  AS wrong_value
  FROM plan p JOIN v2_leads l ON l.id = p.lead_id;

-- 2. The card as it should read now: ${Object.entries(tally).map(([k, v]) => `${k} includes the ${v} restored`).join('; ')}.
SELECT count(*)::int                                               AS total_paid,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'online')::int   AS online,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'offline')::int  AS offline,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'cash')::int     AS cash,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'coupon')::int   AS coupon,
       count(*) FILTER (WHERE l.payment_mode IS NULL)::int          AS blank
  FROM v2_leads l
 WHERE ${SCOPE};

-- 3. The audit trail this fix left behind. Expect ${N} rows.
SELECT count(*)::int AS timeline_entries
  FROM timelines
 WHERE metadata->>'source' = 'data_fix_missing_payment_mode';

-- 4. Nothing else in UG changed its mode. Expect only the values you know about.
SELECT coalesce(l.payment_mode,'(blank)') AS payment_mode, count(*)::int AS rows
  FROM v2_leads l
 WHERE ${SCOPE}
 GROUP BY 1 ORDER BY 2 DESC;
`);

console.log(`plan: ${N} rows (${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')})`);
console.log('wrote verify_before_update_v2.sql, verify_source_values_v1.sql, verify_after_update_v2.sql');
