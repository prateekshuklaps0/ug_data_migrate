// READ-ONLY: turns ug_payment_mode_plan.csv into a self-contained apply script and its
// matching revert script, for running by hand in a DB client instead of via
// fix_payment_modes.cjs.
//
// The apply script snapshots the before-state into a real table first, so the revert
// does not depend on this file, on the CSV, or on anything staying in memory.
//
// Writes:
//   apply_payment_mode_update.sql
//   revert_payment_mode_update.sql
//
// Usage: node make_manual_sql.cjs [plan.csv]
const path = require('path');
const fs = require('fs');

const CSV_PATH = path.resolve(process.argv[2] || path.join(__dirname, 'ug_payment_mode_plan.csv'));
const STAMP = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const BK = `ug_payment_mode_backup_${STAMP}`;
const TL = `ug_payment_mode_timelines_${STAMP}`;

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
const iStatus = col('status'), iLead = col('v2_lead_id'), iMode = col('new_payment_mode');

const plan = rows.slice(1).filter(r => r[iStatus] === 'FIX').map(r => ({ id: Number(r[iLead]), mode: String(r[iMode]).trim() }));
for (const p of plan) {
  if (!Number.isInteger(p.id) || p.id <= 0) throw new Error('bad lead id in plan');
  if (!['online', 'offline', 'cash', 'coupon'].includes(p.mode)) throw new Error(`bad mode ${p.mode}`);
}
const N = plan.length;
if (!N) throw new Error('no FIX rows in plan');
const values = plan.map(p => `(${p.id},'${p.mode}')`).join(',\n  ');
const tally = plan.reduce((a, p) => (a[p.mode] = (a[p.mode] || 0) + 1, a), {});

const SCOPE = `l.org_id = 12
   AND l.school_id = 18
   AND l.form_id IN (104,105)
   AND l.type = 'applicant'
   AND l.is_deleted = false
   AND l.status = 'active'
   AND (l.payment_status ILIKE 'completed' OR l.payment_status ILIKE 'paid')`;

fs.writeFileSync(path.join(__dirname, 'apply_payment_mode_update.sql'),
`-- ===========================================================================
-- FILL THE MISSING payment_mode ON UG PAID APPLICATIONS
-- Run this on v2 (anandi) as ONE SCRIPT, not statement by statement.
-- Plan: ${N} rows (${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}), generated from ${path.basename(CSV_PATH)}.
--
-- HOW TO RUN IT
--   Execute the whole file in one go ("Execute script", not "Execute statement").
--   Everything is inside one transaction. If any guard fails, the transaction
--   aborts and the COMMIT at the bottom silently becomes a rollback - the
--   database is left exactly as it was.
--
-- WHY IT IS SAFE TO REVERT
--   Step 1 copies the before-state into a real table (${BK})
--   BEFORE anything changes. revert_payment_mode_update.sql reads only that
--   table, so reverting does not depend on this file or on the CSV.
--   Keep ${BK} until you are happy. Do not drop it.
--
-- DO NOT remove the SET LOCAL app.skip_automation line. Without it the
-- automation trigger fires on all ${N} students and can send them mail.
-- ===========================================================================

BEGIN;

SET LOCAL app.skip_automation = 'true';
SET LOCAL lock_timeout        = '15s';
SET LOCAL statement_timeout   = '300s';

-- ---------------------------------------------------------------------------
-- STEP 1  Snapshot the before-state. Re-running the script fails here, on
--         purpose, because the table already exists.
-- ---------------------------------------------------------------------------
CREATE TABLE ${BK} AS
WITH plan(lead_id, new_mode) AS (VALUES
  ${values}
)
SELECT l.id                 AS v2_lead_id,
       l.payment_mode       AS payment_mode_before,
       l.updated_at         AS updated_at_before,
       p.new_mode           AS payment_mode_after,
       l.v1_application_id,
       l.registered_email   AS student_email
  FROM plan p
  JOIN v2_leads l ON l.id = p.lead_id
 WHERE ${SCOPE}
   AND l.payment_mode IS NULL;

-- ---------------------------------------------------------------------------
-- STEP 2  Refuse to go on unless the snapshot is exactly what was signed off.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM ${BK};
  IF n <> ${N} THEN
    RAISE EXCEPTION 'Snapshot holds % rows, expected ${N}. Nothing has been changed. Rebuild the plan and start again.', n;
  END IF;
  IF EXISTS (SELECT 1 FROM ${BK} WHERE payment_mode_before IS NOT NULL) THEN
    RAISE EXCEPTION 'Some rows already carry a payment mode. Nothing has been changed.';
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- STEP 3  The update. Only ever fills a blank; never overwrites a real value.
-- ---------------------------------------------------------------------------
UPDATE v2_leads l
   SET payment_mode = b.payment_mode_after,
       updated_at   = NOW()
  FROM ${BK} b
 WHERE l.id = b.v2_lead_id
   AND l.payment_mode IS NULL
   AND ${SCOPE};

-- ---------------------------------------------------------------------------
-- STEP 4  Refuse to commit unless every planned row now carries its value.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM ${BK} b JOIN v2_leads l ON l.id = b.v2_lead_id
   WHERE l.payment_mode = b.payment_mode_after;
  IF n <> ${N} THEN
    RAISE EXCEPTION 'Only % of ${N} rows carry the new value. Rolling back.', n;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- STEP 5  Audit trail: one timeline entry per student, ids kept for the revert.
-- ---------------------------------------------------------------------------
CREATE TABLE ${TL} AS
WITH ins AS (
  INSERT INTO timelines (v2_lead_id, org_id, school_id, event_type, title, description,
                         metadata, created_by, created_at, updated_at)
  SELECT l.id, l.org_id, l.school_id, 'updated', 'Lead Updated',
         'Set Payment Mode to "' || b.payment_mode_after || '" - data fix: mode was not copied from the old CRM',
         jsonb_build_object('fields', jsonb_build_array('paymentMode'),
                            'newPaymentMode', b.payment_mode_after,
                            'source', 'data_fix_missing_payment_mode'),
         NULL, NOW(), NOW()
    FROM ${BK} b
    JOIN v2_leads l ON l.id = b.v2_lead_id
  RETURNING id, created_at
)
SELECT * FROM ins;

DO $guard$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM ${TL};
  IF n <> ${N} THEN
    RAISE EXCEPTION 'Wrote % timeline rows, expected ${N}. Rolling back.', n;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- STEP 6  Prove no automation fired. now() is the transaction start time.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
    FROM automation_events
   WHERE table_name = 'v2_leads'
     AND created_at >= now()
     AND row_id IN (SELECT v2_lead_id FROM ${BK});
  IF n <> 0 THEN
    RAISE EXCEPTION '% automation events were emitted - suppression failed. Rolling back.', n;
  END IF;
END
$guard$;

-- ---------------------------------------------------------------------------
-- STEP 7  What you will see once this commits.
-- ---------------------------------------------------------------------------
SELECT count(*)::int                                              AS total_paid,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'online')::int  AS online,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'offline')::int AS offline,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'cash')::int    AS cash,
       count(*) FILTER (WHERE l.payment_mode ILIKE 'coupon')::int  AS coupon,
       count(*) FILTER (WHERE l.payment_mode IS NULL)::int         AS still_blank
  FROM v2_leads l
 WHERE ${SCOPE};

COMMIT;
-- If anything above raised, this COMMIT rolls back instead and nothing changed.
`);

fs.writeFileSync(path.join(__dirname, 'revert_payment_mode_update.sql'),
`-- ===========================================================================
-- REVERT the payment_mode fill. Run on v2 (anandi) as ONE SCRIPT.
--
-- Reads only the snapshot tables the apply script created, so it puts every
-- row back to precisely the value and timestamp it had before:
--   ${BK}
--   ${TL}
--
-- Rows that someone has changed since the fix are left alone on purpose, and
-- reported at the end - reverting those would throw away the newer value.
-- ===========================================================================

BEGIN;

SET LOCAL app.skip_automation = 'true';
SET LOCAL lock_timeout        = '15s';
SET LOCAL statement_timeout   = '300s';

-- 1. Put payment_mode and updated_at back.
UPDATE v2_leads l
   SET payment_mode = b.payment_mode_before,
       updated_at   = b.updated_at_before
  FROM ${BK} b
 WHERE l.id = b.v2_lead_id
   AND l.payment_mode = b.payment_mode_after;

-- 2. Remove the timeline entries this fix added.
DELETE FROM timelines t
 USING ${TL} x
 WHERE t.id = x.id
   AND t.created_at = x.created_at;

-- 3. What is left. restored + changed_since should add up to ${N},
--    and still_carrying_fix should be 0.
SELECT count(*)::int                                                       AS planned,
       count(*) FILTER (WHERE l.payment_mode IS NOT DISTINCT FROM
                              b.payment_mode_before)::int                  AS restored,
       count(*) FILTER (WHERE l.payment_mode = b.payment_mode_after)::int  AS still_carrying_fix,
       count(*) FILTER (WHERE l.payment_mode IS NOT NULL
                          AND l.payment_mode <> b.payment_mode_after)::int AS changed_since
  FROM ${BK} b
  JOIN v2_leads l ON l.id = b.v2_lead_id;

SELECT count(*)::int AS timeline_entries_left
  FROM ${TL} x
  JOIN timelines t ON t.id = x.id AND t.created_at = x.created_at;

COMMIT;

-- Once you are satisfied, and only then:
--   DROP TABLE ${BK};
--   DROP TABLE ${TL};
`);

console.log(`plan: ${N} rows (${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')})`);
console.log(`backup tables: ${BK}, ${TL}`);
console.log('wrote apply_payment_mode_update.sql, revert_payment_mode_update.sql');
