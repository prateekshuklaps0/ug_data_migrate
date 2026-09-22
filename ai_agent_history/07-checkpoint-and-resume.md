# Checkpointing and resume

## The problem

"If the script dies half way, re-running it must not re-migrate what already went in."

## Two independent mechanisms

### 1. Idempotency — the real safety net

Every write is keyed on a **v1 identifier backed by a unique index**, so running the import
twice inserts nothing twice, checkpoint or no checkpoint:

| table | key | index state |
|---|---|---|
| `users` | `ON CONFLICT (v1_id)` | valid |
| `v2_leads` | `ON CONFLICT (v1_lead_id)` | valid |
| `under_graduate` | `ON CONFLICT (v1_lead_id)` | valid (re-points a row orphaned by a hard-deleted lead) |
| `notes` | `ON CONFLICT (v1_note_id)` | valid |
| `lead_tags` | `ON CONFLICT (v2_lead_id, tag_id)` | valid |
| `ApplicationActivityTrackers` | `ON CONFLICT ("v1_leadId")` | valid |
| `leadScoreHistory` | `ON CONFLICT ("leadId", "dedupeKey")` | valid |
| `timelines` | **pre-filter on `v1_timeline_id`** | its index is **INVALID** — see below |

`timelines_v1_timeline_id_uniq` exists but has `indisvalid = false`: it is a partitioned index
and `timelines_p202605` is detached from the parent, so it was never completed and Postgres
refuses it as an `ON CONFLICT` arbiter. The importer therefore SELECTs the already-present
`v1_timeline_id`s (bounded by `created_at` so the planner prunes the 79 GB default partition)
and inserts only the rest. Same guarantee, done in application code.

`leadScoreHistory.uuid` is NOT NULL with no default, so the importer derives a **deterministic**
UUIDv5 from the v1 history id. A re-run produces the same uuid rather than minting a new one.

### 2. The checkpoint — speed and an audit trail

`data/export/<runId>/checkpoint.json`, written after **every committed phase**:

```json
{ "exportRun": "...", "manifestSha": "...",
  "phases": { "students": { "done": true, "at": "...", "result": {...} }, ... } }
```

- Lives in the **export** folder, so every apply against the same payload shares it.
- Carries the manifest sha256. A checkpoint from a **different export payload is ignored** —
  you cannot accidentally skip phases that were never run for the data you are importing now.
- `--restart` ignores it entirely.
- A **dry run never reads or writes it**, so a rehearsal always exercises every phase.

Phase keys, in order:
`students → leads → under_graduate_lead → under_graduate_applicant → under_graduate_backfill → timelines → notes →
lead_tags → activity_trackers → lead_score_history → promotions`

### Resume needs the id maps back

A resumed run skips `students` and `leads`, but every later phase needs `studentMap` and
`leadMap`. The importer therefore **rebuilds both from v2 unconditionally**, after those
phases, whether they ran or were skipped — by `users.v1_id` (falling back to email within the
org) and by `v2_leads.v1_lead_id`. If either map cannot be rebuilt completely it **throws** and
tells you to use `--restart`, rather than continuing with a half-built map.

### On failure

`rollback.sql` is rewritten after **every committed phase** and again on failure, so a crash
part-way through still leaves a complete undo script for whatever did commit. It is emitted in
reverse phase order, because `under_graduate` has **no foreign key to `v2_leads`** — deleting
the lead first would strand its row.

## Tests

`node scripts/30-test-checkpoint.cjs` — 14 assertions, no database. Covers: fresh run, marking
done, surviving a process restart, a checkpoint for a different payload being ignored,
`--restart`, a dry run neither reading nor writing it, resuming at the first pending phase, and
deterministic uuid stability/uniqueness/shape. **14 passed, 0 failed.**

## What you will see on a second apply

Every phase reports `SKIPPED - completed at <time>`, and the verification at the end still
confirms the row counts. That is the expected, correct outcome.
