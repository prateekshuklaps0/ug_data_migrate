-- ===========================================================================
-- REVERT the payment_mode fill. Run on v2 (anandi) as ONE SCRIPT.
--
-- Reads only the snapshot tables the apply script created, so it puts every
-- row back to precisely the value and timestamp it had before:
--   ug_payment_mode_backup_20260918
--   ug_payment_mode_timelines_20260918
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
  FROM ug_payment_mode_backup_20260918 b
 WHERE l.id = b.v2_lead_id
   AND l.payment_mode = b.payment_mode_after;

-- 2. Remove the timeline entries this fix added.
DELETE FROM timelines t
 USING ug_payment_mode_timelines_20260918 x
 WHERE t.id = x.id
   AND t.created_at = x.created_at;

-- 3. What is left. restored + changed_since should add up to 536,
--    and still_carrying_fix should be 0.
SELECT count(*)::int                                                       AS planned,
       count(*) FILTER (WHERE l.payment_mode IS NOT DISTINCT FROM
                              b.payment_mode_before)::int                  AS restored,
       count(*) FILTER (WHERE l.payment_mode = b.payment_mode_after)::int  AS still_carrying_fix,
       count(*) FILTER (WHERE l.payment_mode IS NOT NULL
                          AND l.payment_mode <> b.payment_mode_after)::int AS changed_since
  FROM ug_payment_mode_backup_20260918 b
  JOIN v2_leads l ON l.id = b.v2_lead_id;

SELECT count(*)::int AS timeline_entries_left
  FROM ug_payment_mode_timelines_20260918 x
  JOIN timelines t ON t.id = x.id AND t.created_at = x.created_at;

COMMIT;

-- Once you are satisfied, and only then:
--   DROP TABLE ug_payment_mode_backup_20260918;
--   DROP TABLE ug_payment_mode_timelines_20260918;
