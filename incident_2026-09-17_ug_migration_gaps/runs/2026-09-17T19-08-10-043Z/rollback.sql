-- Rollback for fix_application_numbers run 2026-09-17T19-08-10-043Z. Review before running.
-- Note: the sequence is not rewound; those numbers stay used, which is harmless.
BEGIN;
SET LOCAL app.skip_automation = 'true';
UPDATE v2_leads l SET application_number = NULL, updated_at = NOW()
  FROM (VALUES
  (700570,'UG/SOB-89044'),
  (703317,'UG/SOB-89045'),
  (715190,'UG/SOB-89046'),
  (1750585,'UG/SOB-89047'),
  (1833409,'UG/SOB-89048'),
  (1835543,'UG/SOB-89049'),
  (1838992,'UG/SOB-89050'),
  (1839109,'UG/SOB-89051'),
  (1863445,'UG/DSAI-89052'),
  (1863501,'UG/DSAI-89053')
  ) AS v(lead_id, number)
 WHERE l.id = v.lead_id AND l.application_number = v.number;
DELETE FROM timelines WHERE id IN (273359807,273359808,273359809,273359810,273359811,273359813,273359814,273359815,273359816,273359817) AND created_by IS NULL
   AND metadata->>'source' = 'data_fix_missing_application_number';
-- Expect UPDATE 10 and DELETE 10. If not, run ROLLBACK; instead of COMMIT.
COMMIT;
