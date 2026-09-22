# AI agent handover — UG v1→v2 data migration

**Read this file first.** Entry point for any AI agent picking this up.
Everything needed is on disk; nothing depends on chat history.

| file | what it holds |
|---|---|
| `00-README-START-HERE.md` | this file: aim, rules, status |
| `01-data-model.md` | how UG data flows in v1 and v2; verified entity mapping |
| `02-field-mappings.md` | every v1→v2 field mapping, derived empirically |
| `03-findings-2026-09-22.md` | what was missing, with counts |
| `04-decisions.md` | user decisions + every defect found and fixed |
| `05-runbook.md` | **the commands** |
| `06-automation-safety.md` | proof the 18-Aug email incident cannot recur |
| `07-checkpoint-and-resume.md` | resume-after-failure design |
| `08-coverage-answer.md` | every stream, migrated or deliberately not |

## The aim

Migrate UG lead/application data that landed in **v1** after the previous sync stopped
(2026-09-16 16:31 IST) into the **v2** production database, with no downtime and no data loss.

## Hard rules

1. **`SET app.skip_automation = 'true'` at SESSION level before any write to `v2_leads`**, and
   verify it reads back or abort. Not `SET LOCAL` — that is discarded at each COMMIT.
   26 live org-12 workflows contain email/whatsapp nodes; **workflow 82 "UG Login Cred"
   (published, school 18) would email these very leads.** See `06-automation-safety.md`.
2. **v1 is read-only.** `scripts/lib/db.cjs` opens it with `default_transaction_read_only = on`.
3. **The user runs every `--apply`.** The agent only exports and dry-runs.
4. **Export → verify → dry run → apply.** Never read v1 and write v2 in one step.
5. **The CRM is live.** Batch writes, short transactions, no schema changes.

## Databases

Credentials come from the repo `.env` files — never hardcoded.

| | config from | host | db |
|---|---|---|---|
| v1 (source, READ ONLY) | `old_crm_backend/.env` | `leadmatrix-production…` | `LeadsRDS` |
| v2 (target, PROD) | `new_crm_backend/.env` | `anandi.c1nvajieufmh…` | `anandi` |

v2 live branch: `newMultiOrg`.

## Scripts

| script | purpose |
|---|---|
| `scripts/lib/db.cjs` | connections + `armAutomationGuard()` |
| `scripts/lib/maps.cjs` | every v1→v2 lookup, built at run time and cross-checked |
| `scripts/lib/progress.cjs` | progress bar with rate + ETA |
| `scripts/q.cjs` | read-only ad-hoc query runner |
| `scripts/export/10-export.cjs` | **step 1** — read-only, writes files |
| `scripts/export/15-verify-export.cjs` | independent verification, different code path |
| `scripts/export/16-impact-report.cjs` | every table/column/row that would change |
| `scripts/import/05-automation-safety-check.cjs` | **proves** the automation guard works |
| `scripts/import/20-import.cjs` | **step 2** — the only writer; dry run by default |
| `scripts/30-test-checkpoint.cjs` | checkpoint self-test (no DB) — 14 assertions |
| `scripts/01..29-*.cjs` | the read-only analysis that produced the findings |

## Status — APPLIED 2026-09-22 11:18 UTC ✅ (the migration is DONE)

The user ran `--apply` on export **`2026-09-22T11-12-15-189Z`**. All 11 phases committed
(11:18:16 → 11:18:20). Independent post-apply check `scripts/40-post-apply-check.cjs`:
**23 passed, 0 failed**.

- **No message reached anyone:** 0 automation_events, 0 workflow_executions (incl. wf 82
  "UG Login Cred"), 0 email/whatsapp/sms node_executions, 0 communicationLogs hits for the
  178 touched leads. Trigger `trg_automation_v2_leads` still ENABLED for the live CRM.
- Gap after apply: v1 71,331 UG leads, v2 71,329 → only the **2 held-back** rows missing.
- Undo, if ever needed: `data/export/2026-09-22T11-12-15-189Z/runs/2026-09-22T11-18-15-710Z/rollback.sql`
  (+ backup_*.json). Contains `SET app.skip_automation='true'` — keep it.
- A re-run of `--apply` on the same export is a no-op (checkpoint: every phase done).

## What was written

```
users            1 insert (v1 722827 -> 4906862) + v1_id stamped on existing 4906770
v2_leads         163 insert + 1 gap-fill (700791: 9 empty fields; user_id/app number kept)
under_graduate   159 on new leads (156 insert + 1 orphan re-pointed + 2 applicant inserts)
                 + 14 Stream F backfills + 1 applicant-answer update (700791)
timelines 421   notes 1   lead_tags 1   ApplicationActivityTrackers 163 (+1 update)
leadScoreHistory 8
```

## Still open (NOT done — each needs the user's decision)

1. **Repoint vendor feeds + WhatsApp chatbot to v2.** Until then v1 keeps receiving UG
   leads and the gap reopens (~30-90/day). Next catch-up = re-run the same chain; it is
   incremental and idempotent.
2. The **2 held-back** duplicates: v1 2497873 (Dhairya Kohli, same person as v2 2298062)
   and v1 2498456 (shares contact with v2 2304640, different person). `held_back_for_review.csv`.
3. **Stream D** — 4 live v1 applications with no manageLeads row (712790, 720980, 730303, 730304).
4. **Stream E** — 40 drifted leads.
5. `timelines_p202605` still detached (makes `timelines_v1_timeline_id_uniq` INVALID).
6. v1 payment records (feeDues/feeTransactions) never migrated for UG — flag for finance.
7. Cosmetic: impact report says users "2 insert, 0 update"; truly 1 insert + 1 v1_id stamp.


## Status update — 2026-09-22 ~12:40 UTC (read this before anything else below)

- Main migration: APPLIED 11:18 UTC, post-check 23/23 (see above).
- User: vendor feeds + chatbot repointed to v2 = DONE (v1 quiet since 21 Sep 07h UTC).
  Stream D orphans + timelines_p202605 = IGNORE FOR NOW. The 41 drifted leads (Stream E,
  `scripts/33-lead-drift-report.cjs` -> data/review/stream_e_lead_drift.csv) = discuss AFTER Stream H.
- **Stream H repair = BUILT, NOT YET APPLIED.** Fills everything v2 is missing vs v1 on rows
  already in v2 (payment dates/partner, stage dates, submitted dates, tracker dates, form
  answers, progress flags). Rules + evidence: 04-decisions (the CORRECTION entry) and
  03-findings (Stream H). Commands: 05-runbook "Stream H repair — CURRENT".
- The user will compact, then ask for the commands. Give them one at a time, re-run the EXPORT
  fresh (live data moves), and let the user run `--apply` themselves.

### Stream H — READY FOR THE USER TO APPLY (verified 2026-09-22 ~12:30 UTC)
Latest export 2026-09-22T12-26-35-221Z: forms 50 / leads 56,888 / trackers 1,945 = 65,292 writes.
- self-test `scripts/repair/70-test-rules.cjs`: 39 passed, 0 failed (rules + SQL guard + own-event check)
- verifier: NO PROBLEMS, every planned value traced 100% to a raw v1 row, date sanity clean
- dry run: 58,882 rows, whole-row proof passed on all, 0 automation events emitted by the repair,
  1m31s total (batches of 250, set-based UPDATE, SKIP LOCKED)
Next: give the user the 7 commands in 05-runbook one at a time; RE-RUN THE EXPORT first.
Then: discuss the 41 drifted leads (Stream E).
