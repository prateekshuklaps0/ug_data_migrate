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

## Stream G repair (rows ALREADY in v2 that fell behind v1) — built 2026-09-22

Separate pipeline under `scripts/repair/`, output under `data/repair/<runId>/`.
Rules: `scripts/lib/repair-rules.cjs` — fill empty or move forward ONLY; the importer locks
each row and re-applies the rules to its LIVE values at apply time.

```powershell
node scripts\import\05-automation-safety-check.cjs      # must be 8 passed
node scripts\repair\50-export-repair.cjs                # read-only; G1/G2/G3 plan
node scripts\repair\55-verify-repair.cjs                # independent; NO PROBLEMS
node scripts\repair\60-import-repair.cjs                # dry run
node scripts\repair\60-import-repair.cjs --apply        # user only
node scripts\repair\65-post-repair-check.cjs            # after apply
```
SUPERSEDED by fill-only (see 04-decisions). Old forward-mode dry run: G1 9 applicants / 49 fields,
G2 7 applicants, G3 23 trackers, 0 automation events, 0 still behind, rollback confirmed.
Ayushman (1862460) payment pending->completed backed by v1 feedues #57200 (Rs 500, razorpay,
plink_TdZPWezIaHxMmL, paid 2026-09-19 04:21 UTC); his v2 tracker already had paid-on.
Deliberately NOT touched: 41 applicants whose v2 form row is newer than the last v1 edit;
~300 wording "conflicts" (v2 wins); counsellor-side tracker columns (v2 owns);
31 paid-in-v2/pending-in-v1 (v2 wins).
Fill-only dry run 2026-09-22 (export 2026-09-22T11-51-35-422Z): G1 9 applicants / 49 fields,
G2 1 field (Aaliyah last_interacted_section NULL->3), G3 2 trackers / 3 dates; whole-row proof
12/12; 0 automation events; rollback confirmed. Run `node scripts\repair\70-test-rules.cjs` first.

## Stream H repair — CURRENT (supersedes the Stream G fill-only plan, which was never applied)

Run from C:/Users/Prateek/Desktop/Repos, one at a time (PowerShell uses backslashes):
    node scripts/repair/70-test-rules.cjs               -> 36 passed, 0 failed
    node scripts/import/05-automation-safety-check.cjs  -> 8 passed, 0 failed
    node scripts/repair/50-export-repair.cjs            -> read-only plan -> data/repair/<runId>/
    node scripts/repair/55-verify-repair.cjs            -> VERIFY FINISHED - NO PROBLEMS
    node scripts/repair/60-import-repair.cjs            -> DRY RUN (every batch rolled back)
    node scripts/repair/60-import-repair.cjs --apply    -> user only; resumable with the same command
    node scripts/repair/65-post-repair-check.cjs        -> after apply

Importer: batches of 250, own transaction each, 60 ms pause, lock_timeout 3s, FOR UPDATE SKIP
LOCKED (busy rows retried at end of phase; if still busy, re-run later), automation_events checked
inside EVERY batch before commit/rollback, checkpoint per batch, rollback.sql appended per
committed batch. Re-run the EXPORT right before applying - live data moves.
