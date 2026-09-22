# Decisions and open questions

## Taken by the user — 2026-09-22

| # | decision | consequence |
|---|---|---|
| 1 | **Scope = Streams A + B + C.** The 165 missing leads, their timelines/notes/tags, and the applications that have a `manageLeads` row. | Stream D (87 orphan applications) and Stream E (40 drifted leads) are explicitly OUT of this migration. |
| 2 | **Hold duplicate collisions back** for manual review rather than importing them. | The export writes `held_back_for_review.csv`; those leads are not imported. |
| 3 | **Populate `timelines.v1_timeline_id`**, unlike the previous migration which left it NULL. | Activates `timelines_v1_timeline_id_uniq`, so the timeline import is safely re-runnable. Applied to `notes.v1_note_id` for the same reason. |

## Decisions taken by the agent, with the evidence

| decision | why |
|---|---|
| Counsellors are mapped from **observed migrated rows**, not from email or `users.v1_id`. | Email matching picks the wrong account for 17 of 19 UG counsellors (the `+1` account problem). |
| `timelines.template_id` is written as **NULL**. | Verified: all 17,903 copied rows in the existing migration have NULL. v1 template ids point at v1 templates; `timelines.template_id` has an FK to v2 `communicationTemplates`, so copying them would mis-point or fail. |
| `previous_lead_stage` is **NULL** when the v1 stage belongs to another school. | v1 stage 413 is a PGP UI UX (school 41) stage that leaked into 2 UG lead rows and 4 UG timelines. There is no UG equivalent to map it to. |
| v1 payment records (`feedues` / `feeTransactions`) are **not** migrated. | Matches the previous migration; v2 holds no payment rows for the 2,427 migrated UG applicants either. |
| `payment_completed_at` is left **NULL** on the promoted applicant. | 42 of 60 sampled already-migrated *paid* applicants have NULL. The paid state is carried by `payment_status='completed'`, `is_payment_done=true`, `payment_mode='online'`. |
| `'Stage Assigned'` maps to `stage_assigned`. | The previous migration never produced it, but v2 already holds 6,628 natively-written `stage_assigned` rows, so the snake_case form is the established v2 value. |
| Malformed v1 dates are dropped, not coerced. | 137 of 963 sampled v1 `Date of Birth` answers are junk (`2-06-06`, `NaN-NaN-NaN`); the previous migration normalised or dropped them. |

## Open questions — NOT part of this migration

1. **Vendor feeds still write only to v1.** Collegewollege, Dekhocampus, collegedekho, Getmyuni,
   Shiksha, Kollegeapply, Zollege and the WhatsApp chatbot create leads in v1 that nothing copies
   to v2. Until they are repointed, this gap **reopens at roughly 30–90 leads a day**. A one-off
   migration does not fix it. This is the single most important follow-up.
2. **Stream D** — 87 orphan applications (4 live) with no `manageLeads` row.
3. **Stream E** — 40 already-migrated leads whose v1 source/mobile/email/lead_type changed.
4. **The 2 held-back leads** — Dhairya Kohli is genuinely the same person as an existing v2
   applicant; Utkarsh merely shares a mobile number with a different person and is probably safe
   to import.
5. `timelines_p202605` is still detached from the parent table (24.8M rows unreadable through
   `timelines`). Whole-database issue, unrelated to UG, recorded in the 18 Sep audit.

---

## Review round 2 — 2026-09-22 (user challenged the coverage)

The user asked why lead stages, sub-stages, application stages/sub-stages, tags and the
activity trackers were not being migrated. Checked each against the data:

| stream | verdict |
|---|---|
| lead stage | **was already migrated** — 165/165 |
| lead sub-stage | **was already migrated** — only 2 of 165 have one *in v1*; the other 163 are NULL in v1 too. (The already-migrated population is 80.9% because those are older, worked leads; these are brand-new untouched vendor leads.) |
| application stage | **was already migrated** — 2/2 |
| application sub-stage | **latent gap, now fixed** — hardcoded NULL; 0 rows affected today but 1,940 UG applications in v1 have one |
| tags | **was already migrated** — only 1 of 165 carries a tag in v1 |
| `applicationActivityTracker` | **GENUINE MISS, now fixed** — 163 rows added to the migration |

### Defects found and fixed in round 2

1. **`ApplicationActivityTrackers` was not migrated at all.** 163 rows.
2. **Application sub-stages were hardcoded to NULL.**
3. **The tracker-update loop iterated the wrong array** (`promotions` instead of
   `outPromotions`), so `p.v1_lead_id` was `undefined` and it silently exported zero
   updates. An assertion now fails the export if a promotion with a v1 tracker row produces
   no update entry.
4. **`rollback.sql` was only written at the very end**, so a failure part-way through
   `--apply` left no undo for the phases that had already committed. It is now rewritten
   after every committed phase and on failure.
5. **The applicant `under_graduate` UPDATE had no restore statement** — only a comment. The
   promoted lead's row gets 35 columns overwritten, and `under_graduate` has **no foreign
   key to `v2_leads`**, so a lead-level rollback would not have undone it. Now backed up
   and given an explicit restore.
6. **The automation guard check produced false positives.** It counted every
   `automation_events` row for the touched ids, including history the live CRM wrote for a
   pre-existing promotion target. It now baselines `max(automation_events.id)` and counts
   only newer events.
7. **Duplicate-user risk.** A v2 `users` row for Ananya now exists with `v1_id = NULL`
   (created by the v2 portal), so `ON CONFLICT (v1_id)` would not have fired and a SECOND
   account on the same email would have been created. The importer now resolves by `v1_id`,
   then by email within the org, reuses the existing row, and stamps `v1_id` onto it.

### Open decision — Ananya Gupta (v2 lead 700791)

While this work was in progress the **live v2 application promoted her itself**:
`type` is now `applicant`, `payment_status = completed`, `is_payment_done = true`, and a v2
user (4906770) exists. But the v2-native promotion is **partial**:

| field | v2 now | v1 has |
|---|---|---|
| `application_number` | NULL | `UG/SOB/260921/X0JJ` |
| `v1_application_id` | NULL | 730635 |
| `application_form_submitted` | false | true |
| `application_stage_id` | NULL | 173 → 55 "Untouched" |

The optimistic guard **correctly skipped** the promotion rather than overwrite a row that
had changed underneath it. The user must decide whether to stamp the v1 application number
and link onto the row that v2 has already created.
