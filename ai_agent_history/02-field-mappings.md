# v1 → v2 field mappings (derived empirically, 2026-09-22)

These were **not** taken from any migration script (none exists in either repo). They were
derived by diffing already-migrated rows against their v1 sources, using a sample of
already-migrated vendor-sourced leads — i.e. the same shape as the rows still to move.
Method: `scripts/03-derive-mapping.cjs`, `04-resolve-mappings.cjs`.

## `manageLeads` → `v2_leads` (a plain lead)

### Constants
```
org_id = 12          school_id = 18        lead_table_id = 19
status = 'active'    final_decision = 'NOT_ELIGIBLE'
form_percentage_filled = 0.00              automation_tags = '{}'
```

### Direct copies
```
registered_name  ← registeredName          registered_email ← registeredEmail (verbatim)
registered_mobile← registeredMobile        registered_on    ← registeredOn
created_at       ← createdAt               updated_at       ← updatedAt (at copy time)
source/medium/campaign        ← source/medium/campaign
tertiary_source/medium/campaign ← tertiarySource/tertiaryMedium/tertiaryCampaign
secondary_source/medium/campaign← secondarySource/secondaryMedium/secondaryCampaign
alternate_email  ← alternateEmail          alternate_mobile_number ← alternateMobileNumber
lead_payload     ← leadPayload             concat_smc       ← concatSMC
city ← city      state ← state             iso_code ← isoCode     lead_country ← leadCountry
lead_device ← leadDevice                   lead_origin ← leadOrigin
program_eligible ← programEligible         crisp_chat_link ← crispChatLink
chat_summary ← chatSummary                 source_url ← sourceUrl
is_chatbot_lead ← isChatbotLead            is_mobile_verified ← isMobileVerified
is_email_verified ← isEmailVerified        is_deleted ← isLeadDeleted
is_inbound_lead ← isInboundLead            payment_status ← paymentStatus
lead_type ← leadType ('primary'|'secondary'|'tertiary')
type ← userType ('lead'|'applicant')
v1_lead_id ← id                            reassigned_on ← reassignedOn
lead_score ← leadScore   (v2's own scoring engine recalculates afterwards)
```

### Transformed
```
country_code       ← countryCode with a leading '+' stripped   ('+91' → '91')
human_handoff      ← humanHandoff  boolean → TEXT 'true'/'false'
program_id/form_id/batch_id/round_id  ← from applicationFormId (table in 01-data-model.md)
lead_stage_id      ← stage map below
lead_sub_stage_id  ← sub-stage map below
previous_lead_stage← stage map below
counsellor_id      ← assignTo (uuid) → v2 user, via the COUNSELLOR MAP below
reassigned_by      ← v1 users.id → v2 users.v1_id     (373246 → 4640466)
```

### Always NULL on a migrated plain lead
`user_id, v1_user_id, created_by, platform, is_organic, gclid, fbclid, fb_lead_id,
utm_*, widget_id, grade, form_name, referrer, insta_handle, cbb_link, applicant_name,
application_*, question1..15, login_*, payment_mode/method/partner, total_amount,
v1_application_id, application_number, timezone, registered_device`

## Lead stage map (verified by NAME, org 68/school 11 → org 12/school 18)

| v1 | name | v2 |
|---|---|---|
| 158 | Untouched | 132 |
| 159 | No Contact Established | 133 |
| 160 | Intent dropped | 134 |
| 161 | Not interested | 135 |
| 162 | Counseled | 136 |
| 163 | Not Eligible | 137 |
| 164 | Test lead | 140 |
| 165 | Duplicate lead | 138 |
| 166 | International Number | 139 |

v1 173–181 are a duplicate set of the same names and map to the same v2 ids.
**v1 stage 413 belongs to school 41 (PGP UI UX), not UG** — it appears in UG data as
cross-school contamination.

## Lead sub-stage map — resolve by (v1 stage name, sub-stage name) → v2 sub-stage id.
Verified examples: 344 DNP→363, 345 DNP2→364, 348 Dead→365, 349 Incorrect Number→366,
350 Call later→367, 366 Applied By Mistake→381, 367 Disconnected on Hearing MU→383,
368 Other-Refer Comments→376, 372 Language barrier→394, 373 Graduated→395,
374 Already in college→396, 375 Grade 11→397, 376 Grade 10→390, 1255 Other→393.

## COUNSELLOR MAP — the single most dangerous mapping

**Do NOT map counsellors by email or by `users.v1_id`.** Every UG counsellor has TWO rows
in v2:

- an older account `name@mastersunion.org`, `school_id = 18`, `v1_id` set (created 2025);
- a newer account `name+1@mastersunion.org`, `school_id = NULL`, `v1_id = NULL`
  (created Aug–Sep 2026).

`v2_leads.counsellor_id` points at the **`+1`** account. Email matching silently picks the
wrong one for 17 of 19 counsellors. The map must be taken from observed already-migrated
rows (majority vote per `assignTo` uuid).

Confusingly, `timelines.created_by` and `notes.admin_id` DO use the **non-`+1`** account
(matched via `users.v1_id`). Both statements are correct — they are different columns.

## `UserTimelines` → `timelines`

```
v2_lead_id  ← the new v2_leads.id      lead_id   = NULL
v1_lead_id  ← leadId                   v1_timeline_id = NULL (as the prior migration did)
created_at  ← createdAt                org_id = 12, school_id = 18
title       ← eventType.title verbatim
description ← message
metadata    ← payload            (verified exactly equal, key-order aside)
lead_stage_id ← leadStageId through the stage map
template_id = NULL               (v1 template ids are dropped — verified 17,903/17,903)
v1_counsellor_id ← payload.userId
created_by  ← v2 users.id where users.v1_id = payload.userId
```

### event_type lookup (`eventType.title` → `event_type`)
```
Lead Added                → created                  Counsellor_Assigned → counsellor_assigned
Changed_Lead_Stage        → lead_stage_changed       whatsapp            → whatsapp_sent
Email_Sent / Email Sent   → email_sent               Lead Synced to CAPI → lead_synced_to_capi
Application Stage Changed → application_stage_changed
Payment_Activity          → payment_activity         Online Payment Initiated → online_payment_initiated
Note Created              → note_added               Dinero API Triggered→ dinero_api_triggered
Lead Type Updated         → updated                  Program Changed     → program_changed
```

## `Notes` → `notes`
```
v2_lead_id ← new v2_leads.id     v1_lead_id ← leadId      v1_note_id = NULL
content    ← message, TRIMMED    created_at ← createdAt
v1_counsellor_id ← userId        admin_id ← v2 users.id where users.v1_id = userId
org_id = 12, school_id = 18
```

## `manageLeads.tags` → `lead_tags`
```
v2_lead_id ← new v2_leads.id     v1_lead_id ← id     lead_id = NULL
tag_id     ← v2 tags.id matched by name within org 12
org_id = 12, school_id = 18
```

## Applicant extras (`ApplicationManager` → `v2_leads`)
```
type = 'applicant'
v1_application_id ← ApplicationManager.id       v1_user_id ← ApplicationManager.userId
application_number ← applicationNum (verbatim)
user_id ← v2 users.id where users.v1_id = ApplicationManager.userId
          (student rows: role='student', user_type='Institute Users', org 12, school 18)
form_percentage_filled ← applicationStatus ('untouched'→0, else numeric)
application_form_initiated ← applicationFormInitiated
application_form_submitted ← applicationFormSubmitted
application_registered_on  ← registeredOn      last_interacted_section ← lastInteractedSection
payment_status ← paymentStatus                 payment_initiated ← paymentInitiated
payment_method ← paymentMethod                 form_completion_date ← formCompletionDate
application_stage_id ← stage map 173→55, 174→56, 176→58, 177→59, 178→60
```
and the `applications` (415 cols) row feeds `under_graduate` (85 of its 229 columns are
ever populated for UG).

---

## `applicationActivityTracker` → `ApplicationActivityTrackers`  (added 2026-09-22)

**This stream was missed in the first pass and added after review.** v2 holds 928,805 of
these rows, 68,090 of them linked to UG leads, and they carry `v1_leadId` / `v1_applicationId`
provenance — so the previous migration did copy them.

One row per **LEAD**, not per application (64,562 of the 70,769 UG leads in v2 have one).
It is a straight column-for-column copy: verified identical on **2,291 of 2,291** rows that
have not been touched since migration.

```
leadId           <- the new v2_leads.id
v1_leadId        <- leadId          v1_applicationId <- applicationId
applicationForm_start_date, payment_Initiated_date, payment_last_Initiated_date,
counsellor_first_activity_date, counsellor_last_activity_date, application_fee_paidOn,
application_last_activity_date, lastLeadStageUpdated, firstLeadStageUpdated,
applicationFormSubmittedOn, createdAt, updatedAt      <- copied verbatim
```

Dropped (no v2 column): `tetrTrialCompletedDate`, `tetrTrialShortlistedDate`,
`tetrInterviewScheduledDate`, `tetrInterviewShortlistedDate`, `offerLetterStatus`,
`tetrInterviewGivenDate`, `tetrTrialBookingDate`, `tetrTrialStarted`, `tetrTrialStartedDate`.

**v1 can hold more than one row per lead** (505 UG leads do) but v2 has a UNIQUE on
`v1_leadId`. The exporter keeps the **earliest** row and warns. For a lead that already has
a v2 tracker, it matches the v1 row on `createdAt` and emits an UPDATE instead.

Idempotency key: `application_activity_trackers_v1_lead_id_uniq ("v1_leadId")` — valid.

## Application sub-stages (added 2026-09-22)

`application_sub_stage_id` was previously hardcoded to NULL. No application currently in
scope has one, but 1,940 UG applications in v1 do, so a future run would have dropped them
silently. Now resolved by (application stage name, sub-stage name); all 30 distinct v1 values
in use map cleanly.

## Streams that are correctly NOT migrated

| v1 | why not |
|---|---|
| `leadActivityTracker` (5.9M rows) | v2 has no such table and the previous migration never wrote one. The 2 rows for in-scope leads carry no note and no follow-up date — the same events already arrive as `Changed_Lead_Stage` timelines. |
| `leadStageLogs` | v2 has 14,963 UG rows and **0** of them carry `v1_id`: every one was generated natively by v2. Writing migrated history here would be inventing data the previous 71,166 leads do not have. |
| `feedues` / `feeTransactions` | no payment rows exist in v2 for any of the 2,427 already-migrated UG applicants either. |
