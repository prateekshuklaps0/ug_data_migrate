# Runbook

The agent runs steps 1–4. **The user runs step 5.**

## Step 0 — prove the automation guard works (before every apply)

```powershell
cd C:\Users\Prateek\Desktop\Repos
node scripts\import\05-automation-safety-check.cjs
```

Runs both halves of the experiment against the live DB inside rolled-back transactions:
guard OFF must produce an event, guard ON must produce none. Expect **8 passed, 0 failed**.
If anything fails, **do not apply**.

## Steps 1–4 — export, verify, impact, dry run (writes nothing)

```powershell
cd C:\Users\Prateek\Desktop\Repos
node scripts\export\10-export.cjs && node scripts\export\15-verify-export.cjs && node scripts\export\16-impact-report.cjs && node scripts\import\20-import.cjs
```

- **10-export** — reads v1, resolves every mapping against live v2, writes
  `data\export\<timestamp>\`. Aborts rather than guess if any mapping fails.
- **15-verify-export** — re-derives the expected values by a *different* route, so an exporter
  bug does not simply repeat itself. Exit code 1 if anything fails.
- **16-impact-report** — every table, column and row that would change, plus ready-made SQL.
- **20-import** (no flag) — **dry run**: runs the entire import inside one transaction, rolls it
  back, then re-queries to confirm nothing survived.

Then read `review_leads.csv` and `held_back_for_review.csv` by hand.

## Step 5 — apply (the user runs this)

```powershell
cd C:\Users\Prateek\Desktop\Repos
node scripts\import\20-import.cjs --apply
```

Each phase commits separately. After every commit the script rewrites `rollback.sql` and
updates `checkpoint.json`.

Options:
- `--run <timestamp>` — pick a specific export folder instead of the newest
- `--restart` — ignore the checkpoint and re-run every phase (safe; writes are idempotent)

## If it dies half way

Just run the same `--apply` command again. It will report the completed phases as
`SKIPPED (checkpoint)` and continue from the first one that did not finish. Every write is
idempotent through a unique index, so even without the checkpoint a re-run is correct.
See `07-checkpoint-and-resume.md`.

## Artefacts per apply

`data\export\<export>\runs\<timestamp>\`:

| file | what |
|---|---|
| `rollback.sql` | undoes the run; rewritten after every committed phase |
| `summary.json` | counts and the automation-event baseline |
| `backup_promotions.json` | the v2_leads row before the promotion |
| `backup_under_graduate.json` | rows re-pointed |
| `backup_under_graduate_applicant.json` | rows whose form answers were overwritten |
| `backup_activity_trackers.json` | tracker rows before refresh |

`checkpoint.json` lives one level up, in the export folder, shared by every apply of that payload.

## The check that matters, after applying

```sql
-- must be 0
SELECT count(*) FROM automation_events
WHERE table_name = 'v2_leads'
  AND row_id IN (SELECT id FROM v2_leads
                 WHERE org_id = 12 AND school_id = 18 AND v1_lead_id IS NOT NULL);
```

Non-zero for rows this run wrote → pause workflow **82** first, then 25 and 29, then read
`incident_2026-08-18_automation_emails/README.md`.

**Connect your DB client to `anandi` on `anandi.c1nvajieufmh.ap-south-1.rds.amazonaws.com`.**
If `automation_events` "does not exist", you are on the wrong database.
