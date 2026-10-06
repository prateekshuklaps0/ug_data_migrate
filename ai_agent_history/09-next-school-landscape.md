# The next migration — landscape as at 2026-10-06 (read-only survey)

## v1 orgs that feed v2 org 12

| v1 org | name | v2 destination |
|---|---|---|
| 68 | UG | school 18 Undergraduate (DONE — see 00-README) |
| 45 | Masters' Union | school 27 Executive Education (per-programme), school 43 Inbound Calls |
| 66 | PGP TBM | school 14 PGP School of Business, school 24 Summer School |
| 109 | Masters Union AI School for Enterprises | school 38 |

**v1 "school" does not map 1:1 to a v2 school.** v1 org 45 keeps ~20 programmes under its own
school 12/20/77/79 and v2 splits them per PROGRAMME inside school 27. So the unit of migration
is the (v1 org, applicationFormId) pair → (v2 school, program_id, form_id), exactly as UG was.

## Derived v1 form → v2 form map and the gap (sampled from already-migrated rows)

v1 live = `manageLeads` not deleted. gap = v1 live − v2 rows carrying that `v1_lead_id`.

| v2 school | v2 form | v1 org/form | v1 live | of which applicants | gap |
|---|---|---|---|---|---|
| 27 Exec Ed | 96 SBM Core | 45 / 69 | 269,610 | 80,138 | 821 |
| 27 | 83 PGP GM | 45 / 104 | 241,536 | 69,544 | 2,331 |
| 27 | 107 CMT | 45 / 31 | 130,575 | 48,542 | 378 |
| 27 | 86 PGP OPM | 45 / 103 | 86,275 | 5,622 | 479 |
| 27 | 80 PGP Bharat | 45 / 112 | 76,957 | 54,006 | 48 |
| 27 | 90 PGP-EBAP | 45 / 116 | 36,309 | 4,140 | 537 |
| 27 | 89 D2C | 45 / 199 | 15,880 | 1,941 | 118 |
| 27 | 82 Bloomberg | 45 / 151 | 274 | 221 | 36 |
| 14 PGP SoB | 2 PGP TBM | 66 / 82 | 152,906 | 21,422 | 4,723 |
| 24 Summer | 60 Summer School | 66 / 208 | 3,131 | 2,602 | 407 |
| 43 Inbound | 118 | 45 / 212 | 4,244 | 0 | 1 |
| 38 AI School | 110 | 109 / 206 | 202 | 0 | 3 |
| 18 UG | 104 + 105 | 68 / 100 + 109 | 70,495 | 2,175 | 19 (reopened) |

v2 forms 98/99/100/101/102 (the SBM specialisations) and 66/67/88/108/114 have ~0 v1-linked
rows: they are NEW v2 programmes, not a missing migration. Don't "fix" them.
Script that produced this: see the survey in the session scratchpad; re-derivable in minutes.

## Risk for school 27 is MUCH higher than it was for UG

**18 LIVE (published) email workflows are scoped to school 27**, including wf 25
"PGP BHARAT - IN - login cred" — **the workflow that sent the 6,388 emails on 2026-08-18**.
School 14 has 10 more. UG had exactly one. Same single mitigation: `app.skip_automation`
at SESSION level, proven by `scripts/import/05-automation-safety-check.cjs` before every apply.
`trg_automation_v2_leads` on `v2_leads` is still the only trigger on any table we write.

## Target tables for school 27
`v2_leads` (org 12, school 27) · `executive_education` (the dynamic form table,
org_lead_tables.id 18, **738 columns**, 273,159 rows of which 209,078 v1-linked) ·
`timelines` · `notes` · `lead_tags` + `tags` · `ApplicationActivityTrackers` · `users`.

## Review of `script_suggestion_from_dev/migrateLeadsToV2.js` (the dev's script, 170 KB)

What it does well: name-based stage/round/cohort→batch/tag resolution, dry run by default,
idempotent on `v1_lead_id`, per-lead transaction, keyset resume, index planning, a 3-month
timeline window, and it refuses to use a `student` row as the counsellor.

**Blocking problems if it is run against v2 as it stands:**
1. **No automation guard at all** — zero occurrences of `app.skip_automation`. With `--commit`
   every insert/update on `v2_leads` fires `trg_automation_v2_leads` → `automation_events` →
   the engine → the 18 live school-27 email workflows. This is the 2026-08-18 incident exactly.
2. **It never writes the dynamic form table** (`executive_education`): no mention of
   `org_lead_tables` targets or the `applications` → school-table mapping. Every migrated
   applicant would land with NO form answers, while the existing 209,078 v1-linked rows there
   prove the earlier migration did write them.
3. **It may CREATE rows in the live CRM's reference tables** — users (with copied bcrypt
   hashes), leadStage/leadSubStage/applicationStage/applicationSubStage (by default
   `createdStageSchoolId: null` = ORG-WIDE, visible to every school), rounds, batches, tags.
4. **Counsellors are matched BY EMAIL.** For UG that picked the wrong account for 17 of 19
   counsellors (the `+1` accounts). Must be verified per school from observed migrated rows.
5. **Live production passwords are hard-coded in the file** (v1 and v2). It is currently
   untracked; keep it out of git and blank them.
6. Config is internally inconsistent: the header documents CMT (v1 form 31 → v2 school 27 /
   program 96 / form 107) while `CONFIG.source` says form 199 / program 198 with
   `userType: 'applicant'` and `CONFIG.target` says program 79 / form 89 (D2C). Whoever runs it
   must re-read both blocks. `userType: 'applicant'` also silently drops plain leads.
7. No lead-score history, no payment records, no `feedues` (same as our UG decision — fine,
   but it is a silent omission rather than a recorded one).

**Recommendation:** reuse our proven pipeline (export → verify → impact → dry run → apply,
with the guard, batching, checkpointing and the post-apply check) parameterised for the new
school, and mine the dev's script for its mapping knowledge (rounds/cohorts→batches, tags,
`lead_payload.__legacy` stash). Do not point it at production as-is.
