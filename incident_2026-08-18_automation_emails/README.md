# Incident — 2026-08-18 — migration import triggered production automation emails

## Summary

The PGP Bharat v1→v2 import inserted 76,627 rows into `v2_leads` and updated 53,460 of them.
`v2_leads` carries `trg_automation_v2_leads` (AFTER INSERT OR UPDATE) → `emit_automation_event()`,
which writes to `automation_events` on channel `production` and wakes the workflow engine.

Workflow **25 "PGP BHARAT - IN"** contains an `email` node. It sent **6,388 emails to 6,343
distinct applicants** via SendGrid between **19:11 and 20:33 UTC**, at ~390 per 5 minutes.

Baseline for that workflow: **3 emails on 17 Aug, 0 on 16 Aug.** The spike is entirely this import.

Sending stopped only because workflow 25 and 29 were **paused by hand** at 20:33
(`workflows.updated_at` 2026-08-18T20:33:52). **70,239 of the 76,627 leads were never reached.**

## Root cause

The import used raw SQL via `pg` deliberately — no models, no hooks, no queues. That argument
covers the *application* and says nothing about the *database*. **A trigger fires for whoever
does the INSERT.** No check for triggers on the target tables was performed before the first write.

This was documented and was missed:

- `new_crm_backend/docs/AutomationTriggers.md` documents the trigger and its kill switch:
  *"bulk writes that must NOT emit should `SET app.skip_automation='true'` on the connection first."*
- `new_crm_backend/scripts/migrate-v1-form69-leads.js` — another engineer's v1→v2 lead migration —
  already sets it, with a comment predicting this exact outcome: *"Migrating 272,017 historical
  leads would enqueue 272,017 events and blast real applicants with email/SMS/WhatsApp."*
- The reference scripts supplied in `script_suggestions_from_devs/` do **not** contain the guard.

## Fix

`scripts/import/10-import.mjs` now runs, immediately after connecting:

```js
await db.query(`set app.skip_automation = 'true'`);   // SESSION, not SET LOCAL
```

and **throws rather than proceed** if the value does not read back as `'true'`. `SET LOCAL` would
be discarded at each per-phase COMMIT — verified against the live database that a session-level
SET survives a `begin`/`commit` cycle.

## Still open

- **Workflow 25 must stay paused** until the queued backlog is cleared or cancelled. Un-pausing it
  while `automation_events` still holds pending rows for these leads resumes the send.
- Backlog at capture time: 18,770 `pending`, 20 `processing` for our leads. Still draining.
- Workflows 20, 22, 24, 45–50 remain active and contain email nodes. They did not fire for these
  leads (their conditions routed to `isElse`), but any future bulk load must assume they can.

## Files here

| file | what it is |
|---|---|
| `emailed_applicants.csv` | every send: timestamp, applicant name, email, mobile, v1/v2 lead id, workflow, SendGrid messageId, status. 6,420 rows — 6,388 COMPLETED, 32 FAILED, 6,343 distinct addresses. **For the comms/support team.** |
| `automation_events.ndjson` | the full event trail for these leads, 79,970 rows. **Captured deliberately: `done` events are purged after ~2 days by the 3 AM IST cron** (`src/automation.js`), which would have destroyed the evidence. |

## What was NOT affected

The migrated data itself is correct. `scripts/verify/verify-import.mjs` passes every check —
row counts reconcile against both the export files and v1, zero duplicates on all ten streams,
and 300 randomly sampled leads match v1 field-for-field. **Row-level correctness said nothing
about side effects, which is the whole lesson here.**
