# K12 migration — v1 org 68 / form 114 → v2 school 18 / form 128

Started 2026-10-08. **Nothing written yet.** Preflight: `scripts/k12/41-preflight-k12.cjs`
(read-only, 20 passed / 3 blockers / 13 decisions) — re-run it any time; it proves the
target still exists and nothing moved under us.

## Verified scope (the user gave the ids; every one was checked on both databases)

| | v1 | v2 |
|---|---|---|
| organization | 68 `UG` | 12 |
| school | 26 `K12` | **18 `Undergraduate`** |
| program | 111 `K12` | 123 `K12` |
| application form | 114 (no name) | 128 `K12`, title `K12` |
| cohort / batch | cohort 110 `Cohort-1` | batch 192 `C1` |
| round | 141 `Roun1` | round 216 `R1` |

All five v2 rows are ACTIVE; the v2 form points at batch 192 + round 216; the school's
dynamic lead table is `under_graduate` (`org_lead_tables.id` 19).
**Note:** v2 also has a school 41 literally named "K12" — it is EMPTY and is NOT the target.
The target is school 18, as the user stated and as v2 program 123 / form 128 confirm.

## What there is to move (v1 form 114)

| | count |
|---|---|
| manageLeads total | 7,585 |
| live (`isLeadDeleted = false`) | 7,479 |
| deleted | 106 (**skipped**, user's decision) |
| `userType = 'applicant'` | 8 (5 of them deleted) |
| UserTimelines | 93,834 |
| Notes | 62 |
| applicationActivityTracker | 6,285 (exactly 1 per lead) |
| LeadScoreHistories | 706 (113 leads carry a score, max 50) |
| **ApplicationManager** | **0 — there is NO application / form-answer / payment stream** |

Leads are **still arriving** (newest 2026-10-08 05:54), so the export must be re-run right
before the apply, exactly as UG.

## Mapping facts established by evidence

- **Stages:** K12 leads use the v1 **UG school-11** stage set (158/159/161/162/163/164/165
  and the applicant twin 173), so the UG stage map applies unchanged. 6,001 leads get a
  mapped stage; 1,583 have no stage in v1 and keep NULL.
  - 1,455 leads carry an **applicant-type** stage (173/306/326 "Untouched") in
    `leadStageId` → resolved BY NAME into v2 `leadStage` 132, the UG precedent.
  - 4 stage ids belong to **other v1 organisations** (109 org 66; 62/63/64 org 45) on 1 lead
    each → `lead_stage_id` NULL, the same rule UG used for stage 413.
- **Sub-stages:** all 11 in use resolve by (stage name, sub-stage name).
- **Lead score:** all 24 (criteria, mapping) pairs resolve for school 18, 0 disagreements
  with what the previous migration wrote.
- **Event types:** 7 titles the UG map never saw. `timelines.event_type` is free text
  (varchar), and 6 of the 7 targets are already used natively in v2:
  `Lead Updated`→`lead_updated`, `SMS_Sent`→`sms_sent`, `Payment Initiated`→`payment_initiated`,
  `Lead Deleted`→`lead_deleted`, `Counsellor Reassigned`→`counsellor_reassigned`,
  `Counsellor Assigned`→`counsellor_assigned`, and
  `Lead came from inbound call`→`inbound_call` (655 native rows use `inbound_call`).
- **Where lead fields live** (from 68,659 already-migrated school-18 plain leads):
  `v2_leads` carries city/state/grade/lead_payload/concat_smc, and an `under_graduate` row
  exists for the subset that has city/state/grade (34,531 of them). K12 has city 113,
  state 24, grade 5,232, leadPayload 7,571.
- **Widgets:** 3 leads carry v1 widget ids 78/89 (UG widgets, cross-contamination).
  `v2_leads.widget_id` has NO foreign key, so the v1 number is copied as UG did.
- **Timelines partitions:** rows span 2025-11 .. 2026-10. Monthly partitions exist from
  2026-06; the 26,716 older rows land in `timelines_pdefault`, which is where UG's old rows
  went. `timelines_p202605` is still DETACHED, so `timelines_v1_timeline_id_uniq` is INVALID
  and timeline dedup must be done in application code (as the UG importer does).
- **Idempotency keys** all valid: `v2_leads.v1_lead_id`, `under_graduate.v1_lead_id`,
  `notes.v1_note_id`, `lead_tags (v2_lead_id, tag_id)`, `ApplicationActivityTrackers.v1_leadId`,
  `leadScoreHistory (leadId, dedupeKey)`.

## THE EMAIL RISK (worse than it looks)

`workflow 82 "UG Login Cred"` is **published**, triggers on **lead_create** for school 18 and
has **no form or program filter** — it would email **all 7,479** leads we insert.
`workflow 81 "UG TBM or DSAI - Leads & Apps allocation"` is **active** on the same trigger and
would re-assign them. Both are stopped by `SET app.skip_automation = 'true'` at SESSION level,
proven by `scripts/import/05-automation-safety-check.cjs` before every apply.

## Decisions taken by the user — 2026-10-08

| # | decision |
|---|---|
| 1 | **Counsellors with no v2 account:** CREATE v2 accounts for `gagandeep.singh@mastersunion.org` (v1 517092, 4 leads) and `Arshi.bansal@mastersunion.org` (v1 521628, 2 leads). Aditi Suryavanshi (v1 357245, **deleted in v1**, 244 leads) gets NO account; her 244 leads are assigned to **v2 user 4911750 `soumya.sahdev@mastersunion.org`** (admin, org 12, active, currently owns 0 leads). |
| 2 | **Tags:** migrate ALL live leads with ALL tags, and CREATE the 3 missing tag names in v2 — `testingqaremovetag` (4,919 leads), `testtagbulk2703` (60), `PRIORITY` (1). The other 3 already exist: `Kollege Partnership`→80, `bulk tag testing`→81, `testing`→33. |
| 3 | **Deleted leads:** the 106 `isLeadDeleted = true` rows are NOT migrated (same as the UG catch-up). |

Decision 1 also clears the note blocker: the single note by v1 author 521628 gets a real
`admin_id` once Arshi's account exists (`notes.admin_id` is NOT NULL).

## Agent decisions for this run (override if you disagree)

| decision | why |
|---|---|
| The 6 counsellors with only a plain account (no `+1`) own their leads through that plain account | minati, prateek.sachdeva, ugadmissions, harshita.kumar, prerna.kaushik, shrashti.takrani — 15 leads in total. The other 6 use the `+1` account, which is what school-18 leads actually point at. |
| Created accounts mirror the existing UG counsellors | `role='admin'`, `user_type='Institute Users'`, `school_id=18`, `status='active'`, `v1_id` = the v1 user id, no password (they sign in through the normal flow). |
| `test_lead` is left at its default `false` | v1 has no such flag; only the 2 native v2 K12 rows are flagged, and they were QA. |
| An `under_graduate` row is created only when the lead has city, state or grade | matches how the existing school-18 rows look; ~5,2xx rows. |
| `timelines.created_by` is NULL where the v1 actor has no v2 user | 17 of 244 actors map. The already-migrated school-18 timelines are 81% authored, so NULL is normal, not a defect. |
| `template_id` NULL, `lead_id` (legacy FK) NULL, `v1_timeline_id` populated | verified on 1.69M migrated school-18 timelines: template_id 0, legacy lead_id 0. |
| All 93,834 timelines are migrated, not a 3-month window | the UG migration copied every timeline; the dev's script default (3 months) would silently drop 2025 history. |

## The scripts (all under `scripts/k12/`)

| script | what it does |
|---|---|
| `lib-k12.cjs` | the ids above, the user's decisions, the extra event-type map |
| `41-preflight-k12.cjs` | READ ONLY. Does every v1 reference have a v2 counterpart? Re-run any time. |
| `42-column-coverage-k12.cjs` | READ ONLY. Proves by evidence that every populated v1 column reaches a v2 column. |
| `43-dump-coverage-k12.cjs` | READ ONLY. Every column of the v1 lead DOWNLOAD, and the widget answers, with its v2 destination. |
| `70-delta-k12.cjs` | The RE-SYNC: updates leads that are already in v2, under the repair rules. Dry run by default. |
| `71-test-delta-k12.cjs` | READ ONLY. Proves the re-sync rules on live rows, in a rolled-back transaction. |
| `50-export-k12.cjs` | READ ONLY. Reads v1 form 114, resolves mappings against live v2, writes `data/k12/<runId>/` |
| `60-import-k12.cjs` | the only writer. Dry run by default, `--apply` commits, `--restart` ignores the checkpoint |
| `65-post-check-k12.cjs` | READ ONLY. After the apply: nothing emailed, everything landed, sample re-read from v1 |

## The commands

```powershell
cd C:\Users\Prateek\Desktop\Repos
node scripts\k12\41-preflight-k12.cjs              # 24 passed, 0 failed, 13 DECIDE
node scripts\k12\42-column-coverage-k12.cjs        # EVERY POPULATED v1 COLUMN IS ACCOUNTED FOR
node scripts\import\05-automation-safety-check.cjs # must be 8 passed, 0 failed
node scripts\k12\50-export-k12.cjs                 # fresh plan (leads are still arriving)
node scripts\k12\60-import-k12.cjs                 # DRY RUN
node scripts\k12\60-import-k12.cjs --apply         # the user runs this; resumable with the same command
node scripts\k12\65-post-check-k12.cjs             # after the apply
```

Phase order (checkpointed, each its own transaction on apply):
`staff -> tags -> leads -> under_graduate -> lead_tags -> timelines -> notes -> trackers -> score_history`

## Dry-run result 2026-10-08 (export `2026-10-08T10-24-25-704Z`)

```
staff 2 · tags 3 · leads 7,483 · under_graduate 5,242 · lead_tags 18,340
timelines 93,525 · notes 58 · trackers 6,183 · score_history 691
automation_events for these leads: 0      guard still true      rollback left 0 leads behind
```
Inserts take about a minute in total; the leads phase ~13 s, timelines ~39 s.
Counsellor set on 684 leads, stage on 5,891, applicants 3.

## Known, accepted, not defects

- **Score history does not always sum to `lead_score`** — 10 of the 163 scored K12 leads.
  v1 itself is inconsistent (its own `leadScore` is neither the sum of all history rows nor
  the sum of the latest row per criterion), and the already-migrated UG data in v2 has the
  same shape: **14,106 of 52,457** leads with history disagree. We copy v1's `lead_score`
  verbatim and migrate the history as-is; v2's own scoring engine recalculates anyway.
- **5 leads get `lead_stage_id` NULL** — their v1 stage belongs to another organisation
  (62/63/64 org 45, 109 org 66, 306/326 other v1 schools). Same rule as UG stage 413.
- **227 of 244 timeline actors have no v2 user**, so those rows get `created_by` NULL.
  The already-migrated school-18 timelines are 81% authored, so this matches.
- **4,979 tag links need the 3 tags the user asked us to create**; the dry run reports them
  as unresolved because the tags phase is rolled back with everything else.
- Leads keep arriving in v1 (4 more during a 6-minute window), so the export must be the
  last step before the apply, and a later re-run picks up the stragglers incrementally.

## Review of the colleague's script (`script_suggestion_from_dev/migrateLeadsToV2.js`, 3,256 lines)

Reviewed 2026-10-08 against the data, not by opinion. Four things were ADOPTED.

### Adopted

1. **Ad / attribution columns were being dropped.** His `LEAD_FIELD_MAP` carries `utm_*`,
   `gclid`, `fbclid`, `fb_lead_id`, `referrer`, `form_name`, `insta_handle`, `cbb_link`.
   Our UG field map had recorded these as "always NULL on a migrated lead" — true of the UG
   vendor leads it was derived from, **wrong in general**: the already-migrated school-18
   population carries gclid on 1,955 rows, fb_lead_id on 4,759, utm_term on 2,173,
   form_name on 2,543. K12 is ad-driven, so this was **5,478 real values** across ~1,500
   leads that we would have thrown away. Now in `ATTRIBUTION_FIELDS` (lib-k12.cjs).
   `fb_lead_id` needs `String()`: bigint in v1, varchar in v2.
2. **`question1..15`.** v2 has the columns and 31 already-migrated school-18 rows use
   question12; K12 has 38. Now copied.
3. **`widget_id` — he is right and we were wrong.** v1 widget ids are NOT v2 widget ids:
   v1 78 = "UG TBM Widget", **v2 78 = "PGP Bharat" on school 27**. His script nulls it
   unless an explicit map exists; ours copied the v1 number. K12 now writes NULL.
   **Pre-existing defect this exposes:** 2,217 already-migrated school-18 leads carry
   widget_id 78 (1,773) or 89 (444), which point at school-27 widgets. Not ours - the old
   sync did it - but 3 of them were filled by Stream H on 2026-09-22. School 18's real
   widgets are 38/39/48/49/68/69/70/72/82/94, and K12's own is **100 "K12 Download
   Brochure AI Buildathon"**. Offered to the user as a separate cleanup; not touched.
4. **Two smaller ideas:** `lead_stage_date` can also come from
   `applicationActivityTracker.lastLeadStageUpdated` (he used it as his only source) - we
   now take the LATEST of that and the stage timeline, never earlier than `created_at`,
   which improves 87 leads; and his `--verify` mode classifies the gap instead of counting
   it, so `65-post-check-k12.cjs` now splits "not in this export" into created-after-export
   vs other, and reports exported leads that have since been deleted or moved form.
   His up-front `information_schema` column probe became preflight section 14, which checks
   the real export payload against the live v2 schema (an export can sit overnight while
   v2 deploys).
5. **`lead_payload.__legacy`** stash for v1 columns with no v2 home, so nothing is dropped
   silently: `school` (1,437 values), `schoolAnandi`, `grades`, `programName`,
   `publisherSource`. `STASH_LEGACY = false` in lib-k12.cjs turns it off.
   Note `school` holds CITIES for K12 ("Delhi", "Hyderabad"), not school names — which is
   why it is NOT written to `under_graduate.school_name` (a 100-row sample of migrated UG
   rows matched v1 `school` exactly once).

### Rejected, with the evidence

| his approach | why not |
|---|---|
| copy v1 `uuid` into `v2_leads.uuid` "so old links still resolve" | 0 of 200 sampled migrated UG leads have v1's uuid; the previous migration always minted a new one, and `v2_leads.uuid` is UNIQUE, so copying risks a collision for no gain |
| `source ?? primarySource` fallback | on K12 `source` is never null (7,486/7,486) and the two differ on only 7 leads, so the fallback never fires; copying `source` as UG did is correct |
| `visible: true` on notes | `notes.visible` is NOT NULL **DEFAULT true** and all 84,960 school-18 notes are true, so our insert without the column is already identical |
| `notes.temp_id` = v1 note id | we populate `v1_note_id`, which has a real partial UNIQUE index and is the dedup key; `temp_id` has neither |
| timeline dedup via `metadata.__legacy.v1TimelineId` | `timelines.v1_timeline_id` is a real column with an index; a JSON path is slower and not unique-indexed |
| 3-month timeline window by default | would silently drop all of 2025 (26,716 rows). We migrate all 93,529 |
| counsellors matched by email | picks the wrong account for 17 of 19 UG counsellors (the `+1` problem). We use the account school-18 leads actually point at |
| creating stages/sub-stages org-wide (`createdStageSchoolId: null`) | would add stage rows visible to EVERY school in the live CRM. Every K12 stage already resolves by name, so nothing needs creating |
| per-row retry after a failed batch, and a re-check for a lost COMMIT ack | our writes are `ON CONFLICT DO NOTHING` on real unique indexes, so a blind re-run cannot duplicate. The one table without a usable unique index is `timelines`, and its pre-filter runs exactly when it matters (any lead not inserted by this run) |
| index plan / `--ensure-indexes` | our export reads v1 by `applicationFormId` and lead-id chunks and finishes in ~4 minutes; nothing to gain, and we do not create indexes on production |

**Still the blocking problems with his script as written:** no `app.skip_automation`
anywhere (workflow 82 would email every inserted lead), it never writes the school's
dynamic form table, it can create users/stages/tags/rounds in the live CRM, and it has live
production passwords hard-coded.

## Dry run after the review (export `2026-10-08T11-12-41-817Z`)

```
staff 2 · tags 3 · leads 7,486 · under_graduate 5,245 · lead_tags 18,340
timelines 93,529 · notes 58 · trackers 6,186 · score_history 691
+ 5,478 attribution values and 38 question12 values that the first version dropped
automation_events for these leads: 0      rollback left 0 leads behind
```
Preflight: **24 passed, 0 failed**, 13 decisions.

## Four corrections from the user — 2026-10-08 (second round)

### 1. K12 is a PROGRAMME in v2, not a school
In v1 K12 was school 26. In v2 it is **program 123 under school 18 "Undergraduate"**, sharing
that school's stages, sub-stages, lead table (`under_graduate`) and counsellors. Everything the
scripts write is scoped that way, and the accounts they create are scoped to **program 123 /
form 128**, not to the whole school. (v2 also has an unrelated, EMPTY school 41 named "K12" —
not the target.)

### 2. Every populated v1 column must reach the right v2 column — now PROVEN, not asserted
New script `scripts/k12/42-column-coverage-k12.cjs` (read-only). For a 300-row sample per
table it takes each populated v1 column and searches the exported row for a field holding the
same value, so the mapping is proven by evidence instead of a hand-written list. Anything
populated in v1 that lands nowhere, without a declared reason, FAILS the run.
Result: **EVERY POPULATED v1 COLUMN IS ACCOUNTED FOR** — manageLeads 54 carried + 1 stashed +
18 declared, UserTimelines 2 + 11, Notes 2 + 5, tracker 6 + 4, score history 1 + 7.

It found 8 columns that were landing nowhere. Each was settled with evidence:

| column | verdict |
|---|---|
| `manageLeads.leadPayload` | false alarm - the audit was skipping its own destination; it IS copied to `lead_payload` |
| `UserTimelines.date` / `.time` | the date and HH:MM parts of `createdAt` (verified on a sample), already carried in full by `created_at`; v1 also keeps `date` inside `payload` |
| `UserTimelines.isDeleted` | false on all 1,187 in-scope rows, no v2 column. The export now also filters deleted timelines out, so a future true cannot slip in |
| `UserTimelines.uuid`, `Notes.uuid` | v2 has no uuid column on either table; provenance is `v1_timeline_id` / `v1_note_id`, which are also the dedup keys |
| `LeadScoreHistories.uuid` | v2's uuid is derived deterministically from the v1 history id - and the previous migration also minted its own (0 of 20 sampled rows reuse the v1 uuid), so this matches |
| `tracker.offerLetterStatus` | the constant `'pending'` on all 6,186 in-scope rows, no v2 column - dropped exactly as the UG migration dropped it |
| `tracker.tetrTrialStarted` | `false` on all 6,186 rows; every other `tetr*` column is empty |

### 3. Created accounts now follow v2's real user-management flow
The first version wrote a bare `users` row with the v1 bcrypt hash, which would NOT have shown
up in User Management. Rewritten from v2's own
`userService.createUser()` (`new_crm_backend/src/v2/services/userService.js:727`) and
cross-checked against three live school-18 counsellors (4749645, 4805104, 4807089). The staff
phase now writes, in one transaction per account:

| table | what |
|---|---|
| `users` | `role='admin'`, `status='active'`, `user_type='Institute Users'`, `organization_id=12`, **`school_id` NULL** (createUser leaves it NULL and expresses access through `user_schools`), `country_iso`, phone, `v1_id`, and a **generated strong password** hashed with bcryptjs at 10 rounds (`BCRYPT_ROUNDS`) |
| `org_users` | `org_role='user'`, `features='{}'`, `status='active'`, display name/email, `is_primary=true`, `invited_by=4640466` (ugadmissions). **Without this row the account is invisible to User Management** |
| `user_roles` | role **66 "UG Counsellor"** (`is_counsellor_role=true`, level 1) - what the live UG counsellors hold |
| `user_schools` | school 18 |
| `user_programs` | program **123** (K12 only) |
| `user_application_forms` | form **128** (K12 only) |
| `audit_logs` | one `user.create` entry per account, actor ugadmissions, `after` naming the roles/schools/programs/forms, so the account has a provenance trail |

Each child row has its own unique key (`ON CONFLICT DO NOTHING`), so a re-run adds nothing twice.
**No onboarding email is sent** - we never call the API, so the email `createUser()` would send
never happens. The v1 password hash is NOT reused and no credential is written to any export
file; if either person needs to sign in, set a password from User Management > Change Password.
`user_reporting_managers` is left empty (the API only writes it when managers are passed, and
there is no basis for choosing one).

### 4. Timelines: only the last 3 months, each in its own monthly partition
`TIMELINE_MONTHS = 3` in `lib-k12.cjs`. The cutoff is anchored at the start of the export, so
every batch uses the same boundary. This dropped the timeline payload from **93,529 to 1,162**
rows (the bulk sat in 2026-06, now out of scope) and means **nothing lands in
`timelines_pdefault`**: the window maps onto attached monthly partitions
`timelines_p202607` 688, `p202608` 221, `p202609` 191, `p202610` 64.
The importer asserts this per run - it refuses to insert if any row's month has no attached
monthly partition - and the preflight checks the same thing up front.

### The preflight hang (user stopped the run at section 6)
Three queries were scanning millions of rows:
- the timeline-actor lookup (`distinct payload->>'userId'` over `UserTimelines`) timed out even
  at 90 s. Authorship is now read from the newest **export** instead, which is both instant and
  a check of the real payload;
- the "how authored are the existing timelines" comparison counted ~1.7M rows across every
  partition. It is now pruned to the current month, and is only reported when there are at
  least 100 rows to compare against;
- the tag section ran one scan per tag name (129 s). One `unnest(tags)` pass now does it (14 s).

Also added: `statement_timeout = 90s` on both connections, so no check can hang silently, and
each section prints how long the previous one took.


## STATE AT COMPACTION — 2026-10-08

**Nothing has been written to either database for K12.** Everything below is verified:

| check | result |
|---|---|
| `41-preflight-k12.cjs` | NO BLOCKERS — 24 passed, 0 failed, 13 decisions (all settled, listed above) |
| `42-column-coverage-k12.cjs` | EVERY POPULATED v1 COLUMN IS ACCOUNTED FOR (all 5 source tables) |
| `60-import-k12.cjs` dry run | all 9 phases, 0 automation events, rollback left 0 leads behind |

Latest export `data/k12/2026-10-08T12-03-33-511Z`; the apply must use a FRESH export, because
v1 still receives K12 leads daily (4 arrived during one 6-minute window).

Dry run, phase by phase:
```
1 staff            2 accounts created (role 66 | school 18 | program 123 | form 128), no email sent
2 tags             3 created: testingqaremovetag, testtagbulk2703, PRIORITY
3 v2_leads         7,486  (counsellor set on 684, unassigned 6,802)
4 under_graduate   5,245
5 lead_tags        18,340
6 timelines        1,162 -> p202607 686 | p202608 221 | p202609 191 | p202610 64
7 notes            58
8 trackers         6,186
9 score_history    691
verification       0 automation_events for these leads; guard still true
```

### What is NOT done / deliberately out of scope
- The 106 v1 leads deleted in v1 (user's decision).
- Timeline activity older than 3 months (user's decision) — a later run with a wider window
  would backfill it, but then the older months need their own attached partitions.
- `user_reporting_managers` for the two created accounts (no basis for picking a manager).
- **Optional cleanup, offered and not taken:** 2,217 already-migrated school-18 leads carry
  `widget_id` 78/89, which point at school-27 widgets. Pre-existing from the old sync; 3 of
  them were filled by Stream H on 2026-09-22. K12's own v2 widget is 100.
- Still open from the UG work: Stream E (41 drifted leads), the reopened UG gap (19 leads),
  2 held-back duplicates, Stream D, `timelines_p202605`, v1 payment records.


## 2026-10-08, part 2 - the three questions, and what they changed

The user asked three things before letting the apply run. One of them found a real gap.

### 1. "columns like School & City - do they exist in v2?"   A GAP, NOW FIXED

The v1 lead download is built by
`old_crm_backend/workflows/processors/csvExportProcessor.js`, and it has two halves:

* **base headers** - 72 columns read off `manageLeads`, the tracker, Notes and tags. All of
  these were already migrated. Two details came out of checking them one by one:
  * `primarySource/primaryMedium/primaryCampaign` ("Primary Source/Medium/Campaign") are
    populated on all 7,486 leads and v2 has no `primary_*` column - but they are IDENTICAL
    to source/medium/campaign on 7,479 of them. Only the 7 that genuinely differ are now
    stashed, under `lead_payload.__legacy`.
  * "Coupon Code" is a header with no column behind it. `manageLeads.couponCode` does not
    exist, so the old CRM prints that column empty for everyone. Nothing to migrate.
* **dynamic headers** - the widget answers, out of `manageLeadResponses`. **This table was
  being missed entirely.** The earlier conclusion "K12 has no application stream, so there
  are no form answers" was half right: there are no `ApplicationManager` rows, but widget
  answers hang off the LEAD, not off an application, so **13,880 answers across 6,469 of the
  7,486 live leads** were sitting there unmigrated.

**"School & City" is one of those answers** - v1 widget field **10095** (text, mandatory on
most K12 widgets), with the older field **3416 "School"** doing the same job, and on some
widgets the same answer is written straight into the `manageLeads.school` column instead.
All three are the same question, so all three now go to the same place.

Where is that place? v2's own K12 widget (**widget 100 "K12 Download Brochure AI Buildathon"**,
form 128, school 18) declares the field as `under_graduate.school_and_city` - **but that
column was never created**. v2's writer (`pickSatelliteFields`) drops any key that is not a
real model attribute, so v2 itself keeps the answer only in
`v2_leads.lead_payload.formFields.school_and_city`. Proven on the two live K12 leads the team
submitted through that widget on 2026-10-08 (v2 leads 2335621 and 2335715): both have
`formFields.school_and_city` in the payload and an otherwise EMPTY `under_graduate` row.

So the migration writes it exactly where v2 writes it, and will also fill a real column the
moment one exists:

| v1 source | leads | v2 destination |
|---|---|---|
| `manageLeads.school` | 1,437 | `lead_payload.formFields.school_and_city` |
| answer 10095 "School & City" | 527 | the same key (the lead column wins if both are set) |
| answer 3416 "School" | 297 | the same key |
| | **2,001 distinct leads** | and `under_graduate.school_and_city` too, if the column exists |

**Optional, the user's call.** Giving it a real column is one instant, metadata-only
statement - no table rewrite, no lock worth the name, so no downtime:

```sql
ALTER TABLE under_graduate ADD COLUMN school_and_city varchar(255);
```

Run it BEFORE the export and the export fills the column as well as the payload (the export
probes `information_schema`, so nothing else needs changing). Run it afterwards and
`65-post-check-k12.cjs` prints the backfill statement.

The rest of the answers now land in the `under_graduate` columns v2 itself uses for them,
found from v2's `widget_fields` / `widget_field_columns` on the school-18 widgets:

| v1 answer field | leads | v2 destination |
|---|---|---|
| 9986 + 5075 "Grade" | 6,203 | `under_graduate.grade`, and `v2_leads.grade` where the v1 lead column was empty (**1,658 leads**) |
| 5280 + 5279 "Professional Qualification" | 966 | `under_graduate.professional_qualification` |
| 6618 "Which class are you currently studying in?" | 4 | `under_graduate.current_grade_class` |
| 6619 "What is your English proficiency level?" | 4 | `lead_payload.__v1_answers` - v2 has no column |
| 7 different "City" fields | 12 | `under_graduate.city`, and `v2_leads.city` where empty |
| 8763 "Academic Enrolment Status" | 1 | `under_graduate.academic_enrolment_status` |
| 3505 "Parent Number" | 1 | `under_graduate.parent_number` |
| Full Name / Email / Phone Number | - | already carried as `registered_*` |

Anything NOT in the `ANSWERS` map in `lib-k12.cjs` is kept under
`lead_payload.__v1_answers` with its v1 label AND reported as a warning, so a new v1 widget
field can never be dropped silently.

**The effect on the payload: `under_graduate` rows went from 5,245 to 7,119, and now carry
7 columns instead of 3.**

`43-dump-coverage-k12.cjs` is the script that proves all of this, column by column, against
both live databases. Result: **72 dump columns + 23 answer fields, 0 failures.**

### 2. "if data changes in v1 after the migration, how does it get to v2?"

Three different things can change, and each has its own answer:

| what changed in v1 | what picks it up | how |
|---|---|---|
| a **brand-new lead** | `50-export` then `60-import` | the export already excludes leads that are in v2, so a re-run only carries the new ones |
| a **new note / timeline / tag / tracker date / score row** on a lead that is already in v2 | the same two scripts | the export now reads satellites for EVERY live lead, not just the new ones, and every satellite insert is keyed on a unique index, so the old ones cost nothing and only the new ones land |
| an **edited column** on a lead that is already in v2 | `70-delta-k12.cjs` | a guarded UPDATE under the repair rules |

`60-import-k12.cjs` stays **insert-only** - that property is what makes it impossible for it
to damage a lead someone is working on, and it is the version that was dry-run and reviewed.
Changing an existing lead is a different job with different rules, so it is a different
script.

`70-delta-k12.cjs` reuses `scripts/lib/repair-rules.cjs` - the module that ran the UG repair
- so it obeys the rules the user set on 2026-09-22:

* a value in v2 **never** becomes blank because v1 is blank;
* v2 is the source of truth for **content**: a column that already holds something is not
  overwritten. The disagreement goes to `delta_review.csv` for a human instead;
* **progress** moves forward only: false -> true, a higher score, a later date;
* `lead_payload` is **merged**, never replaced - which is how "School & City" reaches a lead
  that was migrated earlier;
* the stage, sub-stage and counsellor are FILL-class: they are written if v2 has none, and
  never re-pointed by a script if v2 already has one. That is deliberate - after the cutover
  the counsellors work in v2 - and every disagreement is in the review CSV, so if the team
  decides v1 should keep winning for a while, say so and the class changes.

The rules are enforced **four** times: planning, an assertion over the plan, the SQL itself
(`CASE WHEN ...`), and a re-read of every touched row that refuses to commit if a column
changed that was not planned.

`71-test-delta-k12.cjs` proves it on live rows: it plants a value in an empty column, a
different name over a full one, a blank over a full one, a lower score, and a column the
rules do not allow, runs the real script in dry run, and checks each outcome - then re-reads
the five live leads and asserts they are byte-for-byte unchanged. **11 of 11 assertions
pass.**

### 3. "if the script stops midway, does a re-run resume?"

Yes, and at two levels.

**Between phases.** `60-import-k12.cjs --apply` commits one phase at a time and writes
`checkpoint.json` after each. A phase that is already committed is SKIPPED by name on the
next run:

```
checkpoint: 3 phase(s) already committed in an earlier run - they will be SKIPPED
    staff                  at 2026-10-08T13:02:11.004Z
    tags                   at 2026-10-08T13:02:12.661Z
    leads                  at 2026-10-08T13:04:55.182Z
```

**Inside a phase.** A phase is one transaction, so a crash, a dropped connection or a Ctrl-C
leaves **nothing** half-written - Postgres rolls the whole phase back. The re-run redoes that
phase from the beginning, and every insert is keyed on a real unique index
(`v2_leads.v1_lead_id`, `notes.v1_note_id`, `lead_tags (v2_lead_id, tag_id)`,
`ApplicationActivityTrackers.v1_leadId`, `leadScoreHistory (leadId, dedupeKey)`,
`users.v1_id`, `tags (org_id, name)`; timelines are pre-filtered in code because their
unique index is INVALID), so nothing is ever inserted twice. The lead map is rebuilt from v2
on every run, so a resumed run knows the ids the earlier run created.

The checkpoint is tied to the export payload by the manifest's sha256: point the importer at
a DIFFERENT export and the old checkpoint is ignored, so a stale checkpoint cannot make it
skip work it has not done. `--restart` ignores it deliberately.

`70-delta-k12.cjs` checkpoints the same way, per batch of 200 leads.

### The commands now

```powershell
cd C:\Users\Prateek\Desktop\Repos
node scripts\k12\41-preflight-k12.cjs              # 24 passed, 0 failed, 13 DECIDE
node scripts\k12\42-column-coverage-k12.cjs        # EVERY POPULATED v1 COLUMN IS ACCOUNTED FOR
node scripts\k12\43-dump-coverage-k12.cjs          # the download columns + the widget answers, 0 failures
node scripts\import\05-automation-safety-check.cjs # must be 8 passed, 0 failed
node scripts\k12\50-export-k12.cjs                 # fresh plan (leads are still arriving)
node scripts\k12\60-import-k12.cjs                 # DRY RUN
node scripts\k12\60-import-k12.cjs --apply         # the user runs this; resumable with the same command
node scripts\k12\65-post-check-k12.cjs             # after the apply
```

For a re-sync later (any day, as often as you like):

```powershell
node scripts\k12\50-export-k12.cjs                 # new leads + new satellites + the delta pile
node scripts\k12\60-import-k12.cjs --apply         # inserts the new leads and the new satellites
node scripts\k12\71-test-delta-k12.cjs             # optional: re-prove the rules
node scripts\k12\70-delta-k12.cjs                  # DRY RUN of the updates, with a review CSV
node scripts\k12\70-delta-k12.cjs --apply          # the updates
```

### Dry run after all of this (export `2026-10-08T12-52-19-007Z`)

```
1 staff            2 accounts created (role 66 | school 18 | program 123 | form 128), no email sent
2 tags             3 created: testingqaremovetag, testtagbulk2703, PRIORITY
3 v2_leads         7,486  (counsellor 684, stage 5,891, applicants 3)
4 under_graduate   7,119  grade 6,886 | professional_qualification 966 | city 117 | state 24
                          | current_grade_class 4 | academic_enrolment_status 1 | parent_number 1
5 lead_tags        18,340
6 timelines        1,162 -> p202607 686 | p202608 221 | p202609 191 | p202610 64
7 notes            58
8 trackers         6,186
9 score_history    691
verification       0 automation_events for these leads; guard still true; rollback left 0 leads behind
```

2,001 leads carry "School & City" in `lead_payload.formFields`, and 1,658 get a grade on
`v2_leads` that the previous version of the export would have left NULL.

### A note on the coverage audit's two "did not match" flags (2026-10-08)

The first run of `42-column-coverage-k12.cjs` after the widget-answer change flagged
`leadPayload` (86 of 300 sampled) and `countryCode` (118 of 293). Both were the matcher being
too literal, and both were checked value by value before the matcher was changed:

* **`countryCode`** - 155 of the sampled rows carry a leading `+` in v1, which the export
  strips on purpose. **0 differences were anything else.** v2's own convention is without the
  plus: 80,994 school-18 rows against 335 with it. The audit now treats `+91` and `91` as the
  same dialling code.
* **`leadPayload`** - 88 of the sampled rows differ only by keys the export ADDS
  (`formFields`, `__legacy`, `__v1_answers`). **0 differences were anything else**, and every
  key v1 already had kept its value. The audit now removes those three keys (and, where v1
  had a `formFields` of its own, keeps only the keys v1 had) before comparing, so it proves
  the v1 blob survived intact rather than just assuming it.

After the fix: every one of the 300 sampled values per table matches exactly.

One cosmetic artefact to be aware of when reading that report: it names a destination by
searching for a field holding the same VALUE, so when two columns happen to hold identical
values it can name either. `lastLeadStageUpdated -> counsellor_first_activity_date` is that -
the tracker dates are frequently equal on the same row. The tracker is in fact a
column-for-column copy (the `TRK` list in `50-export-k12.cjs`); no names are crossed.

### Two more decisions, 2026-10-08 (found while checking the fresh export)

**A disabled v2 account must not be handed a lead by an email guess.** The counsellor
resolver has three paths: the user's reassignment decision, the account already-migrated
school-18 leads observably use, and - last - a match on the email address. Only the last is a
guess, and for `rahul1@mastersunion.org` (v1 "Rahul QA") it landed on v2 account 4542555,
which is `status = 'disabled'`. 12 of the 13 accounts this migration assigns to are active;
that was the one. The email path now refuses a disabled account and leaves the lead
UNASSIGNED with a warning naming the account, which is better than an owner nobody can sign
in as. The other two paths are evidence, not guesses, and are unchanged - they are what
school-18 leads already point at. Effect on this run: 1 test lead, v1 2505898 "Rahul test".

Worth knowing: preflight section 5 reported 4542722 for that person as a "+1 account". That
is a *student* row on school 27 - the preflight's +1 probe does not filter by role, the
export's does. The export was right; the preflight line is cosmetic and only appears in a
DECIDE block. See [[ug-v2-counsellor-plus1-accounts]].

**The 5 foreign-organisation stages stay NULL** (user's decision, 2026-10-08). School 18 has
a stage of the same name for all five, so name-mapping them was possible, but the rule agreed
for UG - a stage belonging to another organisation is not guessed into this school's stage
set (the v1 stage 413 precedent) - wins. The leads:

| v1 lead | v1 stage, and the org that owns it | what school 18 would have offered |
|---|---|---|
| 583707 | 63 "NOT INTERESTED" (org 45 / school 20) | 135 Not interested |
| 287639 | 64 "NOT ELIGIBLE" (org 45 / school 20) | 137 Not Eligible |
| 1316333 | 109 "UNTOUCHED" (org 66 / school 10) | 132 Untouched |
| 1557292 | 326 "Untouched" (applicant-type) | 132 Untouched |
| 2060966 | 306 "Untouched" (applicant-type) | 132 Untouched |

1,592 other leads arrive with a NULL stage simply because v1 has none for them, and v2
displays a stageless lead as untouched, so only the first two lose anything a person would
notice. Set them by hand if it matters.

**The School & City numbers, from the export files rather than the log:** 2,002 rows carry
`under_graduate.school_and_city` and 2,002 leads carry
`lead_payload.formFields.school_and_city`. 276 leads get an `under_graduate` row they would
not otherwise have had (7,397 rows against 7,119 before the column existed). The export's
5a report used to show only the two widget-answer fields reaching the column, because the
`manageLeads.school` path logged only its payload destination - a reporting bug, now fixed;
the data was always written to both.

## APPLIED — 2026-10-08 18:17 UTC

**The K12 migration is committed and verified.** Export `2026-10-08T18-13-47-160Z`,
apply run `runs/2026-10-08T18-17-11-381Z` (holds `rollback.sql` and `summary.json`).

```
staff 2 · tags 3 · v2_leads 7,488 · under_graduate 7,397 · lead_tags 18,340
timelines 1,159 · notes 58 · trackers 6,188 · score_history 691
```

Verified three ways, all green:

| check | result |
|---|---|
| `65-post-check-k12.cjs` | **22 passed, 0 failed** — every count reconciles with the export, 80 sampled leads match v1 field by field, all three user decisions confirmed |
| `66-comms-proof-k12.cjs` | **NOTHING REACHED A REAL PERSON** — 0 across automation_events, workflow_executions, node_executions and communicationAudiences, by id list AND by id range |
| the apply itself | `automation_events for these leads: 0` after every one of the 9 phases |

The v2 lead ids are the contiguous block **2390366 .. 2397853**.

**The guard was not theoretical.** During the apply, workflows 82, 182 and 183 ran **120 times
each** — for genuine school-18 leads arriving through the widget every three or four minutes
(form 104/105, `v1_lead_id` null), the last at 18:11:27, six minutes before the apply began.
The engine was fully awake and simply never received an event for any of our 7,488 leads.
Without `app.skip_automation` this would have been 7,488 × 3 executions carrying email and
WhatsApp nodes — a larger repeat of 2026-08-18.

### Reconciling the numbers you see in the CRM

`v2_leads` on form 128 shows **7,490**, not 7,488: the other two are native leads the team
submitted through widget 100 on 2026-10-08 (`v1_lead_id` is null). Everything else follows -
unassigned 6,807 = our 6,805 + 2, `with_grade` 6,890 = 6,888 + 2. Stage spread: 5,815
Untouched, 1,597 with no stage (1,592 that v1 has no stage for, plus the 5 foreign-org ones
left NULL by decision), 63 No Contact Established, 6 Not Eligible, 4 Duplicate lead,
3 Not interested, 1 Test lead, 1 Counseled.

### Follow-ups, none urgent

1. **Set passwords for the two new accounts** - `gagandeep.singh@mastersunion.org` (v2
   4915669) and `arshi.bansal@mastersunion.org` (v2 4915670). Each was created with a
   generated password that was never emailed and is not stored anywhere, deliberately: that
   is how the onboarding email was avoided. Use User Management.
2. **Deploy the `UnderGraduate` model change** (`schoolAndCity`). The column exists in both
   databases now, and the migration backfilled it, but until the model attribute ships,
   `pickSatelliteFields()` still cannot see it and the live K12 widget will keep writing
   "School and City" to `lead_payload` only. The migration's own backfill statement is
   idempotent, so it can be re-run after the deploy if any leads arrive in between.
3. **Redistribute the 240 reassigned leads** - `reassigned_leads.csv` in the export folder.
   They all point at Soumya Sahdev (4911750) by the decision of 2026-10-08.
4. **The 5 leads with no stage** (583707, 287639, 1316333, 1557292, 2060966) - set by hand if
   the two meaningful ones matter.
5. **The re-sync** is now the live path: `50-export` → `60-import --apply` for new leads and
   new satellites on existing ones, then `70-delta-k12.cjs` for columns edited in v1 since.
   `71-test-delta-k12.cjs` re-proves the rules on live rows first. The export's
   `delta_leads.ndjson` will stop being empty from the next run onwards.

## 2026-10-09 — "did you miss any columns?" A table sweep, and one real gap

The user asked why `under_graduate.school_name` is NULL for every K12 row when v1 clearly
holds school names. Checked:

**Nothing was dropped.** In v1 a school name exists for K12 leads in exactly one field,
reaching the row three ways because the widgets are not wired alike:

| v1 location | leads | note |
|---|---|---|
| `manageLeads.school` | 1,438 | the answer to the widget field **"School & City"** |
| widget answer 10095 "School & City" | 527 | same question |
| widget answer 3416 "School" | 297 | same question, older field |
| `leadPayload.school` | 1,484 | v1's own copy of the same value |
| `manageLeads.schoolAnandi` | **0** | empty for K12 |
| any field labelled "School Name" (348, 3851) | **0** | no K12 lead has ever answered one |

All of it is in v2, in `under_graduate.school_and_city` (2,002 rows) and
`lead_payload.formFields.school_and_city`. `school_name` is NULL **by choice**: it is a
different UG widget field (4,587 UG rows use it for an actual school), and the K12 values are
mixed - "Ridge Valley School Gurugram" and "DAV Model school IIT kgp", but also "Mumbai",
"Pune", "eee", "tyfgjfghjk". Putting those in `school_name` labels cities and junk as schools.
That was a judgement that should have been offered as a decision, not just documented.

### But the question underneath it was right: the SCOPE was never verified

`42-column-coverage` and `43-dump-coverage` prove every populated COLUMN of the six tables we
chose. Neither ever asked whether those were the right six TABLES. Sweeping every v1 table
with a `leadId` / `manageLeadId` column (20 of them) against the 7,488 live K12 leads:

| v1 table | rows for K12 | leads | verdict |
|---|---|---|---|
| `UserTimelines` | 93,531 | - | MIGRATED (last 3 months, by decision) |
| `communicationAudiences` | 53,235 | 7,488 | **not migrated** - sent-communication history |
| `manageLeadResponses` | 13,882 | 6,471 | MIGRATED |
| `userTimeLineDumps` | 10,760 | 2,941 | **not migrated** - but see below, all of it predates the window |
| `applicationActivityTracker` | 6,188 | - | MIGRATED |
| `LeadScoreHistories` | 691 | - | MIGRATED |
| `whatsappChats` | 400 | 392 | **not migrated** - chat threads, 2026-09-25..10-07 |
| `leadActivityTracker` | 80 | 74 | **not migrated** - 0 follow-up dates, 1 non-empty note |
| `wabaSupressions` | 64 | 63 | **NOT MIGRATED - AND IT MATTERS, see below** |
| `Notes` | 58 | - | MIGRATED |
| `workflowExcludedUsers` | 1 | 1 | **not migrated** - references v1 workflow 335, no v2 counterpart |
| 8 more (`CalendarEvents`, `StudentTimelines`, `councellorCalls`, `facebookCapiEvents`, `googleEventCheck`, `leadCallLogs`, `leadChatbotResponses`, + 2 uuid-keyed workflow tables) | **0** | - | empty for K12 |

### The one that matters: `wabaSupressions` — 63 people who unsubscribed from WhatsApp

`event = 'unsubscribed'`, `supressionType = 'auto'`, with the lead's phone number. **v2 has
the same table and actively uses it - 857 rows for school-18 leads.** The UG migration never
carried it either (no provenance column in v2), so this is a pre-existing hole, not just a
K12 one.

Why it matters more than the others: workflows **182 and 183** are published on `lead_create`
for school 18 and contain **WhatsApp** nodes. v2 does not know these 63 people opted out, so
a future campaign could message someone who unsubscribed. That is a consent problem, not a
completeness one. **Recommend carrying it.** 63 rows, keyed per lead, no automation trigger on
that table.

### The rest, with reasons

- **`userTimeLineDumps` (10,760 rows / 2,941 leads)** - same shape as `UserTimelines`
  (eventType, message, date, time, leadStageId, payload); it is where older timeline events
  were archived. Range **2025-06-09 .. 2025-11-08**, and the migration's window starts
  2026-07-09, so **every row is already out of scope** under the 3-month decision. No action
  unless the window widens.
- **`communicationAudiences` (53,235 rows / all 7,488 leads)** - the record of emails and
  WhatsApps sent to each lead. Each row hangs off a `communicationLogId` campaign in
  `communicationLogs`, which is not migrated either, so importing the audience rows alone
  would leave them pointing at nothing. Carrying comms history is its own project; the UG
  migration did not do it. **Stated as deliberately out of scope**, not overlooked.
- **`whatsappChats` (400 threads / 392 leads, 2026-09-25..10-07)** - thread headers (last
  message preview, unread count, assignment), not the message bodies. v2 has the table but
  holds **0 rows for any school-18 lead**, so v2's WhatsApp inbox is not in use for this
  school yet. Migrating threads into an unused inbox is premature. Revisit when school 18
  starts using it.
- **`leadActivityTracker` (80 rows / 74 leads)** - 0 follow-up dates, 1 non-empty note
  ("CALL ABANDONED"). The stage information it carries is already in the timelines. Negligible.
- **`workflowExcludedUsers` (1 row)** - excludes lead 2060966 from v1 workflow 335. v1
  workflow ids mean nothing in v2. Negligible.

### Lesson

Verify the **table list** before verifying the columns in it. A coverage audit that starts
from a chosen set of tables can only ever prove that set complete. The sweep above
(`information_schema` for every `leadId`/`manageLeadId` column, counted against the in-scope
lead ids) takes a minute and should run before any future migration's export is written.

---

## 2026-10-09 — tester finding: 28 K12 leads with a NULL `lead_score`

The tester listed 28 email/mobile pairs whose lead score reads blank in v2 and asked for 0.
Checked against both databases before touching anything
(`scripts/k12/80-fix-null-lead-score-k12.cjs`, dry run):

| question | answer |
|---|---|
| do the 28 resolve to form 128? | yes, all 28, **0 unresolved** |
| are they ours? | yes — all 28 carry a `v1_lead_id` and all sit in the import id range 2390366–2397853 |
| is the score really NULL in v2? | yes, all 28 |
| **what did v1 hold?** | **`"manageLeads"."leadScore"` IS NULL for all 28** |
| is 28 the whole set? | yes — form 128 has 7,490 live leads: **28 NULL**, 7,354 at `0`, 74 above `0`. The 28 NULLs are exactly the 28 the tester found, and all 28 are migrated rows (the 2 native v2 K12 rows are both `0`). |

So **nothing was lost or mis-read**: the import copied v1 faithfully. It is a *convention*
mismatch. `V2Lead.leadScore` carries `defaultValue: 0` in the model
(`new_crm_backend/src/models/V2Lead.js:384`) while the **column has no DB default**
(`20260308100000-v2-schema.cjs:521` → `allowNull: true`, no default). So every lead the v2 app
creates gets `0`, and only a raw insert — ours — can leave a NULL. The app reads it as 0 anyway
(`manageLeadService.js:3453` → `Number(r.leadScore) || 0`), which is why this is cosmetic in the
UI but still wrong in the data. The tester is right.

**Not unique to K12, and not ours to fix beyond K12.** School 18 holds other NULLs:
form 74 → 214 of 214, form 104 → 138, form 105 → 6; CRM-wide 54,354 of 1,184,064. The fix
script is scoped to `form_id = 128 AND v1_lead_id IS NOT NULL` on purpose — only rows this
migration created.

### `scripts/k12/80-fix-null-lead-score-k12.cjs`

Dry run by default; `--apply` commits. Guarantees:

- `app.skip_automation = 'true'` at **session** level, read back, re-verified after COMMIT.
- Verified at run time that the live `emit_automation_event()` **already** returns early when
  the changed set is within `ARRAY['lead_score','updated_at']` — the clause came in with
  `20260928110000-skip-updated-at-only-automation-events.cjs`. So this UPDATE raises no event
  even without the session guard. Two independent reasons no comms can fire.
- **v1 is re-read and the run REFUSES** if any candidate has a non-NULL score in v1 — such a
  row would be a real migration miss needing its true value, not a blanket 0.
- `WHERE lead_score IS NULL` lives **in the statement**, so a score the CRM computed between
  plan and write can never be overwritten (the `v2-is-source-of-truth` rule).
- `updated_at` is not written, so a later audit can still tell an app edit from ours.
- Whole-row `to_jsonb` proof before/after: any column other than `lead_score` moving aborts.
- One short transaction for 28 rows; `leadscore_undo.sql` + `leadscore_changed.csv` on apply.

**Dry run 2026-10-09: 9 passed, 0 failed**, and a re-read afterwards still showed 28 NULL,
proving the rollback held. No `leadScoreHistory` row is written — this is a default correction,
not a scoring event, and the real column there is `leadId`, not `lead_id`.

### APPLIED — 2026-10-09 06:43 UTC

`node scripts/k12/80-fix-null-lead-score-k12.cjs --apply`, run by the user. **12 passed, 0 failed.**
Then verified again from a fresh read-only connection, **10 passed, 0 failed**:

- all 28 ids read `lead_score = 0`;
- form 128 now holds 7,490 live leads → **0 NULL**, 7,382 at `0`, **74 above 0 untouched**;
- `updated_at` on all 28 still reads its pre-migration value (latest 2026-05-11), so the rows
  remain distinguishable from an app edit;
- **0 emails, 0 WhatsApp** — `automation_events`, `workflow_executions` and
  `communicationAudiences` all hold 0 rows for these leads since the run began;
- `leadscore_undo.sql` (restores all 28 to NULL) and `leadscore_changed.csv` (28 rows) are in
  `data/k12/leadscore-fix-2026-10-09T06-43-34-219Z/`.

Left alone on purpose: the other school-18 forms (74 → 214 NULL, 104 → 138, 105 → 6) and the
54,354 CRM-wide. If the team wants those normalised it is a separate decision, and better fixed
by giving the column a DB default than by a one-off UPDATE.

---

## 2026-10-09 12:17 IST — incident: all 7,490 K12 leads set to stage 132, and the repair

```sql
-- run by hand, no stage filter, no app.skip_automation
UPDATE v2_leads SET lead_stage_id = 132 WHERE form_id = 128;
```

The intent was to give stage 132 "Untouched" to the K12 leads whose stage was **NULL**. The
missing `AND lead_stage_id IS NULL` made it hit every row in the form.

### What it actually cost — measured, not assumed

The trigger logs an event only for a row it really changed, so `automation_events` is an exact
census of the damage: **1,675 of 7,490 rows changed**, the other 5,815 were already 132.

| was | became | count | verdict |
|---|---|---|---|
| NULL | 132 | **1,597** | the intended fill — left at 132 |
| a real stage | 132 | **78** | the damage — restored |

The 78 by what they lost: `133` No Contact Established 63, `137` Not Eligible 6, `138`
Duplicate lead 4, `135` Not interested 3, `136` Counseled 1, `140` Test lead 1. The 2 native v2
K12 rows (QA submissions `kjewjh@kjwe.com`, `kjwefhkj@kjewh.com`) were already 132 and raised no
event. `lead_stage_date` was not in the statement, so it never moved — restoring
`lead_stage_id` alone put the rows back exactly as they were.

### No comms, and for a structural reason

Every **published** workflow on school 18 triggers on `lead_create`, `regular_interval`,
`application_form_complete` or `application_form_progress`. **None triggers on a stage change**,
so an `UPDATE` of `lead_stage_id` cannot start one however it is run. Verified on four layers:
0 `workflow_executions`, 0 `node_executions` and 0 `communicationAudiences` for any lead we
migrated — *ever*, not just today. The 1,675 events were all `status=done`, no action matched.

The only genuine runs on form 128 are **4**, both on the 2 native QA leads at the second they
were created on 2026-10-08 (workflows 81 and 82, `lead_create`). Their 8 `node_executions` are
all `type=trigger` or `type=isElse` — **no email/whatsapp/sms node has ever executed on this
form**. Asserting 0 runs on the *form* would have meant the CRM was broken; the right assertion
is 0 runs on a lead **we** migrated, and that is what passed.

### `scripts/k12/81-restore-lead-stage-k12.cjs`

**Two independent sources of truth, and it refuses per row unless they agree:**

1. `automation_events.before_data->>'lead_stage_id'` — what the row held moments before, written
   by the trigger itself.
2. `data/k12/2026-10-08T18-13-47-160Z/leads.ndjson` — the stage this migration imported from v1.

They agreed on all 78, which also **proves no counsellor had changed a K12 stage in v2** between
the migration and the accident. Plus: session-level `app.skip_automation` read back and
re-verified after COMMIT; `WHERE lead_stage_id = 132` inside the statement so a stage set between
plan and write is never overwritten; `updated_at` and `lead_stage_date` never written; whole-row
`to_jsonb` proof; one short transaction; `--also-revert-nulls` offered for putting the 1,597
back to NULL instead (not used).

### APPLIED — 2026-10-09 06:54 UTC, 11 passed / 0 failed

Verified again from a fresh read-only connection, per lead, **10 passed / 0 failed**:
78 restored, 1,597 intentionally at 132, 5,815 never changed; the distribution is now exactly the
export's with the NULLs folded into 132 (**7,412** = 5,813 + 1,597 + 2 native); no row carries an
`updated_at` from today; all 7,490 still carry a `lead_stage_date`; all four comms layers clean.
Undo + CSV in `data/k12/stage-restore-2026-10-09T06-54-40-261Z/`.

### The lesson, for next time

`automation_events.before_data` is a **full row image taken immediately before any change**, kept
for every UPDATE that is not confined to `lead_score`/`updated_at`. It is the fastest and most
exact undo source for an accidental write on `v2_leads` — better than a backup, because it is
per-row and already in the database. It is only as good as its retention, so **look there first
and within the day**. Cross-check it against a second source before trusting it.

### Noticed in passing, unrelated

At 00:34 IST today, 117 form-128 leads had `registered_email` rewritten from
`Chandoluthanmay@gmail.com` to `chandoluthanmay@gmail.com`. Something lowercases emails on a
schedule. Harmless, and not from any of our scripts, but worth knowing it runs.
