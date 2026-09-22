# Coverage: every stream, migrated or deliberately not

Asked on 2026-09-22: *"are you migrating application activity trackers, application form data,
lead score, payment data and dates, do the counsellors exist, and edge cases?"*

Checked against the data, not from memory. Script: `scripts/27-coverage-deep.cjs` → **NO ISSUES**.

## Migrated (9 streams)

| stream | v1 source | v2 target | in this batch |
|---|---|---|---|
| leads | `manageLeads` | `v2_leads` | 163 |
| lead stage / sub-stage | `leadStageId`, `leadSubStageId` | mapped by name | 163 / 2 |
| application stage / sub-stage | `ApplicationManager` | mapped by name | 2 / 0 |
| form data (leads) | `manageLeads` | `under_graduate` | 157 |
| form data (applicants) | `ApplicationResponses` | `under_graduate` | 3 payloads, 37 columns |
| timelines | `UserTimelines` | `timelines` | 421 |
| notes | `Notes` | `notes` | 1 |
| tags | `manageLeads.tags` | `lead_tags` | 1 |
| **activity trackers** | `applicationActivityTracker` | `ApplicationActivityTrackers` | **163 + 1 update** |
| **lead score history** | `LeadScoreHistories` | `leadScoreHistory` (`source='v1_history'`) | **8** |
| students | `users` | `users` (role=student) | 1 created, 1 reused |

### Sparse ≠ missing

Sub-stages and tags look absent but are not: **v1 itself has only 2 sub-stages and 1 tag** across
the 163. These are brand-new untouched vendor leads (157 are stage "Untouched"). The
already-migrated population is 80.9% sub-staged because those are *worked* leads. Writing a
value v1 does not have would be inventing data.

### Lead score

`lead_score` is copied verbatim — verified on all 163. The score **history** is migrated too, and
the running total reconciles: lead 2498205's 5 history rows sum to 9, which is exactly its
`lead_score`. The export **fails** if any lead's history does not sum to its score.

Criteria and mapping ids are resolved **by name**, then cross-checked against 4,000 already-
migrated rows: **0 disagreements**. `delta` and `mappingValue` are the v1 score;
`scoreBefore`/`leadScore` are a running total in `createdAt` order.

### Activity trackers

One row per **lead**, not per application. Column-for-column copy, verified identical on
**2,291 of 2,291** rows untouched since migration. Every populated v1 column is carried. v1's
`tetr*` and `offerLetterStatus` columns have no v2 destination and are dropped — as before.

### Payments

All 163 leads and both new applications are `pending` in v1, and the export carries exactly that.
Ananya's completed payment is handled by the gap-fill promotion.

**Payment *records* are deliberately not migrated**: v2 holds **0** `feeDues` rows for any UG
lead, including the 2,427 applicants already migrated — while 586 of them are marked paid. This
migration matches that existing (imperfect) convention rather than inventing a new one. Flagged
as an open item, not silently handled.

### Counsellors

All 8 exist, are `active`, belong to org 12 — and each **already owns thousands of UG leads**
in v2 (2,764 to 5,521 each). That is the strongest available evidence the `+1`-account mapping
matches live ownership rather than a guess.

## Deliberately NOT migrated

| v1 stream | why |
|---|---|
| `leadActivityTracker` (5.9M rows) | v2 has no such table; the previous migration never wrote one. The 2 rows for in-scope leads carry no note and no follow-up date — the same events already arrive as `Changed_Lead_Stage` timelines. |
| `leadStageLogs` | v2 has 14,963 UG rows, **0** carrying `v1_id` — all v2-native. |
| `feedues` / `feeTransactions` | 0 UG rows in v2 for 2,427 migrated applicants. |
| v1 `templateId` on timelines | dropped on all 17,903 copied rows; the FK points at v2 templates. |

## Edge cases — all benign, all v1's own values

| | count |
|---|---|
| email literally `na` | 4 |
| mobile literally `NA` | 1 |
| missing country code | 1 |
| city literally `NA` | 1 |
| created_at in the future | 0 |
| updated_at before created_at | 0 |
| duplicate email/mobile **within** the batch | 0 |
| value exceeding its v2 column length | 0 |
| non-India country code | 0 |
