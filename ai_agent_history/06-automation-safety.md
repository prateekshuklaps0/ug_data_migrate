# Will 2026-08-18 happen again?  No — and here is the evidence, not the assurance

The fear is precise and correct: on 2026-08-18 a migration into `v2_leads` sent
**6,388 emails to 6,343 real applicants**. This document is the proof that this run cannot.

## The mechanism, exactly

`v2_leads` carries `trg_automation_v2_leads` (AFTER INSERT OR UPDATE) → `emit_automation_event()`.
That function's **first statement** is:

```sql
IF current_setting('app.skip_automation', true) = 'true' THEN
  RETURN NEW;
END IF;
```

It returns before writing to `automation_events` and before `pg_notify`. No event, no wake-up,
no workflow evaluation, no send. The guard is not a filter downstream of the emails — it is
upstream of the event that would ever cause one.

## What is actually at risk (measured, not assumed)

The automation engine treats **both** `active` and `published` as live —
`automation.service.js`: `LIVE_WORKFLOW_STATUSES = new Set(['active', 'published'])`.
Filtering on `status = 'active'` alone badly understates exposure and would give false comfort.

Measured on 2026-09-22:

| | |
|---|---|
| LIVE workflows in org 12 containing an email/whatsapp/sms node | **26** |
| of those, scoped to school 18 (UG) — could match these very leads | **1** |
| that one | **workflow 82 "UG Login Cred"**, `published`, contains an `email` node |
| workflow 25 "PGP BHARAT - IN - login cred" (the 18-Aug culprit) | **`published` again** since 2026-08-23 |

So the risk is real and current. Workflow 82 would email the 163 UG leads. The guard is the
thing that stops it.

## The proof — run it yourself, before every apply

```powershell
node scripts\import\05-automation-safety-check.cjs
```

It does not assert. It runs **both halves of the experiment** against the live database,
inside transactions that are rolled back:

| | result |
|---|---|
| CONTROL — insert a lead with the guard **OFF** | `automation_events` gains **1** row |
| PROTECTED — insert a lead with the guard **ON** | `automation_events` gains **0** rows |
| after a `begin`/`commit` cycle, guard still on | **0** rows |
| probe rows left behind afterwards | **0** |

The control is the important half. Without it, "no events" could mean the trigger is disabled,
the probe did not match, or the query is wrong. Watching the event appear and then not appear
is what makes the zero meaningful.

Rolling back is safe for the control: `pg_notify` only delivers on COMMIT, so the workflow
engine is never woken even by the deliberately-unguarded probe.

Last run: **8 passed, 0 failed.**

## The five layers in the importer

1. `SET app.skip_automation = 'true'` at **SESSION** level on connect — not `SET LOCAL`, which
   is discarded at every COMMIT. This was the specific mistake the 18-Aug fix called out.
2. `armAutomationGuard()` reads the value back and **throws** if it is not `'true'`. The import
   cannot start unguarded.
3. The guard is **re-verified after every committed phase**, because a dropped connection would
   silently reset a session GUC.
4. At the end the importer asks the precise question: *are there any `automation_events` rows,
   newer than the baseline `max(id)` captured at start, for the exact `v2_leads` ids this run
   touched?* It **throws** if the answer is not zero.
5. That check is baselined deliberately. An unbaselined count is useless here: org 12 is a live
   CRM, other sessions write to `automation_events` throughout, and a promotion target is an
   existing row with its own history. An early version of this check produced a **false STOP**
   for exactly that reason.

## What to watch after the apply

```sql
-- must be 0. Run before and after.
SELECT count(*) FROM automation_events
WHERE table_name = 'v2_leads'
  AND row_id IN (SELECT id FROM v2_leads
                 WHERE org_id = 12 AND school_id = 18 AND v1_lead_id IS NOT NULL);
```

If it is ever non-zero for rows this run wrote: **pause workflow 82 first**, then 25 and 29,
then any other live workflow with an email node, and read
`incident_2026-08-18_automation_emails/README.md`.

## Honest limits

- The guard protects writes made **by this script on this connection**. It does not and cannot
  stop the CRM's own users generating automation normally — that is the system working.
- If someone runs raw SQL against `v2_leads` in another session without the guard, events fire.
  That is outside this migration.
- `automation_events` rows with `status = 'done'` are purged after ~2 days by the 3 AM IST cron,
  so evidence gathering has a short window.
