# How UG data flows in v1 and v2 (verified 2026-09-22)

## v1 (old_crm_backend, `LeadsRDS`)

```
users ──┐
        ├── manageLeads          one row per (person, applicationForm). THE lead row.
        │      .applicationManagerId ──┐
        │      .assignTo (uuid → users.uuid)   counsellor
        │      .userId (→ users.id)            null for pure vendor leads
        │                                 │
        └── ApplicationManager ◄──────────┘   one row per (person, form) once they apply
                 .userId, .applicationNum, .applicationStatus, payment fields
                 │
                 └── applications   415-column wide table: the actual form answers

UserTimelines    (leadId → manageLeads.id)  activity feed   ~3.9M rows for UG
StudentTimelines (leadId)                   barely used for UG (656 rows)
Notes            (leadId, userId)           counsellor notes
manageLeads.tags text[]                     tag names, resolved against LeadTags
```

## v2 (new_crm_backend, `anandi`)

```
v2_leads      ONE table for both leads and applicants; `type` = 'lead' | 'applicant'.
              153 columns. Provenance: v1_lead_id, v1_application_id, v1_user_id.
              lead_table_id → org_lead_tables.

under_graduate   the per-school "dynamic" column table for school 18 (229 columns).
                 Linked by `lead_id` → v2_leads.id, also carries `v1_lead_id`.
                 Registered as org_lead_tables.id = 19 (org 12, school 18).
                 A row exists only when there is something to put in it.

timelines     partitioned by created_at (timelines_pYYYYMM). Linked by `v2_lead_id`.
notes         linked by `v2_lead_id`; `admin_id` = v2 user.
lead_tags     linked by `v2_lead_id` + `tag_id` → tags.
users         staff AND students; `v1_id` links back to v1 users.id.
```

### Idempotency keys that already exist in v2 (use them)

| table | partial unique index |
|---|---|
| `v2_leads` | `v2_leads_v1_lead_id_uniq (v1_lead_id) WHERE v1_lead_id IS NOT NULL` |
| `under_graduate` | `under_graduate_v1_lead_id_uniq (v1_lead_id) WHERE ...` |
| `notes` | `notes_v1_note_id_uniq (v1_note_id) WHERE ...` (unused by the UG migration) |
| `timelines` | `timelines_v1_timeline_id_uniq (v1_timeline_id, created_at) WHERE ...` (unused by UG) |
| `lead_tags` | `lead_tags_v2_lead_tag_unique (v2_lead_id, tag_id)` |

## Verified entity mapping (re-checked on both databases)

| | v1 | v2 |
|---|---|---|
| organization | 68 `UG` | 12 `Masters Union` |
| school | 11 `Masters' Union UG Programme` | 18 `Undergraduate` |
| programme (business) | 94 `UG TBM` | 94 `Undergraduate Programme (School of Business)` code `UG-TBM26` |
| programme (DSAI) | 105 `UG DSAI` | 95 `Undergraduate Programme (School of Emerging Technologies)` code `UG-DSAI26` |
| form (business) | 100 `Undergraduate Programme (School of Business)` | 104, prefix `UG/SOB` |
| form (DSAI) | 109 `Undergraduate Programme in Data Science and AI` | 105, prefix `UG/SOT` |

**All of the above match what the user stated.** Two notes:

- v2 programme 95 / form 105 has been **renamed** to "School of Emerging Technologies".
  It is the same entity (code `UG-DSAI26`, `applicationFormName` `UG-DSAI`); the user's
  label "Data Science and AI" is the old name.
- v1 school 11 also holds programmes 112 `Non Specialization` (form 113) and 149 `UG Design`
  (form 149). Both forms are **inactive** and out of scope.

Derived constants, confirmed against every already-migrated row:

| v1 form | → v2 form | program_id | batch_id | round_id |
|---|---|---|---|---|
| 100 | 104 | 94 | 88 | 84 |
| 109 | 105 | 95 | 89 | 85 |

## How the previous migration actually ran

It was **an ongoing incremental sync, not a one-shot**. For each v1 lead it wrote, within
milliseconds of each other: the `v2_leads` row, the `under_graduate` row, the copied
`timelines`, `notes` and `lead_tags`. It stopped mid-September 2026; the newest v1 lead it
copied was created 2026-09-16 16:31 IST.

It deliberately left `v1_timeline_id` and `v1_note_id` **NULL** on copied rows, so those
tables have no working idempotency key for UG. Provenance is carried by `v1_lead_id` +
exact `created_at` instead.
