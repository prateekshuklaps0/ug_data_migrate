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

## Status as at 2026-09-22

- Entity mapping verified on both databases ✅
- All field mappings derived empirically and cross-checked ✅
- 10 streams covered; 2 gaps found on review and fixed (activity trackers, score history) ✅
- 7 defects found and fixed, 5 of them in these scripts ✅
- Export + verify + impact + dry run all green ✅
- Automation safety check: **8 passed, 0 failed** ✅
- Checkpoint self-test: **14 passed, 0 failed** ✅
- **Awaiting the user's `--apply`.** Nothing has been written to v2.

## Current payload (re-export before applying; vendor leads keep arriving)

```
163 leads (2 held back)   157 under_graduate   3 applicant form payloads
421 timelines   1 note   1 tag   163 activity trackers (+1 update)
8 score-history rows   1 student created (1 reused)   1 gap-fill promotion
```
