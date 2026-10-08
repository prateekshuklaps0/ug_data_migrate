# K12 — moving the intake API from v1 to v2 (the cutover)

Written 2026-10-09, after the main migration was applied on 2026-10-08. Read
`10-k12-migration.md` first; this file only covers what is different about the **cutover**.

## The situation

Today the K12 intake API still writes new leads into **v1 form 114**. The 7,488 leads that
existed on 2026-10-08 18:17 UTC are in v2 (form 128, school 18, v2 ids 2390366..2397853).
Everything v1 has taken since then is **not** in v2 yet.

At some point the intake moves to v2. That makes three jobs, in this order:

1. **catch up** everything v1 took between the migration and the switch,
2. **switch** the API,
3. **reconcile** once more afterwards, because v1 may keep taking a tail of traffic and the
   team may still be editing old leads in the v1 UI.

The scripts already handle 1 and 3. The traps below are what the scripts cannot decide for you.

## The runbook

```powershell
cd C:\Users\Prateek\Desktop\Repos

# --- before the switch -----------------------------------------------------------------
node scripts\k12\41-preflight-k12.cjs              # re-run: new counsellors/tags/stages may have appeared
node scripts\k12\43-dump-coverage-k12.cjs          # re-run: a new widget field in v1 would show up here
node scripts\import\05-automation-safety-check.cjs # the guard, again - 8 passed, 0 failed
node scripts\k12\50-export-k12.cjs                 # only leads not already in v2, plus a delta pile
node scripts\k12\60-import-k12.cjs                 # DRY RUN
node scripts\k12\60-import-k12.cjs --apply         # you run this
node scripts\k12\65-post-check-k12.cjs
node scripts\k12\66-comms-proof-k12.cjs            # 0 emails, independently

# --- columns edited in v1 since the migration ------------------------------------------
node scripts\k12\71-test-delta-k12.cjs             # re-prove the rules on live rows first
node scripts\k12\70-delta-k12.cjs                  # DRY RUN + delta_review.csv
node scripts\k12\70-delta-k12.cjs --apply          # you run this

# --- switch the API, then run the whole thing once more a day or two later -------------
```

Nothing here is new; it is the same chain that ran on 2026-10-08. The import stays
**insert-only**, so re-running it cannot damage a lead anyone is working on.

## The traps

### 1. Double-writing can create two rows for one person — FIX THIS BEFORE THE CATCH-UP

The export decides "is this lead already in v2?" by **`v1_lead_id` only**. That is correct
today, because every K12 row in v2 came from v1. It stops being correct the moment v2 starts
taking K12 leads of its own:

> A person submits the K12 form while the API still points at v1 (so they become a v1 lead),
> the API is then switched, and they submit again (so v2 creates a row natively, with
> `v1_lead_id = null`). The catch-up export still sees an unmigrated v1 lead and inserts a
> **second** row for the same person.

v2's own intake cannot protect us here, because the duplicate is created by our INSERT, not
by its API. **Before the catch-up run, the export needs a second dedup test**: for every lead
it is about to insert, look for an existing form-128 row with the same email or mobile and
`v1_lead_id IS NULL`, and report those leads instead of inserting them (they are the same
person; the natively-created row is the live one, and `70-delta-k12.cjs` can fill anything
it is missing). Ask for this and it is a short change to `50-export-k12.cjs` section 2.

Until the switch happens this cannot bite, which is why it is written down rather than built.

### 2. A returning lead with the same details is UPDATED, not duplicated — this part is fine

Read `src/v2/services/leadAndApplicantApiService.js`. After the switch, a submission is
matched on `(email OR mobile) + org + program + school + form`, so a migrated K12 lead who
submits again with the same contacts updates their existing row. No duplicate. Good.

### 3. …but a returning lead who changed their phone number gets a 409

Before that match, the intake calls `findConflictingSchoolLead`
(`src/utils/leadContactMatch.js`). It looks at every non-deleted lead **in the whole school**
and raises a conflict when one of email/mobile matches and the other contradicts:

> `409 "We noticed that you have already applied for a program. Please use the same details
> to continue."`

If both match, it returns null and all is well. Matching is an **exact string compare** after
a trim — `normalizeContact` does not strip spaces or country codes.

Measured in school 18 on 2026-10-09, after the migration:

| | emails/mobiles affected | of which are migrated K12 rows |
|---|---|---|
| an **email** carrying more than one mobile | **434** | 406 rows |
| a **mobile** carrying more than one email | **433** | 319 rows |
| the same email question, **excluding** migrated K12 rows (i.e. roughly the state before) | **63** | — |

So putting K12 into school 18 took that from ~63 emails to ~434. Mostly it is the same human
using one number for UG and another for K12. It is not a migration defect - K12 belongs in
school 18, that is what v2 says - but it means **a few hundred people may be told "you have
already applied"** when they next submit. Decide before the switch whether that is acceptable,
whether support should get the list, or whether `findConflictingSchoolLead` should be scoped
to the form rather than the school. Ask and I will produce the list as a CSV.

Our own data is not the problem: 7,420 of the 7,488 migrated mobiles are plain 10 digits, the
same shape v2 writes natively. The other 68 are junk v1 already held (lengths 1 to 12).

### 4. Timeline partitions run out after 2027-01

`timelines` has attached monthly partitions for **2026-06 through 2027-01**, plus a DEFAULT.
The importer **asserts** every timeline lands in an attached monthly partition and refuses the
run otherwise, so this fails loudly rather than silently filling `timelines_pdefault`. If the
cutover happens after 2027-01-31, create the next partitions first. (And
`timelines_p202605` is still DETACHED, which is why `timelines_v1_timeline_id_uniq` is INVALID
and timeline dedup happens in application code.)

### 5. Only the last 3 months of timeline activity is ever carried

The window is `TIMELINE_MONTHS = 3` in `lib-k12.cjs`, anchored at the start of each export.
For leads caught up at the cutover this is harmless - they are new, so their activity is
recent. But note the window **slides**: activity that was inside it on 2026-10-08 and is not
re-offered later has been migrated already (inserts are idempotent), while activity older than
the window on a lead migrated later is never carried. Widen `TIMELINE_MONTHS` if that matters,
and create the matching partitions first (trap 4).

### 6. A lead deleted in v1 after migration stays alive in v2

`60-import` is insert-only and `70-delta` is not allowed to write `is_deleted` (it is not in
`DELTA_CLASSES`). So if someone deletes a K12 lead in v1 tomorrow, its v2 row remains. That
is deliberate - a script that can delete production leads is a bigger risk than a stale row -
but at the cutover it becomes a real question, because v1 stops being the place anyone works.
0 K12 leads had been deleted in v1 as of 2026-10-09. Decide then; a report of
"deleted in v1, still active in v2" is easy to produce.

### 7. The delta will not re-point a stage or a counsellor

`70-delta-k12.cjs` treats stage, sub-stage and counsellor as FILL: written if v2 has none,
never changed if v2 already has one, and every disagreement goes to `delta_review.csv`. That
is right while people work in v2. **At the cutover it may be wrong**, because until the switch
the team is still working leads in the **v1** UI, so v1 holds the newer truth. If that is the
case, say so and the class changes for that one run - it is a line in `DELTA_CLASSES`.

### 8. The `schoolAndCity` model attribute still needs deploying

The column exists in both databases and migrated leads have it. But
`pickSatelliteFields()` resolves against the Sequelize model, so until
`src/models/UnderGraduate.js`'s `schoolAndCity` attribute is deployed, **a lead created by the
v2 widget writes "School and City" to `lead_payload` only**. If the API switches before that
deploy, new K12 leads will be missing the column that migrated ones have. The migration's
backfill statement is idempotent and can be re-run afterwards to sweep them up:

```sql
UPDATE under_graduate ug
   SET school_and_city = left(btrim(l.lead_payload::jsonb -> 'formFields' ->> 'school_and_city'), 255)
  FROM v2_leads l
 WHERE l.id = ug.lead_id AND l.form_id = 128 AND ug.school_and_city IS NULL
   AND (l.lead_payload::jsonb -> 'formFields') ? 'school_and_city';
```

### 9. The email risk does not go away

Workflows **82, 182 and 183** are published on `lead_create` for school 18 with **no form or
program filter**, and during the 2026-10-08 apply they ran 120 times each for genuine widget
leads. Every catch-up run inserts into `v2_leads` and so must run with the guard armed. The
chain does this automatically and aborts on the first event; `05-automation-safety-check.cjs`
proves it beforehand and `66-comms-proof-k12.cjs` proves it afterwards. Do not skip either.
See `incident_2026-08-18_automation_emails/README.md`.

## State on 2026-10-09

| | |
|---|---|
| live K12 leads in v1 | 7,488 |
| of those, already in v2 | 7,488 |
| **still to catch up** | **0** |
| edited in v1 since the migration | 0 |
| deleted in v1 since the migration | 0 |

So the catch-up is currently empty. It will not stay that way - v1 took 4 leads during one
six-minute window on 2026-10-08.
