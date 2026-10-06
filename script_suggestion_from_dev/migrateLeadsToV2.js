/**
 * ============================================================================
 *  LEAD MIGRATION :  DB1 (v1 / this repo)  ->  DB2 (v2 / receiving DB)
 * ============================================================================
 *
 *  WHAT MOVES
 *    manageLeads                -> v2_leads
 *    Notes                      -> notes                        (v2_lead_id)
 *    UserTimelines              -> timelines                    (v2_lead_id)
 *    applicationActivityTracker -> ApplicationActivityTrackers
 *    manageLeads.tags           -> tags + lead_tags             (matched BY NAME)
 *    lead stage / sub-stage     -> leadStage / leadSubStage        (matched BY NAME)
 *    application stage / sub    -> applicationStage / applicationSubStage (BY NAME)
 *
 *  SOURCE FILTER (manageLeads)
 *    organizationId = 45  AND  applicationFormId = 31  AND  programId = 65
 *    AND isLeadDeleted = false  AND  userType = 'lead'
 *
 *  TARGET SCOPE (static — same for every migrated lead)
 *    org_id 12 | school_id 27 | program_id 96 | form_id 107
 *
 *  ROUND / COHORT RULE  (ids are never copied — matched by NAME)
 *    manageLeads.roundId  -> v1 `rounds`.name       -> receiving `rounds`.name
 *    manageLeads.cohortId -> v1 `cohorts`.cohortName-> receiving `batches`.name
 *    ("cohort" in v1 is called "batch" in the receiving DB.) Match is scoped to
 *    the target org, preferring the same school+program. If the name is not
 *    there the row is CREATED in the receiving DB and its id is used.
 *
 *  TIMELINE RULE
 *    v1 `UserTimelines` -> receiving `timelines` (NOT `userTimelines`, which is
 *    the legacy table there). The shapes differ, so it is a re-shape, not a copy:
 *      eventType {icon,title} -> event_type + title      message -> description
 *      icon / date / time / leadStageId / payload / v1 ids -> metadata JSONB
 *    metadata.__legacy.v1TimelineId is the re-run dedup key (no uuid column).
 *    AGE LIMIT: only the last 3 months of timeline activity is migrated
 *    (UserTimelines.createdAt >= now - 3 months). Older rows are excluded in
 *    the source SELECT, so they are never even read. Widen with
 *    --timelines-months=N / --all-timelines; a later, wider run backfills.
 *
 *  TAG RULE
 *    v1 keeps a lead's tags as an ARRAY OF NAMES in manageLeads.tags (the
 *    `LeadTags` table is only the org's catalogue of names — there is no join
 *    table). v2 models the same thing RELATIONALLY across two tables:
 *      tags       — one row per (org_id, name), UNIQUE on that pair
 *      lead_tags  — the join row: v2_lead_id + tag_id
 *    So each name in manageLeads.tags is looked up in `tags` inside the target
 *    org (exact name first, then case-insensitively) and CREATED there when it
 *    is absent — stamping v1 `LeadTags`.id into tags.v1_tag_id when the name is
 *    in the source catalogue. Then one lead_tags row per (lead, tag) is written
 *    with v2_lead_id / org_id / school_id / v1_lead_id filled in and lead_id
 *    (the LEGACY `leads` FK) left NULL.
 *    Re-runs dedup on (v2_lead_id, tag_id) — the partial UNIQUE index the
 *    receiving DB already has — so a second pass adds only what is missing.
 *    --skip-tags turns it off; --tags-only migrates NOTHING BUT tags (see below).
 *
 *  COUNSELLOR RULE
 *    manageLeads.assignTo (a user UUID) -> source users row -> email -> the same
 *    email in the receiving users table -> v2_leads.counsellor_id.
 *    Missing there? the user is CREATED from the source row — including its
 *    existing bcrypt hash (v1 users.password -> users.password_hash), so the
 *    person keeps their password — and the source users.id is stamped into the
 *    receiving users.v1_id column.
 *    Rows whose role is a student are NEVER accepted as the counsellor — the
 *    applicant shares that email, so an unfiltered match assigned the lead to
 *    the student. Such leads are left with counsellor_id NULL and listed in the
 *    summary (CONFIG.target.counsellorExcludedRoles).
 *
 *  STAGE RULE
 *    v1 keeps BOTH lead and application stages in ONE table (`LeadStage`,
 *    discriminated by applicableTo). v2 splits them into `leadStage` and
 *    `applicationStage`. So we never copy ids: we read the v1 id -> take its
 *    stageName -> look that name up in the v2 table scoped to the target
 *    org + school (own school first, then the org-wide schoolId IS NULL row)
 *    -> store the v2 id. Sub-stages match by name under the resolved parent.
 *    A name that is not there is CREATED in the receiving DB, mirroring the
 *    source row (name, order, followUpRequired, score, isActive).
 *
 *  WHAT THIS SCRIPT MAY CREATE IN THE RECEIVING DB (besides the leads themselves)
 *    users · leadStage · leadSubStage · applicationStage · applicationSubStage
 *    rounds · batches · tags  — each one is name-matched first and only created
 *    when absent. Every creation is logged and counted. Toggle them off with the
 *    createMissing* flags in CONFIG.target.
 *
 *  SAFETY
 *    - DRY RUN by default. Pass --commit to actually write. A dry run creates
 *      NOTHING; it reports what it would have created.
 *    - Idempotent: a lead already in v2_leads with v1_lead_id = source id is
 *      skipped (or updated with --update-existing).
 *    - One transaction per lead: lead + notes + timelines + tracker land together.
 *    - Nothing from the app's models is imported, so no BullMQ jobs, no Google
 *      Sheet sync and no duplicate-lead hooks fire during the migration.
 *
 *  SPEED — READ THIS BEFORE A BIG RUN
 *    The script is already batched, pipelined and bulk-inserting; what makes a
 *    run slow is the DATABASES, not the script. The same ~8 queries run once
 *    per batch, hundreds of times over, and without an index behind them each
 *    one sequential-scans a multi-million-row table. So:
 *
 *      node scripts/migrateLeadsToV2.js --check-indexes  # read-only: what's missing
 *      node scripts/migrateLeadsToV2.js --indexes-only   # ONCE, then migrate
 *
 *    builds every index those queries need (source AND target) with CREATE
 *    INDEX CONCURRENTLY, so it is safe against the live DBs. A plain run only
 *    REPORTS what is missing and prints the SQL; nothing is created unless you
 *    pass --ensure-indexes / --indexes-only. See the INDEX_PLAN in section 4b
 *    for the exact list and what each one is for.
 *
 *    The other lever is volume: timelines are ~99% of everything written, so
 *    the 3-month default window (below) matters more than any tuning flag.
 *
 *  RUN
 *    node scripts/migrateLeadsToV2.js --indexes-only  # one-off: build indexes
 *    node scripts/migrateLeadsToV2.js                 # dry run + report
 *    node scripts/migrateLeadsToV2.js --commit
 *    node scripts/migrateLeadsToV2.js --commit --limit=50
 *    node scripts/migrateLeadsToV2.js --commit --lead-ids=101,102
 *    node scripts/migrateLeadsToV2.js --commit --update-existing
 *    node scripts/migrateLeadsToV2.js --tags-only            # dry run: tags only
 *    node scripts/migrateLeadsToV2.js --commit --tags-only   # backfill tags only
 *
 *  SETUP — everything is edited IN THIS FILE, nothing comes from .env:
 *    1. SRC_DB / TGT_DB   -> the two sets of DB credentials (section 1)
 *    2. CONFIG.target     -> org/school/program/form (filled in) + migrationUserId
 *                            and fallbackAdminUserId (still to fill)
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Sequelize, DataTypes, Op } from 'sequelize';

/* ==========================================================================
 * 1. CONFIG
 * ========================================================================== */

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const num = (v, fallback = null) => (v === undefined || v === null || v === '' ? fallback : Number(v));

const CONFIG = {
  commit: flag('commit'),
  // read-only audit of what is already in v2_leads vs what is in manageLeads
  verify: flag('verify'),
  updateExisting: flag('update-existing'),
  verbose: flag('verbose'),
  batchSize: num(opt('batch-size'), 500),
  concurrency: num(opt('concurrency'), 8),   // leads migrated in parallel
  limit: num(opt('limit'), null),
  maxFailures: num(opt('max-failures'), 25), // stop early instead of failing 80k times

  /* ---- RESUMING A PART-FINISHED RUN -----------------------------------
   * Leads are always walked in ascending manageLeads.id order, so "where it
   * stopped" is a single number. Three ways to say it, checked in this order:
   *
   *   --resume          look at the receiving DB, find the highest v1_lead_id
   *                     already migrated into this target scope, carry on from
   *                     the one after it. No number to look up by hand.
   *   --after-id=N      start straight after manageLeads.id = N.
   *   --skip=35000      skip the first 35,000 matching leads (resolved to an
   *                     id with one OFFSET query, then keyset from there).
   *
   * None of these are required for correctness — a plain re-run from 0 also
   * works, because leads dedup on v1_lead_id. They just avoid re-reading and
   * re-checking the leads that are already done.
   *
   * CAVEAT: skipping past an id means any lead BELOW it that failed mid-run is
   * not retried. Finish the tail first, then do one cheap sweep from 0 to
   * backfill the stragglers — the dedup pass makes that safe and fast. */
  resume: flag('resume'),
  afterId: num(opt('after-id'), null),
  skip: num(opt('skip'), null),

  /* ---- INDEXES (the single biggest speed lever) ------------------------
   * Every batch re-runs the same handful of queries: a keyset scan of
   * manageLeads, three `leadId IN (...)` child reads on the source, and the
   * dedup lookups on the target. Without an index behind them Postgres
   * sequential-scans multi-million-row tables once PER BATCH, which is what
   * makes the run crawl — the script itself is already batched, pipelined and
   * bulk-inserting, so nothing else it does can compensate.
   *
   *   (default)          CHECK only — report which indexes are missing, print
   *                      the exact CREATE INDEX statements, change nothing.
   *   --check-indexes    that report on its own, then exit. Read-only; the
   *                      safe way to see what a run is missing.
   *   --ensure-indexes   actually create the missing ones, then migrate.
   *   --indexes-only     create them and exit (do this first, then re-run
   *                      the migration normally).
   *   --skip-index-check skip the whole step.
   *   --index-mode=blocking  build with an ACCESS EXCLUSIVE lock (faster, but
   *                      it blocks writes to the table). The default,
   *                      `concurrent`, uses CREATE INDEX CONCURRENTLY, which
   *                      is slower but safe against a live production DB.
   *
   * Building them is a one-off cost: minutes on the big source tables, and
   * they stay useful afterwards. An index is only created when no existing
   * index already leads with the same columns. */
  ensureIndexes: flag('ensure-indexes') || flag('indexes-only'),
  // both stop before the migration; --check-indexes additionally creates nothing
  indexesOnly: flag('indexes-only') || flag('check-indexes'),
  skipIndexCheck: flag('skip-index-check'),
  indexMode: opt('index-mode', 'concurrent') === 'blocking' ? 'blocking' : 'concurrent',

  /* ---- TIMELINE VOLUME ------------------------------------------------
   * Timelines are ~420 rows per lead, i.e. ~34M rows for 80k leads — roughly
   * 99% of everything this migration writes, and therefore ~99% of its runtime.
   *
   * DEFAULT: only the LAST 3 MONTHS of activity is migrated. Anything with
   * UserTimelines.createdAt older than the cutoff is left behind — it is never
   * read out of the source, so it costs nothing to skip.
   *
   *   (default)                      last 3 months
   *   --timelines-months=6           last 6 months
   *   --timelines-since=2025-01-01   explicit cutoff, overrides --timelines-months
   *   --all-timelines                no cutoff — every timeline row, all history
   *   --skip-timelines               none at all (leads + notes + trackers only)
   *
   * All of these are safe to change between runs: a later run with a wider
   * window backfills what an earlier one skipped, because timelines dedup on
   * metadata.__legacy.v1TimelineId. */
  skipTimelines: flag('skip-timelines'),
  timelinesMonths: flag('all-timelines') ? null : num(opt('timelines-months'), 3),
  timelinesSince: null,   // resolved just below

  /* ---- TAGS -----------------------------------------------------------
   * manageLeads.tags (an array of NAMES) -> v2 `tags` + `lead_tags`. See the
   * TAG RULE at the top of this file for the matching rules.
   *
   *   (default)      tags migrate alongside everything else
   *   --skip-tags    no tags at all (nothing is read, nothing is created)
   *   --tags-only    migrate NOTHING BUT tags. The lead itself, its notes,
   *                  timelines and tracker are left completely alone: the run
   *                  walks the same source filter, keeps only the rows that
   *                  actually carry a tag, finds each one's ALREADY-MIGRATED
   *                  v2_leads row by v1_lead_id, and writes the missing
   *                  lead_tags. A lead that is not in v2_leads yet is skipped
   *                  and reported — this mode never creates a lead.
   *                  Use it when everything else is already across and only
   *                  the tags are outstanding; it is dramatically faster than
   *                  a full re-run because it resolves no stages, users,
   *                  rounds or batches and reads no child tables.
   *
   * Safe to re-run: lead_tags dedups on (v2_lead_id, tag_id). */
  skipTags: flag('skip-tags'),
  tagsOnly: flag('tags-only'),

  leadIds: (opt('lead-ids') || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number),

  // ---- SOURCE FILTER: which manageLeads rows get picked up ----
  source: {
     organizationId: 45,
    applicationFormId: 199,
    programId: 198,
    isLeadDeleted: false,
    userType: 'applicant',
  },

  // ---- TARGET: every migrated lead lands here (static, same for all rows) ----
  target: {
    label: 'target',
    orgId: 12,
    schoolId: 27,
    programId: 79,
    formId: 89,

    leadTableId: null,           // receiving org_lead_tables.id (optional)
    migrationUserId: null,       // stamped on v2_leads.created_by + on any round/batch we create
    fallbackAdminUserId: null,   // used when a note's author can't be mapped (notes.admin_id is NOT NULL)
    widgetIdMap: {},             // { <v1 widgetId>: <v2 widgetId> }

    // v1 `rounds` / `cohorts` are matched INTO the receiving `rounds` / `batches`
    // by name. Turn these off to leave round_id / batch_id NULL instead of creating.
    createMissingRounds: true,
    createMissingBatches: true,

    // A tag NAME out of manageLeads.tags that has no row in the receiving `tags`
    // table (org-scoped, exact match then case-insensitive) is CREATED there.
    // Turn this off to only link tags that already exist; unmatched names are
    // then listed in the summary instead.
    createMissingTags: true,
    // `tags.color` has a DB default of #6366f1; v1 tags carry no colour, so every
    // created tag gets this one. It is what the v2 UI shows as the chip colour.
    createdTagColor: '#6366f1',

    // A counsellor / note author / timeline actor that has no row in the receiving
    // `users` table is CREATED from the source user (email, name, phone), with the
    // source users.id written into the receiving users.v1_id column.
    createMissingUsers: true,
    createdUserRole: 'counsellor',   // users.role enum: admin|super_admin|student|counsellor|user
    createdUserStatus: 'active',     // users.status enum: active|disabled|invited
    // The receiving users table is multi-tenant. An email match INSIDE orgId always
    // wins. This decides what happens when the only match sits in another org:
    //   true  -> reuse that user (counted as a mismatch in the summary)
    //   false -> ignore it and create a fresh user under orgId  ⚠ will fail if the
    //            DB has a UNIQUE index on users.email
    reuseUsersFromOtherOrgs: true,
    // Roles that can NEVER be a counsellor. The same email often exists in the
    // receiving `users` table as the applicant themself; without this filter the
    // email match hands v2_leads.counsellor_id a student. Applies ONLY to the
    // counsellor chain — the lead's own user_id is still allowed to be a student.
    counsellorExcludedRoles: ['student'],

    // A lead/application stage or sub-stage whose NAME is absent in the receiving DB
    // is CREATED there, mirroring the source row (name, order, followUpRequired, score).
    // notes.lead_id and timelines.lead_id are FKs to the LEGACY `leads` table.
    // The v2 link is v2_lead_id, so these are left NULL. Only flip this on if you
    // deliberately want the v2 id in the legacy column too (it will fail if the
    // FK is enforced).
    writeLegacyLeadId: false,

    createMissingStages: true,
    // Which school a created stage belongs to.
    //   null  = org-wide shared default (schoolId IS NULL) -> visible to EVERY v2
    //           surface, including the ones that are not school-aware yet
    //           (change-stage dropdown, dashboards, filters, exports).
    //   <id>  = scoped to that school -> only the school-aware screens see it.
    // null is the safe default; see the school-scoping note in models/leadStage.js.
    createdStageSchoolId: null,
  },

  // Stash v1 columns that have no v2 column into v2_leads.lead_payload.__legacy
  stashUnmapped: true,


  reportDir: path.resolve(process.cwd(), 'scripts/temp'),
};

/* ---- resolve the timeline cutoff into a real Date -----------------------
 * An explicit --timelines-since=YYYY-MM-DD always wins. Otherwise the cutoff
 * is "now minus timelinesMonths". Note this is anchored at the moment the
 * script STARTS, so every batch of a long run uses the same boundary rather
 * than a window that slides forward while the migration is in flight. */
{
  const explicit = opt('timelines-since', null);
  if (explicit) {
    const d = new Date(explicit);
    if (Number.isNaN(d.getTime())) throw new Error(`--timelines-since="${explicit}" is not a valid date (use YYYY-MM-DD).`);
    CONFIG.timelinesSince = d;
    CONFIG.timelinesMonths = null;
  } else if (CONFIG.timelinesMonths) {
    const d = new Date();
    d.setMonth(d.getMonth() - CONFIG.timelinesMonths);
    CONFIG.timelinesSince = d;
  }
}

/* ==========================================================================
 *  >>>>>>>>>>>>>>>>  PASTE YOUR DATABASE CREDENTIALS HERE  <<<<<<<<<<<<<<<<
 * ==========================================================================
 *  Fill both blocks in. Nothing is read from .env — what you type here is
 *  what the script connects to.
 *
 *  ⚠ These are live DB passwords sitting in a tracked file. Do NOT commit
 *    this file with real values (blank them out again when you're done, or
 *    keep the file out of git).
 * ========================================================================== */

// FROM  ── DB1 (v1) — the database that HAS manageLeads
const SRC_DB = {
  host: 'leadmatrix-production.c1nvajieufmh.ap-south-1.rds.amazonaws.com',
  port: 5432,
  database: 'LeadsRDS',
  username: 'leadadmin',
  password: 'Mq7NIw8H5CrsJTsBMtcB',
  // password: '',
  ssl: true,              // false for a local/non-SSL postgres
  logging: CONFIG.verbose,
};

// TO  ── DB2 (v2) — the RECEIVING database that has v2_leads
const TGT_DB = {
  host: 'anandi.c1nvajieufmh.ap-south-1.rds.amazonaws.com',
  port: 5432,
  database: 'anandi',
  username: 'anandi',
  password: 'QMkL4U6Li6kjD7',
  // password: 'PASTE_TARGET_PASSWORD',
  ssl: true,
  logging: CONFIG.verbose,
};

/* ==========================================================================
 * 2. FIELD MAP  —  which source field lands in which target table/column
 * ==========================================================================
 * Entry shape (key = target model attribute):
 *   from      : source column           column : real target DB column
 *   transform : (value, sourceRow, ctx) => value
 *   resolver  : needs a cross-DB lookup (see RESOLVERS below)
 *   const     : fixed value             note   : caveat / reason
 * This object IS the migration — editing it changes what gets written.
 */

const asText = (v) => (v === null || v === undefined || v === '' ? null : String(v));
const asJsonText = (v) => (v === null || v === undefined ? null : (typeof v === 'string' ? v : JSON.stringify(v)));
const asBool = (v, dflt = null) => (v === null || v === undefined ? dflt : Boolean(v));

/** manageLeads  ->  v2_leads */
const LEAD_FIELD_MAP = {
  // --- provenance / idempotency ---------------------------------------
  v1LeadId:        { from: 'id',                   column: 'v1_lead_id', note: 'dedup key for re-runs' },
  v1ApplicationId: { from: 'applicationManagerId', column: 'v1_application_id' },
  v1UserId:        { from: 'userId',               column: 'v1_user_id' },
  uuid:            { from: 'uuid',                 column: 'uuid', note: 'kept identical so old links still resolve' },

  // --- tenancy / scope: static CONFIG.target values, never copied ------
  orgId:       { resolver: 'orgId',       column: 'org_id',      note: 'CONFIG.target.orgId' },
  schoolId:    { resolver: 'schoolId',    column: 'school_id',   note: 'CONFIG.target.schoolId' },
  programId:   { resolver: 'programId',   column: 'program_id',  note: 'CONFIG.target.programId' },
  formId:      { resolver: 'formId',      column: 'form_id',     note: 'CONFIG.target.formId' },
  batchId:     { resolver: 'batchId',     column: 'batch_id',    note: 'v1 cohorts.cohortName -> v2 batches.name (created when missing)' },
  roundId:     { resolver: 'roundId',     column: 'round_id',    note: 'v1 rounds.name -> v2 rounds.name (created when missing)' },
  leadTableId: { resolver: 'leadTableId', column: 'lead_table_id' },

  // --- people ----------------------------------------------------------
  userId:       { resolver: 'leadUserId',   column: 'user_id',       note: 'v1 users.id -> v2 users.id by lower(email)' },
  counsellorId: { resolver: 'counsellorId', column: 'counsellor_id', note: 'v1 manageLeads.counsellorId (or assignTo) -> v1 users row -> email -> v2 users.id by lower(email)' },
  reassignedBy: { resolver: 'reassignedBy', column: 'reassigned_by' },
  createdBy:    { resolver: 'createdBy',    column: 'created_by',    note: 'CONFIG.target.migrationUserId' },

  // --- classification ---------------------------------------------------
  type:      { from: 'userType',      column: 'type',       transform: (v) => (v === 'applicant' ? 'applicant' : 'lead'), note: 'v1 lead|user|applicant|student -> v2 lead|applicant' },
  leadType:  { from: 'leadType',      column: 'lead_type',  transform: (v) => v || 'primary' },
  isDeleted: { from: 'isLeadDeleted', column: 'is_deleted', transform: (v) => asBool(v, false) },
  status:    { const: 'active',       column: 'status' },

  // --- identity ---------------------------------------------------------
  registeredName:        { from: 'registeredName',        column: 'registered_name' },
  applicantName:         { from: 'registeredName',        column: 'applicant_name', note: 'v1 has no separate applicant name; v2 UI reads applicant_name' },
  registeredEmail:       { from: 'registeredEmail',       column: 'registered_email' },
  registeredMobile:      { from: 'registeredMobile',      column: 'registered_mobile' },
  countryCode:           { from: 'countryCode',           column: 'country_code' },
  alternateEmail:        { from: 'alternateEmail',        column: 'alternate_email' },
  alternateMobileNumber: { from: 'alternateMobileNumber', column: 'alternate_mobile_number' },
  isMobileVerified:      { from: 'isMobileVerified',      column: 'is_mobile_verified', transform: (v) => asBool(v, false) },
  isEmailVerified:       { from: 'isEmailVerified',       column: 'is_email_verified',  transform: (v) => asBool(v, false) },

  // --- stages (name lookup across DBs, org + school scoped) -------------
  leadStageId:           { resolver: 'leadStageId',           column: 'lead_stage_id',            note: 'v1 LeadStage.stageName -> v2 leadStage.stageName' },
  leadSubStageId:        { resolver: 'leadSubStageId',        column: 'lead_sub_stage_id',        note: 'v1 LeadSubStage.name -> v2 leadSubStage.name under resolved parent' },
  previousLeadStage:     { resolver: 'previousLeadStageId',   column: 'previous_lead_stage' },
  applicationStageId:    { resolver: 'applicationStageId',    column: 'application_stage_id',     note: 'v1 ApplicationManager.applicationStageId -> v2 applicationStage.stageName' },
  applicationSubStageId: { resolver: 'applicationSubStageId', column: 'application_sub_stage_id' },
  leadStageDate:         { resolver: 'leadStageDate',         column: 'lead_stage_date',          note: 'from applicationActivityTracker.lastLeadStageUpdated' },
  leadScore:             { from: 'leadScore',                 column: 'lead_score' },

  // --- attribution / UTM ------------------------------------------------
  source:            { from: 'source',            column: 'source',   transform: (v, r) => v ?? r.primarySource ?? null },
  medium:            { from: 'medium',            column: 'medium',   transform: (v, r) => v ?? r.primaryMedium ?? null },
  campaign:          { from: 'campaign',          column: 'campaign', transform: (v, r) => v ?? r.primaryCampaign ?? null },
  secondarySource:   { from: 'secondarySource',   column: 'secondary_source' },
  secondaryMedium:   { from: 'secondaryMedium',   column: 'secondary_medium' },
  secondaryCampaign: { from: 'secondaryCampaign', column: 'secondary_campaign' },
  tertiarySource:    { from: 'tertiarySource',    column: 'tertiary_source' },
  tertiaryMedium:    { from: 'tertiaryMedium',    column: 'tertiary_medium' },
  tertiaryCampaign:  { from: 'tertiaryCampaign',  column: 'tertiary_campaign' },
  sourceUrl:         { from: 'sourceUrl',         column: 'source_url',  transform: asJsonText, note: 'v1 JSON -> v2 TEXT' },
  utmTerm:           { from: 'utmTerm',           column: 'utm_term' },
  utmContent:        { from: 'utmContent',        column: 'utm_content' },
  utmPlacement:      { from: 'utmPlacement',      column: 'utm_placement' },
  utmCampaignId:     { from: 'utmCampaignId',     column: 'utm_campaign_id' },
  utmAdGroupId:      { from: 'utmAdGroupId',      column: 'utm_ad_group_id' },
  utmCreativeId:     { from: 'utmCreativeId',     column: 'utm_creative_id' },
  gclid:             { from: 'gclid',             column: 'gclid' },
  fbclid:            { from: 'fbclid',            column: 'fbclid' },
  fbLeadId:          { from: 'fbLeadId',          column: 'fb_lead_id',  transform: asText, note: 'v1 BIGINT -> v2 STRING' },
  leadOrigin:        { from: 'leadOrigin',        column: 'lead_origin' },
  leadDevice:        { from: 'leadDevice',        column: 'lead_device' },
  referrer:          { from: 'referrer',          column: 'referrer' },
  formName:          { from: 'formName',          column: 'form_name' },
  widgetId:          { resolver: 'widgetId',      column: 'widget_id',   note: 'widget ids are per-DB; null unless CONFIG.target.widgetIdMap has it' },

  // --- location / misc ---------------------------------------------------
  city:            { from: 'city',            column: 'city' },
  state:           { from: 'state',           column: 'state' },
  isoCode:         { from: 'isoCode',         column: 'iso_code' },
  leadCountry:     { from: 'leadCountry',     column: 'lead_country' },
  grade:           { from: 'grade',           column: 'grade' },
  programEligible: { from: 'programEligible', column: 'program_eligible' },
  instaHandle:     { from: 'instaHandle',     column: 'insta_handle' },
  crispChatLink:   { from: 'crispChatLink',   column: 'crisp_chat_link' },
  cbbLink:         { from: 'cbbLink',         column: 'cbb_link' },
  isChatbotLead:   { from: 'isChatbotLead',   column: 'is_chatbot_lead', transform: (v) => asBool(v, false) },
  concatSMC:       { from: 'concatSMC',       column: 'concat_smc' },
  chatSummary:     { from: 'chatSummary',     column: 'chat_summary' },
  humanHandoff:    { from: 'humanHandoff',    column: 'human_handoff',   transform: asText, note: 'v1 BOOLEAN -> v2 TEXT' },
  isInboundLead:   { from: 'isInboundLead',   column: 'is_inbound_lead', transform: (v) => asBool(v, false) },
  paymentStatus:   { from: 'paymentStatus',   column: 'payment_status' },

  // --- timestamps (preserved, not stamped at migration time) -------------
  registeredOn: { from: 'registeredOn', column: 'registered_on' },
  reassignedOn: { from: 'reassignedOn', column: 'reassigned_on' },
  createdAt:    { from: 'createdAt',    column: 'created_at' },
  updatedAt:    { from: 'updatedAt',    column: 'updated_at' },

  // --- raw payload + anything with no v2 home ----------------------------
  leadPayload: { resolver: 'leadPayload', column: 'lead_payload', note: 'source leadPayload + __legacy stash of UNMAPPED_LEAD_FIELDS' },
};

/** v1 manageLeads columns with no v2_leads counterpart -> stashed in lead_payload.__legacy */
const UNMAPPED_LEAD_FIELDS = [
  'programName', 'publisherSource', 'grades', 'school', 'schoolAnandi',
  'totalFormsInitiated',
  // v2 models tags relationally (tags / lead_tags), not as a column — they ARE
  // migrated (see the TAG RULE at the top), and the raw v1 array is kept here
  // too so the original spelling survives even when a name folds onto an
  // existing v2 tag with different casing.
  'tags',
  'question1', 'question2', 'question3', 'question4', 'question5',
  'question6', 'question7', 'question8', 'question9', 'question10',
  'question11', 'question12', 'question13', 'question14', 'question15',
];

/** Notes -> notes */
const NOTE_FIELD_MAP = {
  v2LeadId:   { resolver: 'newLeadId',   column: 'v2_lead_id' },
  leadId:     { resolver: 'legacyLeadId', column: 'lead_id', note: 'LEGACY `leads` FK — always NULL; v2_lead_id above is the link' },
  orgId:      { resolver: 'orgId',       column: 'org_id' },
  schoolId:   { resolver: 'schoolId',    column: 'school_id' },
  adminId:    { resolver: 'noteAdminId', column: 'admin_id', note: 'NOT NULL: v1 Notes.userId by email, else CONFIG.target.fallbackAdminUserId' },
  content:    { from: 'message',         column: 'content',  note: 'v1 Notes.message -> v2 notes.content' },
  visible:    { const: true,             column: 'visible' },
  tempId:     { from: 'id',              column: 'temp_id',  note: 'v1 Notes.id kept for traceability + re-run dedup' },
  created_at: { from: 'createdAt',       column: 'created_at' },
  updated_at: { from: 'updatedAt',       column: 'updated_at' },
};

/**
 * UserTimelines -> timelines
 *
 * NOT a like-for-like copy: the receiving DB's `timelines` table has a different
 * shape from v1's `UserTimelines`.
 *   v1: eventType JSON {icon,title} + message + date + time + leadStageId + payload
 *   v2: event_type STRING (NOT NULL) + title + description + metadata JSONB
 * So the JSON eventType is flattened to its title, `message` becomes the
 * description, and everything without a v2 column (icon, date, time, the v1 ids,
 * the original payload) is preserved inside `metadata`.
 */
const TIMELINE_FIELD_MAP = {
  v2LeadId:    { resolver: 'newLeadId',           column: 'v2_lead_id', note: 'the real link — timelines has a proper v2_leads FK' },
  leadId:      { resolver: 'legacyLeadId',        column: 'lead_id',    note: 'LEGACY `leads` FK — always NULL; v2_lead_id above is the link' },
  orgId:       { resolver: 'orgId',               column: 'org_id' },
  schoolId:    { resolver: 'schoolId',            column: 'school_id' },
  eventType:   { resolver: 'timelineEventType',   column: 'event_type', note: 'NOT NULL — v1 eventType.title, else "activity"' },
  title:       { resolver: 'timelineTitle',       column: 'title',      note: 'v1 eventType.title' },
  description: { from: 'message',                 column: 'description', note: 'v1 UserTimelines.message' },
  metadata:    { resolver: 'timelineMetadata',    column: 'metadata',   note: 'v1 payload + icon/date/time/leadStageId + v1 ids (the re-run dedup key)' },
  createdBy:   { resolver: 'timelineUserId',      column: 'created_by', note: 'v1 UserTimelines.userId -> receiving users.id' },
  templateId:  { const: null,                     column: 'template_id', note: 'template ids are per-DB; original kept in metadata' },
  tempLeadId:  { const: null,                     column: 'temp_lead_id' },
  createdAt:   { from: 'createdAt',               column: 'created_at' },
  updatedAt:   { from: 'updatedAt',               column: 'updated_at' },
};

/** applicationActivityTracker -> ApplicationActivityTrackers */
const TRACKER_FIELD_MAP = {
  leadId:                         { resolver: 'newLeadId',                    column: 'leadId', note: 'UNIQUE in target -> one row per lead' },
  applicationForm_start_date:     { from: 'applicationForm_start_date',       column: 'applicationForm_start_date' },
  payment_Initiated_date:         { from: 'payment_Initiated_date',           column: 'payment_Initiated_date' },
  payment_last_Initiated_date:    { from: 'payment_last_Initiated_date',      column: 'payment_last_Initiated_date' },
  counsellor_first_activity_date: { from: 'counsellor_first_activity_date',   column: 'counsellor_first_activity_date' },
  counsellor_last_activity_date:  { from: 'counsellor_last_activity_date',    column: 'counsellor_last_activity_date' },
  application_fee_paidOn:         { from: 'application_fee_paidOn',           column: 'application_fee_paidOn' },
  application_last_activity_date: { from: 'application_last_activity_date',   column: 'application_last_activity_date' },
  lastLeadStageUpdated:           { from: 'lastLeadStageUpdated',             column: 'lastLeadStageUpdated' },
  firstLeadStageUpdated:          { from: 'firstLeadStageUpdated',            column: 'firstLeadStageUpdated' },
  applicationFormSubmittedOn:     { from: 'applicationFormSubmittedOn',       column: 'applicationFormSubmittedOn' },
  createdAt:                      { from: 'createdAt',                        column: 'createdAt' },
  updatedAt:                      { from: 'updatedAt',                        column: 'updatedAt' },
};

/** v1 tracker columns the v2 table does not have — dropped on purpose, reported in the summary */
const UNMAPPED_TRACKER_FIELDS = [
  'applicationId', 'offerLetterStatus',
  'tetrTrialCompletedDate', 'tetrTrialShortlistedDate', 'tetrInterviewScheduledDate',
  'tetrInterviewShortlistedDate', 'tetrInterviewGivenDate', 'tetrTrialBookingDate',
  'tetrTrialStarted', 'tetrTrialStartedDate',
];

/** Generic mapper driven by the maps above. */
const applyMap = (map, row, ctx) => {
  const out = {};
  for (const [attr, def] of Object.entries(map)) {
    if (def.resolver) {
      const fn = ctx.resolvers[def.resolver];
      if (typeof fn !== 'function') throw new Error(`Missing resolver "${def.resolver}" for "${attr}"`);
      out[attr] = fn(row, ctx);
    } else if ('const' in def) {
      out[attr] = def.const;
    } else {
      const raw = row?.[def.from];
      out[attr] = def.transform ? def.transform(raw ?? null, row, ctx) : (raw ?? null);
    }
  }
  return out;
};

/* ==========================================================================
 * 3. MODELS  (declared here on purpose — importing ../models would boot
 *    BullMQ queues, Google-Sheet sync and duplicate-lead hooks)
 * ========================================================================== */

const conn = (cfg) => new Sequelize(cfg.database, cfg.username, cfg.password, {
  host: cfg.host,
  port: Number(cfg.port || 5432),
  dialect: 'postgres',
  logging: cfg.logging ? console.log : false,
  dialectOptions: cfg.ssl ? { ssl: { require: true, rejectUnauthorized: false } } : {},
  pool: { max: Math.max(10, CONFIG.concurrency + 4), min: 0, acquire: 60000, idle: 10000 },
});

/** Which columns a table really has — lets us tolerate schema drift (e.g. counsellorId). */
const probeColumns = async (sequelize, table) => {
  const rows = await sequelize.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = :table',
    { replacements: { table }, type: Sequelize.QueryTypes.SELECT },
  );
  return new Set(rows.map((r) => r.column_name));
};

const buildSource = async (cfg) => {
  const sequelize = conn(cfg);
  const T = DataTypes;

  await sequelize.authenticate();
  const leadColumns = await probeColumns(sequelize, 'manageLeads');
  // `counsellorId` is not in the app's ManageLead model but may exist in the DB.
  // Declare it only when the column is really there, otherwise every SELECT breaks.
  const hasCounsellorId = leadColumns.has('counsellorId');
  const hasAssignTo = leadColumns.has('assignTo');
  console.log(`[schema] manageLeads.counsellorId=${hasCounsellorId} manageLeads.assignTo=${hasAssignTo}`);

  const ManageLead = sequelize.define('ManageLead', {
    ...(hasCounsellorId ? { counsellorId: { type: T.INTEGER } } : {}),
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    uuid: { type: T.UUID }, userId: { type: T.INTEGER }, organizationId: { type: T.INTEGER },
    applicationManagerId: { type: T.INTEGER }, programId: { type: T.INTEGER },
    applicationFormId: { type: T.INTEGER }, schoolId: { type: T.INTEGER },
    leadType: { type: T.STRING }, userType: { type: T.STRING },
    registeredName: { type: T.STRING }, registeredEmail: { type: T.STRING },
    registeredMobile: { type: T.STRING }, countryCode: { type: T.STRING },
    leadStageId: { type: T.INTEGER }, leadSubStageId: { type: T.INTEGER },
    registeredOn: { type: T.DATE }, leadPayload: { type: T.JSON },
    source: { type: T.STRING }, medium: { type: T.STRING }, campaign: { type: T.STRING },
    sourceUrl: { type: T.JSON }, assignTo: { type: T.UUID }, leadScore: { type: T.DOUBLE },
    primarySource: { type: T.STRING }, primaryMedium: { type: T.STRING }, primaryCampaign: { type: T.STRING },
    publisherSource: { type: T.STRING },
    secondarySource: { type: T.STRING }, secondaryMedium: { type: T.STRING }, secondaryCampaign: { type: T.STRING },
    tertiarySource: { type: T.STRING }, tertiaryMedium: { type: T.STRING }, tertiaryCampaign: { type: T.STRING },
    isLeadDeleted: { type: T.BOOLEAN }, isMobileVerified: { type: T.BOOLEAN }, isEmailVerified: { type: T.BOOLEAN },
    alternateEmail: { type: T.TEXT }, alternateMobileNumber: { type: T.STRING },
    grades: { type: T.STRING }, city: { type: T.STRING }, school: { type: T.STRING }, grade: { type: T.STRING },
    roundId: { type: T.INTEGER }, cohortId: { type: T.INTEGER }, widgetId: { type: T.INTEGER },
    utmTerm: { type: T.TEXT }, utmPlacement: { type: T.TEXT }, utmContent: { type: T.TEXT },
    utmCampaignId: { type: T.TEXT }, utmAdGroupId: { type: T.TEXT }, utmCreativeId: { type: T.TEXT },
    leadOrigin: { type: T.TEXT }, gclid: { type: T.TEXT }, fbclid: { type: T.TEXT }, fbLeadId: { type: T.BIGINT },
    leadDevice: { type: T.STRING }, programEligible: { type: T.TEXT }, schoolAnandi: { type: T.TEXT },
    previousLeadStage: { type: T.INTEGER }, reassignedBy: { type: T.INTEGER }, reassignedOn: { type: T.DATE },
    question1: { type: T.TEXT }, question2: { type: T.TEXT }, question3: { type: T.TEXT }, question4: { type: T.TEXT },
    question5: { type: T.TEXT }, question6: { type: T.TEXT }, question7: { type: T.TEXT }, question8: { type: T.TEXT },
    question9: { type: T.TEXT }, question10: { type: T.TEXT }, question11: { type: T.TEXT }, question12: { type: T.TEXT },
    question13: { type: T.TEXT }, question14: { type: T.TEXT }, question15: { type: T.TEXT },
    paymentStatus: { type: T.STRING }, isoCode: { type: T.STRING }, totalFormsInitiated: { type: T.INTEGER },
    formName: { type: T.TEXT }, referrer: { type: T.TEXT }, instaHandle: { type: T.TEXT },
    crispChatLink: { type: T.TEXT }, state: { type: T.STRING }, tags: { type: T.ARRAY(T.TEXT) },
    cbbLink: { type: T.TEXT }, isChatbotLead: { type: T.BOOLEAN }, leadCountry: { type: T.STRING },
    programName: { type: T.STRING }, concatSMC: { type: T.TEXT }, isInboundLead: { type: T.BOOLEAN },
    chatSummary: { type: T.TEXT }, humanHandoff: { type: T.BOOLEAN },
    createdAt: { type: T.DATE }, updatedAt: { type: T.DATE },
  }, { tableName: 'manageLeads', timestamps: true });

  const Notes = sequelize.define('Notes', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    uuid: { type: T.UUID }, userId: { type: T.INTEGER }, leadId: { type: T.INTEGER },
    message: { type: T.TEXT }, createdAt: { type: T.DATE }, updatedAt: { type: T.DATE },
  }, { tableName: 'Notes', timestamps: true });

  // no getters here (the app model ISO-stringifies date/time) — we want raw values
  const UserTimeline = sequelize.define('UserTimeline', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    uuid: { type: T.UUID }, userId: { type: T.INTEGER }, leadId: { type: T.INTEGER },
    eventType: { type: T.JSON }, message: { type: T.TEXT }, date: { type: T.DATE }, time: { type: T.TIME },
    leadStageId: { type: T.INTEGER }, templateId: { type: T.INTEGER }, payload: { type: T.JSON },
    createdAt: { type: T.DATE }, updatedAt: { type: T.DATE },
  }, { tableName: 'UserTimelines', timestamps: true });

  const ActivityTracker = sequelize.define('ApplicationActivityTracker', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    leadId: { type: T.INTEGER }, applicationId: { type: T.INTEGER },
    applicationForm_start_date: { type: T.DATE }, payment_Initiated_date: { type: T.DATE },
    payment_last_Initiated_date: { type: T.DATE }, counsellor_first_activity_date: { type: T.DATE },
    counsellor_last_activity_date: { type: T.DATE }, application_fee_paidOn: { type: T.DATE },
    application_last_activity_date: { type: T.DATE }, lastLeadStageUpdated: { type: T.DATE },
    firstLeadStageUpdated: { type: T.DATE }, tetrTrialCompletedDate: { type: T.DATE },
    tetrTrialShortlistedDate: { type: T.DATE }, tetrInterviewScheduledDate: { type: T.DATE },
    tetrInterviewShortlistedDate: { type: T.DATE }, offerLetterStatus: { type: T.STRING },
    tetrInterviewGivenDate: { type: T.DATE }, tetrTrialBookingDate: { type: T.DATE },
    tetrTrialStarted: { type: T.BOOLEAN }, tetrTrialStartedDate: { type: T.DATE },
    applicationFormSubmittedOn: { type: T.DATE }, createdAt: { type: T.DATE }, updatedAt: { type: T.DATE },
  }, { tableName: 'applicationActivityTracker', timestamps: true });

  const LeadStage = sequelize.define('LeadStage', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    stageName: { type: T.TEXT }, applicableTo: { type: T.STRING },
    organizationId: { type: T.INTEGER }, schoolId: { type: T.INTEGER }, isActive: { type: T.BOOLEAN },
    followUpRequired: { type: T.BOOLEAN }, substageRequired: { type: T.BOOLEAN },
    score: { type: T.DOUBLE }, order: { type: T.INTEGER },
  }, { tableName: 'LeadStage', timestamps: true });

  const LeadSubStage = sequelize.define('LeadSubStage', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    leadStageId: { type: T.INTEGER }, name: { type: T.TEXT }, isActive: { type: T.BOOLEAN },
    followUpRequired: { type: T.BOOLEAN }, order: { type: T.INTEGER },
  }, { tableName: 'LeadSubStage', timestamps: true });

  const ApplicationManager = sequelize.define('ApplicationManager', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    organizationId: { type: T.INTEGER },
    applicationStageId: { type: T.INTEGER }, applicationSubStageId: { type: T.INTEGER },
  }, { tableName: 'ApplicationManager', timestamps: true });

  const User = sequelize.define('User', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    uuid: { type: T.UUID }, name: { type: T.STRING }, email: { type: T.STRING },
    mobileNumber: { type: T.STRING }, countryCode: { type: T.STRING },
    // v1 `users.password` already holds a bcrypt hash — it is the same thing the
    // receiving DB stores in `users.password_hash`, so it is carried over as-is.
    password: { type: T.STRING },
  }, { tableName: 'users', timestamps: true });

  const School = sequelize.define('Schools', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    organizationId: { type: T.INTEGER }, schoolName: { type: T.STRING },
  }, { tableName: 'schools', timestamps: true });

  /* v1's tag CATALOGUE. It is not a join table — a lead's tags live in
   * manageLeads.tags as plain names — so this is read only to recover the
   * original tag id (stamped into the receiving tags.v1_tag_id) for the names
   * the org has actually declared. `type` is 'lead' | 'application'. */
  const LeadTag = sequelize.define('LeadTag', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    uuid: { type: T.UUID }, tagName: { type: T.TEXT }, slug: { type: T.TEXT },
    isDeleted: { type: T.BOOLEAN }, organizationId: { type: T.INTEGER }, type: { type: T.STRING },
  }, { tableName: 'LeadTags', timestamps: true });

  const Round = sequelize.define('Round', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: T.STRING }, organizationId: { type: T.INTEGER }, status: { type: T.STRING },
    roundStartDate: { type: T.DATE }, roundEndDate: { type: T.DATE }, programCohortId: { type: T.INTEGER },
  }, { tableName: 'rounds', timestamps: true });

  // v1 calls it a "cohort"; the receiving DB calls the same thing a "batch".
  const Cohort = sequelize.define('Cohort', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    cohortName: { type: T.STRING }, organizationId: { type: T.INTEGER }, programId: { type: T.INTEGER },
    cohortStartDate: { type: T.DATE }, cohortEndDate: { type: T.DATE },
    status: { type: T.STRING }, order: { type: T.INTEGER },
  }, { tableName: 'cohorts', timestamps: true });

  return { sequelize, ManageLead, Notes, UserTimeline, ActivityTracker, LeadStage, LeadSubStage, ApplicationManager, User, School, Round, Cohort, LeadTag, hasCounsellorId, hasAssignTo };
};

const buildTarget = async (cfg) => {
  const sequelize = conn(cfg);
  const T = DataTypes;

  await sequelize.authenticate();
  // The receiving `users` table carries the source user's id. The column name is
  // probed rather than assumed, so a differently-named column still works.
  const userColumns = await probeColumns(sequelize, 'users');
  const v1IdColumn = ['v1_id', 'v1_user_id', 'v1Id'].find((c) => userColumns.has(c)) || null;
  console.log(`[schema] receiving users.<source id column> = ${v1IdColumn ?? 'NOT PRESENT (source id will not be stamped)'}`);
  // The receiving app applies a global snake_case define, so `users` has
  // created_at/updated_at — not the camelCase Sequelize would assume. Probe it.
  const userCreatedAt = userColumns.has('created_at') ? 'created_at' : 'createdAt';
  const userUpdatedAt = userColumns.has('updated_at') ? 'updated_at' : 'updatedAt';
  console.log(`[schema] receiving users timestamps = ${userCreatedAt} / ${userUpdatedAt}`);

  const V2Lead = sequelize.define('V2Lead', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    uuid: { type: T.UUID },
    orgId: { type: T.INTEGER, field: 'org_id' }, schoolId: { type: T.INTEGER, field: 'school_id' },
    programId: { type: T.INTEGER, field: 'program_id' }, batchId: { type: T.INTEGER, field: 'batch_id' },
    roundId: { type: T.INTEGER, field: 'round_id' }, formId: { type: T.INTEGER, field: 'form_id' },
    userId: { type: T.INTEGER, field: 'user_id' }, leadTableId: { type: T.INTEGER, field: 'lead_table_id' },
    type: { type: T.STRING }, isDeleted: { type: T.BOOLEAN, field: 'is_deleted' },
    applicantName: { type: T.STRING, field: 'applicant_name' }, registeredName: { type: T.STRING, field: 'registered_name' },
    registeredEmail: { type: T.STRING, field: 'registered_email' }, registeredMobile: { type: T.STRING, field: 'registered_mobile' },
    countryCode: { type: T.STRING, field: 'country_code' }, status: { type: T.STRING },
    leadScore: { type: T.DOUBLE, field: 'lead_score' },
    leadStageId: { type: T.INTEGER, field: 'lead_stage_id' }, leadSubStageId: { type: T.INTEGER, field: 'lead_sub_stage_id' },
    applicationStageId: { type: T.INTEGER, field: 'application_stage_id' },
    applicationSubStageId: { type: T.INTEGER, field: 'application_sub_stage_id' },
    counsellorId: { type: T.INTEGER, field: 'counsellor_id' },
    isMobileVerified: { type: T.BOOLEAN, field: 'is_mobile_verified' }, isEmailVerified: { type: T.BOOLEAN, field: 'is_email_verified' },
    alternateEmail: { type: T.TEXT, field: 'alternate_email' }, alternateMobileNumber: { type: T.STRING, field: 'alternate_mobile_number' },
    source: { type: T.STRING }, medium: { type: T.STRING }, campaign: { type: T.STRING },
    leadOrigin: { type: T.STRING, field: 'lead_origin' }, leadDevice: { type: T.STRING, field: 'lead_device' },
    gclid: { type: T.TEXT }, fbclid: { type: T.TEXT }, fbLeadId: { type: T.STRING, field: 'fb_lead_id' },
    utmTerm: { type: T.TEXT, field: 'utm_term' }, utmContent: { type: T.TEXT, field: 'utm_content' },
    utmCampaignId: { type: T.TEXT, field: 'utm_campaign_id' }, utmAdGroupId: { type: T.TEXT, field: 'utm_ad_group_id' },
    utmPlacement: { type: T.TEXT, field: 'utm_placement' }, utmCreativeId: { type: T.TEXT, field: 'utm_creative_id' },
    paymentStatus: { type: T.STRING, field: 'payment_status' }, leadType: { type: T.STRING, field: 'lead_type' },
    secondarySource: { type: T.STRING, field: 'secondary_source' }, secondaryMedium: { type: T.STRING, field: 'secondary_medium' },
    secondaryCampaign: { type: T.STRING, field: 'secondary_campaign' }, tertiarySource: { type: T.STRING, field: 'tertiary_source' },
    tertiaryMedium: { type: T.STRING, field: 'tertiary_medium' }, tertiaryCampaign: { type: T.STRING, field: 'tertiary_campaign' },
    leadPayload: { type: T.JSON, field: 'lead_payload' }, registeredOn: { type: T.DATE, field: 'registered_on' },
    city: { type: T.STRING }, state: { type: T.STRING }, isoCode: { type: T.STRING, field: 'iso_code' },
    leadCountry: { type: T.STRING, field: 'lead_country' }, grade: { type: T.STRING },
    widgetId: { type: T.INTEGER, field: 'widget_id' }, programEligible: { type: T.TEXT, field: 'program_eligible' },
    previousLeadStage: { type: T.INTEGER, field: 'previous_lead_stage' }, leadStageDate: { type: T.DATE, field: 'lead_stage_date' },
    reassignedBy: { type: T.INTEGER, field: 'reassigned_by' }, reassignedOn: { type: T.DATE, field: 'reassigned_on' },
    formName: { type: T.TEXT, field: 'form_name' }, referrer: { type: T.TEXT }, sourceUrl: { type: T.TEXT, field: 'source_url' },
    instaHandle: { type: T.TEXT, field: 'insta_handle' }, crispChatLink: { type: T.TEXT, field: 'crisp_chat_link' },
    cbbLink: { type: T.TEXT, field: 'cbb_link' }, isChatbotLead: { type: T.BOOLEAN, field: 'is_chatbot_lead' },
    concatSMC: { type: T.TEXT, field: 'concat_smc' }, chatSummary: { type: T.TEXT, field: 'chat_summary' },
    humanHandoff: { type: T.TEXT, field: 'human_handoff' },
    v1LeadId: { type: T.INTEGER, field: 'v1_lead_id' }, v1ApplicationId: { type: T.INTEGER, field: 'v1_application_id' },
    v1UserId: { type: T.INTEGER, field: 'v1_user_id' }, isInboundLead: { type: T.BOOLEAN, field: 'is_inbound_lead' },
    createdBy: { type: T.INTEGER, field: 'created_by' },
    createdAt: { type: T.DATE, field: 'created_at' }, updatedAt: { type: T.DATE, field: 'updated_at' },
  }, { tableName: 'v2_leads', timestamps: true, underscored: false });

  const Note = sequelize.define('Note', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    adminId: { type: T.INTEGER, field: 'admin_id' }, leadId: { type: T.INTEGER, field: 'lead_id' },
    v2LeadId: { type: T.INTEGER, field: 'v2_lead_id' }, orgId: { type: T.INTEGER, field: 'org_id' },
    schoolId: { type: T.INTEGER, field: 'school_id' }, content: { type: T.TEXT }, visible: { type: T.BOOLEAN },
    tempId: { type: T.INTEGER, field: 'temp_id' },
    created_at: { type: T.DATE, field: 'created_at' }, updated_at: { type: T.DATE, field: 'updated_at' },
  }, { tableName: 'notes', timestamps: false, underscored: true });

  // The receiving DB records lead activity in `timelines` (which has a real
  // v2_lead_id), NOT in the legacy `userTimelines` table.
  const timelineColumns = await probeColumns(sequelize, 'timelines');
  const tlCreatedAt = timelineColumns.has('created_at') ? 'created_at' : 'createdAt';
  const tlUpdatedAt = timelineColumns.has('updated_at') ? 'updated_at' : 'updatedAt';
  console.log(`[schema] receiving timelines timestamps = ${tlCreatedAt} / ${tlUpdatedAt}`);

  const Timeline = sequelize.define('Timeline', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    leadId: { type: T.INTEGER, field: 'lead_id' },          // legacy `leads` FK
    v2LeadId: { type: T.INTEGER, field: 'v2_lead_id' },     // the one we care about
    eventType: { type: T.STRING, field: 'event_type' },     // NOT NULL
    title: { type: T.STRING },
    description: { type: T.TEXT },
    metadata: { type: T.JSONB },
    createdBy: { type: T.INTEGER, field: 'created_by' },
    orgId: { type: T.INTEGER, field: 'org_id' },
    schoolId: { type: T.INTEGER, field: 'school_id' },
    tempLeadId: { type: T.INTEGER, field: 'temp_lead_id' },
    templateId: { type: T.INTEGER, field: 'template_id' },
    createdAt: { type: T.DATE, field: tlCreatedAt },
    updatedAt: { type: T.DATE, field: tlUpdatedAt },
  }, { tableName: 'timelines', timestamps: true });

  const ActivityTracker = sequelize.define('ApplicationActivityTracker', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    leadId: { type: T.INTEGER },
    applicationForm_start_date: { type: T.DATE }, payment_Initiated_date: { type: T.DATE },
    payment_last_Initiated_date: { type: T.DATE }, counsellor_first_activity_date: { type: T.DATE },
    counsellor_last_activity_date: { type: T.DATE }, application_fee_paidOn: { type: T.DATE },
    application_last_activity_date: { type: T.DATE }, lastLeadStageUpdated: { type: T.DATE },
    firstLeadStageUpdated: { type: T.DATE }, applicationFormSubmittedOn: { type: T.DATE },
    createdAt: { type: T.DATE }, updatedAt: { type: T.DATE },
  }, { tableName: 'ApplicationActivityTrackers', timestamps: false, underscored: false });

  const LeadStage = sequelize.define('LeadStage', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    uuid: { type: T.UUID, defaultValue: T.UUIDV4 },
    stageName: { type: T.TEXT, field: 'stageName' }, organizationId: { type: T.INTEGER, field: 'organizationId' },
    schoolId: { type: T.INTEGER, field: 'schoolId' }, isActive: { type: T.BOOLEAN, field: 'isActive' },
    applicableTo: { type: T.STRING, field: 'applicableTo' }, stageBucket: { type: T.STRING, field: 'stageBucket' },
    followUpRequired: { type: T.BOOLEAN, field: 'followUpRequired' }, score: { type: T.DOUBLE },
    order: { type: T.INTEGER }, createdBy: { type: T.INTEGER, field: 'createdBy' }, updatedBy: { type: T.INTEGER, field: 'updatedBy' },
  }, { tableName: 'leadStage', timestamps: true, createdAt: 'createdAt', updatedAt: 'updatedAt' });

  const LeadSubStage = sequelize.define('LeadSubStage', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    uuid: { type: T.UUID, defaultValue: T.UUIDV4 },
    leadStageId: { type: T.INTEGER, field: 'leadStageId' }, name: { type: T.TEXT },
    isActive: { type: T.BOOLEAN, field: 'isActive' }, followUpRequired: { type: T.BOOLEAN, field: 'followUpRequired' },
    order: { type: T.INTEGER }, createdBy: { type: T.INTEGER, field: 'createdBy' }, updatedBy: { type: T.INTEGER, field: 'updatedBy' },
  }, { tableName: 'leadSubStage', timestamps: true, createdAt: 'createdAt', updatedAt: 'updatedAt' });

  const ApplicationStage = sequelize.define('ApplicationStage', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    uuid: { type: T.UUID, defaultValue: T.UUIDV4 },
    stageName: { type: T.TEXT, field: 'stageName' }, organizationId: { type: T.INTEGER, field: 'organizationId' },
    schoolId: { type: T.INTEGER, field: 'schoolId' }, isActive: { type: T.BOOLEAN, field: 'isActive' },
    stageBucket: { type: T.STRING, field: 'stageBucket' }, followUpRequired: { type: T.BOOLEAN, field: 'followUpRequired' },
    score: { type: T.DOUBLE }, order: { type: T.INTEGER },
    createdBy: { type: T.INTEGER, field: 'createdBy' }, updatedBy: { type: T.INTEGER, field: 'updatedBy' },
  }, { tableName: 'applicationStage', timestamps: true, createdAt: 'createdAt', updatedAt: 'updatedAt' });

  const ApplicationSubStage = sequelize.define('ApplicationSubStage', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    uuid: { type: T.UUID, defaultValue: T.UUIDV4 },
    applicationStageId: { type: T.INTEGER, field: 'applicationStageId' }, name: { type: T.TEXT },
    isActive: { type: T.BOOLEAN, field: 'isActive' }, followUpRequired: { type: T.BOOLEAN, field: 'followUpRequired' },
    order: { type: T.INTEGER }, createdBy: { type: T.INTEGER, field: 'createdBy' }, updatedBy: { type: T.INTEGER, field: 'updatedBy' },
  }, { tableName: 'applicationSubStage', timestamps: true, createdAt: 'createdAt', updatedAt: 'updatedAt' });

  const User = sequelize.define('User', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    email: { type: T.STRING }, name: { type: T.STRING },
    passwordHash: { type: T.STRING, field: 'password_hash' },
    role: { type: T.STRING }, status: { type: T.STRING },
    phone: { type: T.STRING }, countryCode: { type: T.STRING, field: 'country_code' },
    organizationId: { type: T.INTEGER, field: 'organization_id' },
    schoolId: { type: T.INTEGER, field: 'school_id' },
    // present only when the receiving users table really has the column
    ...(v1IdColumn ? { v1Id: { type: T.INTEGER, field: v1IdColumn } } : {}),
    createdAt: { type: T.DATE, field: userCreatedAt },
    updatedAt: { type: T.DATE, field: userUpdatedAt },
  }, { tableName: 'users', timestamps: true });

  const School = sequelize.define('School', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    orgId: { type: T.INTEGER, field: 'org_id' }, name: { type: T.STRING },
  }, { tableName: 'schools', timestamps: true, underscored: true });

  const Round = sequelize.define('Round', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    uuid: { type: T.UUID, defaultValue: T.UUIDV4 },
    orgId: { type: T.INTEGER, field: 'org_id' }, schoolId: { type: T.INTEGER, field: 'school_id' },
    programId: { type: T.INTEGER, field: 'program_id' }, batchId: { type: T.INTEGER, field: 'batch_id' },
    name: { type: T.STRING }, code: { type: T.STRING },
    startDate: { type: T.DATEONLY, field: 'start_date' }, endDate: { type: T.DATEONLY, field: 'end_date' },
    capacity: { type: T.INTEGER }, isActive: { type: T.BOOLEAN, field: 'is_active' },
    displayOrder: { type: T.INTEGER, field: 'display_order' },
    createdBy: { type: T.INTEGER, field: 'created_by' },
    createdAt: { type: T.DATE, field: 'created_at' }, updatedAt: { type: T.DATE, field: 'updated_at' },
  }, { tableName: 'rounds', timestamps: true, underscored: false });

  // receiving-side twin of v1 `cohorts`
  const Batch = sequelize.define('Batch', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    uuid: { type: T.UUID, defaultValue: T.UUIDV4 },
    orgId: { type: T.INTEGER, field: 'org_id' }, schoolId: { type: T.INTEGER, field: 'school_id' },
    programId: { type: T.INTEGER, field: 'program_id' },
    name: { type: T.STRING }, code: { type: T.STRING }, alias: { type: T.STRING },
    startDate: { type: T.DATEONLY, field: 'start_date' }, endDate: { type: T.DATEONLY, field: 'end_date' },
    capacity: { type: T.INTEGER }, isActive: { type: T.BOOLEAN, field: 'is_active' },
    createdBy: { type: T.INTEGER, field: 'created_by' },
    createdAt: { type: T.DATE, field: 'created_at' }, updatedAt: { type: T.DATE, field: 'updated_at' },
  }, { tableName: 'batches', timestamps: true, underscored: false });

  /* The receiving side of a v1 tag NAME. UNIQUE on (org_id, name), so a name is
   * matched before it is ever created. v1_tag_id carries the source
   * `LeadTags`.id when the name came out of the org's catalogue. */
  const Tag = sequelize.define('Tag', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    orgId: { type: T.INTEGER, field: 'org_id' },
    name: { type: T.STRING },
    color: { type: T.STRING },
    createdBy: { type: T.INTEGER, field: 'created_by' },
    v1TagId: { type: T.INTEGER, field: 'v1_tag_id' },
    created_at: { type: T.DATE, field: 'created_at' },
    updated_at: { type: T.DATE, field: 'updated_at' },
  }, { tableName: 'tags', timestamps: false, underscored: true });

  /* The join row. `lead_id` is a FK to the LEGACY `leads` table and stays NULL —
   * v2_lead_id is the real link, exactly as with notes / timelines. Re-runs
   * dedup on the partial UNIQUE (v2_lead_id, tag_id). */
  const LeadTagLink = sequelize.define('LeadTagLink', {
    id: { type: T.INTEGER, primaryKey: true, autoIncrement: true },
    leadId: { type: T.INTEGER, field: 'lead_id' },
    v2LeadId: { type: T.INTEGER, field: 'v2_lead_id' },
    tagId: { type: T.INTEGER, field: 'tag_id' },
    orgId: { type: T.INTEGER, field: 'org_id' },
    schoolId: { type: T.INTEGER, field: 'school_id' },
    v1LeadId: { type: T.INTEGER, field: 'v1_lead_id' },
    created_at: { type: T.DATE, field: 'created_at' },
    updated_at: { type: T.DATE, field: 'updated_at' },
  }, { tableName: 'lead_tags', timestamps: false, underscored: true });

  return { sequelize, V2Lead, Note, Timeline, ActivityTracker, LeadStage, LeadSubStage, ApplicationStage, ApplicationSubStage, User, School, Round, Batch, Tag, LeadTagLink, v1IdColumn };
};

/* ==========================================================================
 * 4. LOOKUP CACHES (built once, then pure in-memory resolution)
 * ========================================================================== */

const norm = (v) => (v === null || v === undefined ? null : String(v).trim().toLowerCase());

/** Tolerant JSON reader — the v1 columns are JSON but can arrive as text. */
const parseJson = (v) => {
  if (v === null || v === undefined) return {};
  if (typeof v === 'object') return Array.isArray(v) ? { items: v } : v;
  try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : { raw: v }; }
  catch { return { raw: v }; }
};

/** v1 UserTimelines.eventType is {icon, title} — the title is the human label. */
const timelineTitleOf = (row) => {
  const evt = parseJson(row?.eventType);
  const title = evt?.title ?? evt?.raw ?? null;
  return title ? String(title).slice(0, 255) : null;
};

const stats = {
  // resume cursor: where this run began, and the last source id it got through
  startedAfterId: 0, lastIdProcessed: 0,
  scanned: 0, migrated: 0, updated: 0, skippedExisting: 0, failed: 0,
  notes: 0, timelines: 0, trackers: 0,
  notesAlready: 0, timelinesAlready: 0,
  notesFound: 0, timelinesFound: 0, trackersFound: 0,
  // tags: `tagLinks*` counts lead_tags rows, `tags*` counts rows in `tags`
  tagLinks: 0, tagLinksFound: 0, tagLinksAlready: 0,
  leadsWithTags: 0, tagLeadsNotMigrated: 0,
  tagsMatched: 0, tagsCreated: 0, tagNamesUnresolved: 0,
  tagsWouldCreate: new Map(),
  tagMisses: new Map(),
  tagLeadMissingSample: [],
  unresolvedLeadStages: new Map(),
  unresolvedSubStages: new Map(),
  unresolvedAppStages: new Map(),
  unresolvedUsers: new Set(),
  counsellorResolved: 0,
  counsellorMisses: new Map(),
  usersCreated: 0,
  usersWouldCreate: new Map(),
  userRoleRejected: new Map(),
  userOrgMismatches: new Map(),
  stagesCreated: 0,
  subStagesCreated: 0,
  stagesWouldCreate: new Map(),
  roundsMatched: 0,
  roundsCreated: 0,
  roundsWouldCreate: new Map(),
  roundMisses: new Map(),
  batchesMatched: 0,
  batchesCreated: 0,
  batchesWouldCreate: new Map(),
  batchMisses: new Map(),
  notesWithoutAdmin: 0,
  errors: [],
  // where the wall-clock actually goes (ms) — tells you whether to tune the
  // source queries, the receiving DB, or neither
  msSourceFetch: 0, msDedupFetch: 0, msPrepare: 0, msWrite: 0,
};
const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

/** Human-readable description of the timeline age window, for logs + report. */
const timelineWindowLabel = () => {
  if (!CONFIG.timelinesSince) return 'timelines: ALL history';
  const iso = CONFIG.timelinesSince.toISOString().slice(0, 19).replace('T', ' ');
  return CONFIG.timelinesMonths
    ? `timelines: last ${CONFIG.timelinesMonths} month(s), createdAt >= ${iso}`
    : `timelines: createdAt >= ${iso}`;
};

/* ---------- concurrency helpers ---------------------------------------- */

/**
 * Run `worker` over `items` with at most `size` in flight.
 * Used for the per-lead work; each lead still gets its own transaction.
 */
const pool = async (items, size, worker) => {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(lanes);
};

/**
 * Postgres refuses more than 65535 bind parameters in one statement, and a
 * multi-row INSERT uses (rows × columns) of them. 500 leads × ~90 columns would
 * blow straight through it, so every bulk insert is split to fit.
 */
const PG_PARAM_BUDGET = 55000;
const bulkInsert = async (model, rows, transaction, opts = {}) => {
  if (!rows.length) return [];
  const cols = Math.max(1, Object.keys(model.rawAttributes).length);
  const perStatement = Math.max(1, Math.floor(PG_PARAM_BUDGET / cols));
  // validate/hooks off: there is nothing to validate (rows come straight from the
  // field map) and skipping it avoids per-row work across millions of rows.
  const o = { transaction, validate: false, hooks: false, individualHooks: false, ...opts };
  if (rows.length <= perStatement) return model.bulkCreate(rows, o);

  const out = [];
  for (let i = 0; i < rows.length; i += perStatement) {
    const part = await model.bulkCreate(rows.slice(i, i + perStatement), o);
    out.push(...part);
  }
  return out;
};

/**
 * Memoise a PROMISE per key. With several leads in flight this is what stops two
 * of them creating the same user / stage / round twice: the second caller awaits
 * the first one's in-flight promise instead of starting its own insert.
 */
const once = (map, key, fn) => {
  if (!map.has(key)) map.set(key, Promise.resolve().then(fn));
  return map.get(key);
};

/* ---------- live progress line ----------------------------------------- */

const ui = {
  total: 0,
  done: 0,
  startedAt: 0,
  lastPaint: 0,
  active: false,

  start(total) {
    this.total = total; this.done = 0; this.startedAt = Date.now(); this.active = true;
    this.paint(true);
  },
  /** Print something WITHOUT the progress line eating it. */
  log(msg) {
    if (this.active && process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(110) + '\r');
    console.log(msg);
    this.paint(true);
  },
  tick(n = 1) { this.done += n; this.paint(); },

  paint(force = false) {
    if (!this.active) return;
    const now = Date.now();
    if (!force && now - this.lastPaint < 250) return;   // ~4 fps, cheap
    this.lastPaint = now;

    const pct = this.total ? (this.done / this.total) * 100 : 0;
    const secs = Math.max(0.001, (now - this.startedAt) / 1000);
    const rate = this.done / secs;
    const eta = rate > 0 && this.total > this.done ? (this.total - this.done) / rate : 0;

    const width = 24;
    const filled = Math.round((pct / 100) * width);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    const line = `  [${bar}] ${pct.toFixed(1).padStart(5)}%  ${this.done}/${this.total} leads`
      + `  ${rate.toFixed(1)}/s  elapsed ${fmtDuration(secs)}  ETA ${fmtDuration(eta)}`
      + (CONFIG.tagsOnly
        ? `  +${stats.tagLinks} tags =${stats.tagLinksAlready} ?${stats.tagLeadsNotMigrated} ✗${stats.failed}`
        : `  +${stats.migrated} ~${stats.updated} =${stats.skippedExisting} ✗${stats.failed}`);

    if (process.stdout.isTTY) process.stdout.write('\r' + line.padEnd(110).slice(0, 130));
    else if (force || this.done % 500 === 0) console.log(line.trim());
  },
  stop() {
    if (this.active && process.stdout.isTTY) { this.paint(true); process.stdout.write('\n'); }
    this.active = false;
  },
};

const fmtDuration = (s) => {
  if (!isFinite(s) || s <= 0) return '0s';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(sec).padStart(2, '0')}s` : `${sec}s`;
};

// name of the receiving users column that holds the source user id (probed at startup)
let tgtV1IdColumn = null;

/**
 * The distinct tag NAMES on one or more v1 array columns, in source order.
 * v1 arrays are hand-edited and routinely carry '', '  ' and case variants of
 * the same tag; those collapse here so a lead never links the same v2 tag twice.
 */
const tagNamesOf = (...arrays) => {
  const seen = new Set();
  const out = [];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const raw of arr) {
      const name = String(raw ?? '').trim();
      if (!name) continue;
      const key = norm(name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
};

/**
 * One `lead_tags` row. `lead_id` is the LEGACY `leads` FK and stays NULL for the
 * same reason notes.lead_id and timelines.lead_id do — v2_lead_id is the link.
 * The timestamps are the moment of migration: v1 stores tags as a bare array, so
 * there is no "when was this tag applied" to carry over.
 */
const tagLinkRow = (v2LeadId, tagId, v1LeadId, ctx) => {
  const now = new Date();
  return {
    leadId: CONFIG.target.writeLegacyLeadId ? v2LeadId : null,
    v2LeadId,
    tagId,
    orgId: ctx.route.orgId,
    schoolId: ctx.schoolId,
    v1LeadId,
    created_at: now,
    updated_at: now,
  };
};

/* ==========================================================================
 * 4a. TAGS  —  v1 name -> receiving `tags` row
 * --------------------------------------------------------------------------
 * Built on its own (not inside buildCaches) because --tags-only needs exactly
 * this and nothing else: no stages, no users, no rounds, no cohorts.
 * ========================================================================== */

const buildTagCache = async (src, tgt) => {
  /* The org's tag CATALOGUE on the source side. Only used to recover the v1 id
   * for a name we end up creating — a lead's tags are names, not ids, and a
   * name can perfectly well be on a lead without ever being in this table
   * (the catalogue row was deleted, or the tag was typed in bulk). */
  const v1Tags = await src.LeadTag.findAll({
    where: { organizationId: CONFIG.source.organizationId }, raw: true,
  });
  const v1TagByName = new Map();
  for (const t of v1Tags) {
    const key = norm(t.tagName);
    // a live row always beats a soft-deleted one carrying the same name
    if (key && (!v1TagByName.has(key) || (v1TagByName.get(key).isDeleted && !t.isDeleted))) v1TagByName.set(key, t);
  }

  // every tag the target org already has — one read, then pure memory
  const v2Tags = await tgt.Tag.findAll({ where: { orgId: CONFIG.target.orgId }, raw: true });

  const tagCache = new Map();   // norm(name) -> Promise<v2 tags.id | null>

  /**
   * One v1 tag name -> a receiving `tags`.id, creating the row when it is absent.
   *
   * Match order is exact-name first, then case-insensitive: `tags` is UNIQUE on
   * (org_id, name) CASE-SENSITIVELY, so "Testing" and "testing" *can* coexist
   * there. Preferring the exact match keeps an existing pair intact; falling
   * back to a case-insensitive one stops the migration from minting a
   * near-duplicate of a tag the org already uses.
   */
  const resolveTagId = (rawName) => {
    const name = String(rawName ?? '').trim();
    if (!name) return Promise.resolve(null);
    // memoised on the PROMISE, so parallel leads sharing a tag never race to create it
    return once(tagCache, norm(name), async () => {
      const hit = v2Tags.find((t) => t.name === name) || v2Tags.find((t) => norm(t.name) === norm(name));
      if (hit) { stats.tagsMatched += 1; return hit.id; }

      if (!CONFIG.target.createMissingTags) { bump(stats.tagMisses, name); return null; }
      if (!CONFIG.commit) { bump(stats.tagsWouldCreate, name); return null; }   // dry run creates nothing

      const v1 = v1TagByName.get(norm(name)) || null;
      const now = new Date();
      let created;
      try {
        created = await tgt.Tag.create({
          orgId: CONFIG.target.orgId,
          name,
          color: CONFIG.target.createdTagColor,
          createdBy: CONFIG.target.migrationUserId,
          v1TagId: v1?.id ?? null,
          created_at: now,
          updated_at: now,
        });
      } catch (err) {
        // UNIQUE (org_id, name): another process got there between our read and
        // our insert. Its row is just as good — go and find it.
        const [row] = await tgt.sequelize.query(
          'SELECT id, name FROM tags WHERE org_id = :org AND name = :name',
          { replacements: { org: CONFIG.target.orgId, name }, type: Sequelize.QueryTypes.SELECT },
        );
        if (!row) throw err;
        v2Tags.push({ id: row.id, name: row.name, orgId: CONFIG.target.orgId });
        stats.tagsMatched += 1;
        return row.id;
      }

      ui.log(`  + created tag "${name}" -> tags.id = ${created.id}${v1 ? ` (v1_tag_id = ${v1.id})` : ''}`);
      stats.tagsCreated += 1;
      v2Tags.push({ id: created.id, name, orgId: CONFIG.target.orgId });
      return created.id;
    });
  };

  /**
   * Every name on the lead -> its v2 tag ids, unresolved ones dropped.
   *
   * In a DRY RUN a name whose tag does not exist yet resolves to null — nothing
   * is created — so the link count below is only what would land against tags
   * that are ALREADY there. `tagNamesUnresolved` is the rest, and the summary
   * says so; a --commit run creates those tags and links them too.
   */
  const resolveTagIds = async (names) => {
    const ids = [];
    for (const name of names) {
      const id = await resolveTagId(name);
      if (!id) { stats.tagNamesUnresolved += 1; continue; }
      if (!ids.includes(id)) ids.push(id);   // two v1 names can fold onto one v2 tag
    }
    return ids;
  };

  console.log(`[cache] v1 tag catalogue=${v1Tags.length} | v2 tags in org ${CONFIG.target.orgId}=${v2Tags.length}`);

  return { resolveTagId, resolveTagIds };
};

const buildCaches = async (src, tgt) => {
  // --- v1 stages (both lead + applicant live in LeadStage) --------------
  const v1Stages = await src.LeadStage.findAll({ where: { organizationId: CONFIG.source.organizationId }, raw: true });
  const v1SubStages = await src.LeadSubStage.findAll({
    where: { leadStageId: { [Op.in]: v1Stages.map((s) => s.id) } }, raw: true,
  });
  const v1StageById = new Map(v1Stages.map((s) => [s.id, s]));
  const v1SubStageById = new Map(v1SubStages.map((s) => [s.id, s]));

  // --- v2 stages for the target org --------------------------------------
  const ROUTES = [CONFIG.target];
  const orgIds = [...new Set(ROUTES.map((r) => r.orgId).filter(Boolean))];
  const [v2LeadStages, v2AppStages] = await Promise.all([
    tgt.LeadStage.findAll({ where: { organizationId: { [Op.in]: orgIds } }, raw: true }),
    tgt.ApplicationStage.findAll({ where: { organizationId: { [Op.in]: orgIds } }, raw: true }),
  ]);
  const [v2LeadSubStages, v2AppSubStages] = await Promise.all([
    tgt.LeadSubStage.findAll({ where: { leadStageId: { [Op.in]: v2LeadStages.map((s) => s.id) } }, raw: true }),
    tgt.ApplicationSubStage.findAll({ where: { applicationStageId: { [Op.in]: v2AppStages.map((s) => s.id) } }, raw: true }),
  ]);

  /**
   * own-else-shared: inside the lead's org, prefer the row scoped to its school,
   * then fall back to the org-wide default (schoolId IS NULL). Same precedence
   * the v2 app itself uses.
   */
  const pickScoped = (rows, name, orgId, schoolId) => {
    const hits = rows.filter((r) => r.organizationId === orgId && norm(r.stageName ?? r.name) === norm(name));
    if (!hits.length) return null;
    return (
      hits.find((r) => schoolId != null && r.schoolId === schoolId && r.isActive !== false) ||
      hits.find((r) => r.schoolId == null && r.isActive !== false) ||
      hits.find((r) => schoolId != null && r.schoolId === schoolId) ||
      hits.find((r) => r.schoolId == null) ||
      null
    );
  };

  /* ------------------------------------------------------------------ *
   * USERS — resolve in the receiving DB, CREATE when absent
   *   match order: users.v1_id = <source id>  ->  lower(email)  ->  create
   * A created user is a copy of the source row (email, name, phone, and its
   * existing bcrypt password hash) with the SOURCE users.id written into the
   * receiving users.v1_id column.
   * ------------------------------------------------------------------ */
  // Users are looked up ON DEMAND, not bulk-loaded: the two tables hold ~500k and
  // ~200k rows, and only the handful of staff attached to these leads matter.
  // Every lookup is memoised, so each distinct person costs one query per run.
  const v1UserCache = new Map();   // 'id:<n>' | 'uuid:<s>' -> source user row | null
  const ensuredUsers = new Map();  // v1 user id -> Promise<v2 user id | null>

  const findV1UserById = (id) => once(v1UserCache, `id:${id}`, () =>
    src.User.findOne({ where: { id }, raw: true }));
  const findV1UserByUuid = (uuid) => once(v1UserCache, `uuid:${uuid}`, () =>
    src.User.findOne({ where: { uuid }, raw: true }));

  const v2UserAttrs = ['id', 'email', 'role', 'organizationId', ...(tgt.v1IdColumn ? ['v1Id'] : [])];

  /**
   * Give the receiving DB a user for this source user, creating it if needed.
   * opts.excludeRoles — receiving roles that must never be returned (the counsellor
   * chain passes ['student'], since the same email is usually the applicant too).
   */
  const ensureTargetUser = (v1User, opts = {}) => {
    if (!v1User) return Promise.resolve(null);
    const excludeRoles = (opts.excludeRoles || []).map((r) => String(r).toLowerCase());
    const excluded = (u) => excludeRoles.includes(String(u.role || '').toLowerCase());
    // a filtered lookup can resolve differently, so it gets its own cache slot
    const cacheKey = excludeRoles.length ? `${v1User.id}!${excludeRoles.join(',')}` : String(v1User.id);
    // memoised on the PROMISE, so parallel leads sharing a counsellor never race
    return once(ensuredUsers, cacheKey, async () => {
      // 1. already migrated? (v1_id is the strongest link)
      if (tgt.v1IdColumn) {
        const hit = await tgt.User.findOne({ where: { v1Id: v1User.id }, attributes: v2UserAttrs, raw: true });
        // an excluded role falls through to the email step, which may still find a
        // usable row for the same person (and reports it if it does not)
        if (hit && !excluded(hit)) return hit.id;
      }

      // 2. same person by email — ORG-SCOPED FIRST. The receiving users table is
      //    multi-tenant, so a bare email match could hand a lead in org 12 a user
      //    that belongs to a different organization.
      const email = norm(v1User.email);
      if (email) {
        const allSameEmail = await tgt.User.findAll({
          where: Sequelize.where(Sequelize.fn('lower', Sequelize.col('email')), email),
          attributes: v2UserAttrs, raw: true,
        });
        const sameEmail = allSameEmail.filter((u) => !excluded(u));
        const blocked = allSameEmail.filter(excluded);
        const inOrg = sameEmail.find((u) => u.organizationId === CONFIG.target.orgId);
        const foreign = sameEmail.find((u) => u.organizationId !== CONFIG.target.orgId);
        if (!inOrg && foreign && !CONFIG.target.reuseUsersFromOtherOrgs) {
          bump(stats.userOrgMismatches, `${email} exists only in org ${foreign.organizationId}`);
        }
        const match = inOrg || (CONFIG.target.reuseUsersFromOtherOrgs ? foreign : null);
        if (match && !inOrg) bump(stats.userOrgMismatches, `${email} reused from org ${match.organizationId}`);

        if (match) {
          // backfill v1_id so the next run matches on step 1 — only when it is still
          // empty, so an existing link to a different source user is never overwritten
          if (tgt.v1IdColumn && CONFIG.commit && match.v1Id == null) {
            await tgt.User.update({ v1Id: v1User.id }, { where: { id: match.id } }).catch(() => {});
          }
          return match.id;
        }

        // the email exists in the receiving DB, but only under a role this lookup
        // rejects (a student). Creating a second row is not an option — users.email
        // is UNIQUE — so this stays unassigned and is reported.
        if (blocked.length) {
          bump(stats.userRoleRejected, `${email} exists only as ${[...new Set(blocked.map((u) => u.role))].join('/')}`);
          return null;
        }
      }

      // 3. create
      if (!email) {
        stats.unresolvedUsers.add(`v1 user ${v1User.id} has no email`);
        return null;
      }
      if (!CONFIG.target.createMissingUsers) {
        stats.unresolvedUsers.add(email);
        return null;
      }
      if (!CONFIG.commit) {
        bump(stats.usersWouldCreate, `${email} (v1 id ${v1User.id})`);
        return null; // dry run writes nothing
      }

      const created = await tgt.User.create({
        email,
        name: v1User.name || email,
        // source users.password IS a bcrypt hash -> copy it straight into
        // password_hash so the person keeps their existing credentials.
        // Only when the source row has none do we fall back to an unusable random hash.
        passwordHash: v1User.password || await bcrypt.hash(crypto.randomUUID(), 10),
        role: CONFIG.target.createdUserRole,
        status: CONFIG.target.createdUserStatus,
        phone: v1User.mobileNumber || null,
        countryCode: String(v1User.countryCode || '').replace(/\D/g, '') || null,
        organizationId: CONFIG.target.orgId,
        schoolId: CONFIG.target.schoolId,
        ...(tgt.v1IdColumn ? { v1Id: v1User.id } : {}),
      });
      ui.log(`  + created user "${email}" -> users.id = ${created.id}${tgt.v1IdColumn ? ` (${tgt.v1IdColumn} = ${v1User.id})` : ''}`);
      stats.usersCreated += 1;
      return created.id;
    });
  };

  const mapUserId = async (v1Id) => {
    if (!v1Id) return null;
    const u = await findV1UserById(Number(v1Id));
    if (!u) { stats.unresolvedUsers.add(`id:${v1Id} (not in source users)`); return null; }
    return ensureTargetUser(u);
  };
  const mapUserUuid = async (uuid) => {
    if (!uuid) return null;
    const u = await findV1UserByUuid(String(uuid));
    if (!u) { stats.unresolvedUsers.add(`uuid:${uuid} (not in source users)`); return null; }
    return ensureTargetUser(u);
  };

  /**
   * COUNSELLOR CHAIN (v1 manageLeads -> v2 v2_leads.counsellor_id)
   *   1. take manageLeads.assignTo — the counsellor's user UUID. (manageLeads has
   *      no counsellorId column; if a DB ever grows one it is preferred.)
   *   2. find that row in the SOURCE users table (by uuid, or by id if numeric)
   *   3. read its email
   *   4. find the same email in the RECEIVING users table, SKIPPING any row whose
   *      role is in CONFIG.target.counsellorExcludedRoles — the applicant carries
   *      the same email, and an unfiltered match makes a student the counsellor
   *   5. absent there? create the user (see ensureTargetUser) and use the new id
   *   6. store that id in v2_leads.counsellor_id
   */
  const mapCounsellor = async (lead) => {
    const raw = lead.counsellorId ?? lead.assignTo ?? null;   // step 1
    if (raw === null || raw === '') return null;

    // step 2 — uuid (assignTo) or integer id (counsellorId)
    const isUuid = typeof raw === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
    const v1User = isUuid ? await findV1UserByUuid(String(raw)) : await findV1UserById(Number(raw));
    if (!v1User) {
      bump(stats.counsellorMisses, `source user not found (${raw})`);
      return null;
    }
    if (!norm(v1User.email)) {                                 // step 3
      bump(stats.counsellorMisses, `source user ${v1User.id} has no email`);
      return null;
    }

    // steps 4-5 — never resolve a counsellor onto a student account
    const v2Id = await ensureTargetUser(v1User, { excludeRoles: CONFIG.target.counsellorExcludedRoles });
    if (!v2Id) {
      bump(stats.counsellorMisses, `could not resolve/create ${v1User.email}`);
      return null;
    }
    stats.counsellorResolved += 1;
    return v2Id;                                               // step 6
  };

  // --- school: CONFIG.target gives it explicitly; only auto-match when null
  const autoSchoolIdByOrg = new Map();
  if (ROUTES.some((r) => r.schoolId == null)) {
    const v1School = await src.School.findOne({ where: { organizationId: CONFIG.source.organizationId }, raw: true });
    if (v1School?.schoolName) {
      const v2Schools = await tgt.School.findAll({ where: { orgId: { [Op.in]: orgIds } }, raw: true });
      for (const oid of orgIds) {
        const hit = v2Schools.find((s) => s.orgId === oid && norm(s.name) === norm(v1School.schoolName));
        autoSchoolIdByOrg.set(oid, hit?.id ?? null);
        console.log(`[schools] "${v1School.schoolName}" (org ${oid}) -> v2 schools.id = ${hit?.id ?? 'NOT FOUND (null)'}`);
      }
    }
  }
  const schoolFor = (route) => route.schoolId ?? autoSchoolIdByOrg.get(route.orgId) ?? null;

  /* ------------------------------------------------------------------ *
   * STAGES — match the v1 stage NAME in the receiving DB, CREATE when absent.
   * The created row mirrors the source stage (name, order, followUpRequired,
   * score, isActive). Its school scope comes from CONFIG.target.createdStageSchoolId
   * (null = org-wide default, which every v2 screen can see).
   * ------------------------------------------------------------------ */

  // Memoised per stage/sub-stage so parallel leads never create the same row twice.
  const stagePromises = new Map();

  /** v1 stage id -> v2 leadStage id, inside the target org+school */
  const resolveLeadStage = (v1StageId, route) => {
    if (!v1StageId) return Promise.resolve(null);
    return once(stagePromises, `lead:${v1StageId}`, async () => {
      const v1 = v1StageById.get(Number(v1StageId));
      if (!v1) { bump(stats.unresolvedLeadStages, `#${v1StageId} (missing in source)`); return null; }

      const hit = pickScoped(v2LeadStages, v1.stageName, route.orgId, schoolFor(route));
      if (hit) return hit.id;

      if (!CONFIG.target.createMissingStages) { bump(stats.unresolvedLeadStages, v1.stageName); return null; }
      if (!CONFIG.commit) { bump(stats.stagesWouldCreate, `leadStage "${v1.stageName}"`); return null; }

      const created = await tgt.LeadStage.create({
        stageName: v1.stageName,
        organizationId: route.orgId,
        schoolId: CONFIG.target.createdStageSchoolId,
        applicableTo: 'Lead',
        stageBucket: 'neither',
        followUpRequired: Boolean(v1.followUpRequired),
        score: v1.score ?? null,
        order: v1.order ?? null,
        isActive: v1.isActive !== false,
        createdBy: CONFIG.target.migrationUserId,
        updatedBy: CONFIG.target.migrationUserId,
      });
      ui.log(`  + created leadStage "${v1.stageName}" -> leadStage.id = ${created.id}`);
      stats.stagesCreated += 1;
      v2LeadStages.push({ ...created.get({ plain: true }) });
      return created.id;
    });
  };

  /** v1 sub-stage id -> v2 leadSubStage id (must sit under the resolved parent) */
  const resolveLeadSubStage = (v1SubId, resolvedParentId) => {
    if (!v1SubId || !resolvedParentId) return Promise.resolve(null);
    return once(stagePromises, `leadSub:${v1SubId}:${resolvedParentId}`, async () => {
    const v1 = v1SubStageById.get(Number(v1SubId));
    if (!v1) { bump(stats.unresolvedSubStages, `#${v1SubId} (missing in source)`); return null; }

    const hit = v2LeadSubStages.find((s) => s.leadStageId === resolvedParentId && norm(s.name) === norm(v1.name));
    if (hit) return hit.id;

    if (!CONFIG.target.createMissingStages) { bump(stats.unresolvedSubStages, v1.name); return null; }
    if (!CONFIG.commit) { bump(stats.stagesWouldCreate, `leadSubStage "${v1.name}"`); return null; }

    const created = await tgt.LeadSubStage.create({
      leadStageId: resolvedParentId,
      name: v1.name,
      followUpRequired: Boolean(v1.followUpRequired),
      order: v1.order ?? null,
      isActive: v1.isActive !== false,
      createdBy: CONFIG.target.migrationUserId,
      updatedBy: CONFIG.target.migrationUserId,
    });
    ui.log(`  + created leadSubStage "${v1.name}" under stage ${resolvedParentId} -> id = ${created.id}`);
    stats.subStagesCreated += 1;
    v2LeadSubStages.push({ ...created.get({ plain: true }) });
    return created.id;
    });
  };

  /** v1 stage id (applicableTo=Applicant) -> v2 applicationStage id */
  const resolveAppStage = (v1StageId, route) => {
    if (!v1StageId) return Promise.resolve(null);
    return once(stagePromises, `app:${v1StageId}`, async () => {
    const v1 = v1StageById.get(Number(v1StageId));
    if (!v1) { bump(stats.unresolvedAppStages, `#${v1StageId} (missing in source)`); return null; }

    const hit = pickScoped(v2AppStages, v1.stageName, route.orgId, schoolFor(route));
    if (hit) return hit.id;

    if (!CONFIG.target.createMissingStages) { bump(stats.unresolvedAppStages, v1.stageName); return null; }
    if (!CONFIG.commit) { bump(stats.stagesWouldCreate, `applicationStage "${v1.stageName}"`); return null; }

    const created = await tgt.ApplicationStage.create({
      stageName: v1.stageName,
      organizationId: route.orgId,
      schoolId: CONFIG.target.createdStageSchoolId,
      stageBucket: 'neither',
      followUpRequired: Boolean(v1.followUpRequired),
      score: v1.score ?? null,
      order: v1.order ?? null,
      isActive: v1.isActive !== false,
      createdBy: CONFIG.target.migrationUserId,
      updatedBy: CONFIG.target.migrationUserId,
    });
    ui.log(`  + created applicationStage "${v1.stageName}" -> applicationStage.id = ${created.id}`);
    stats.stagesCreated += 1;
    v2AppStages.push({ ...created.get({ plain: true }) });
    return created.id;
    });
  };

  const resolveAppSubStage = (v1SubId, resolvedParentId) => {
    if (!v1SubId || !resolvedParentId) return Promise.resolve(null);
    return once(stagePromises, `appSub:${v1SubId}:${resolvedParentId}`, async () => {
    const v1 = v1SubStageById.get(Number(v1SubId));
    if (!v1) { bump(stats.unresolvedSubStages, `#${v1SubId} (missing in source)`); return null; }

    const hit = v2AppSubStages.find((s) => s.applicationStageId === resolvedParentId && norm(s.name) === norm(v1.name));
    if (hit) return hit.id;

    if (!CONFIG.target.createMissingStages) { bump(stats.unresolvedSubStages, v1.name); return null; }
    if (!CONFIG.commit) { bump(stats.stagesWouldCreate, `applicationSubStage "${v1.name}"`); return null; }

    const created = await tgt.ApplicationSubStage.create({
      applicationStageId: resolvedParentId,
      name: v1.name,
      followUpRequired: Boolean(v1.followUpRequired),
      order: v1.order ?? null,
      isActive: v1.isActive !== false,
      createdBy: CONFIG.target.migrationUserId,
      updatedBy: CONFIG.target.migrationUserId,
    });
    ui.log(`  + created applicationSubStage "${v1.name}" under stage ${resolvedParentId} -> id = ${created.id}`);
    stats.subStagesCreated += 1;
    v2AppSubStages.push({ ...created.get({ plain: true }) });
    return created.id;
    });
  };

  /* ------------------------------------------------------------------ *
   * ROUND CHAIN (v1 manageLeads.roundId -> v2 v2_leads.round_id)
   *   1. take manageLeads.roundId
   *   2. read its name from the SOURCE rounds table
   *   3. find a round with that name in the RECEIVING rounds table
   *      (same org, preferring the same school + program)
   *   4. not there? CREATE it in the receiving DB (org/school/program from the
   *      the target scope, dates carried over from the source round)
   *   5. store that id in v2_leads.round_id
   * Created rounds are cached, so a name is only ever created once per run.
   * ------------------------------------------------------------------ */
  const v1Rounds = await src.Round.findAll({ where: { organizationId: CONFIG.source.organizationId }, raw: true });
  const v1RoundById = new Map(v1Rounds.map((r) => [r.id, r]));
  const roundCache = new Map();      // `${orgId}:${schoolId}:${programId}:${name}` -> v2 round id
  const v2RoundsByOrg = new Map();   // orgId -> the receiving DB's rounds, fetched once
  const roundsForOrg = async (orgId) => {
    if (!v2RoundsByOrg.has(orgId)) v2RoundsByOrg.set(orgId, await tgt.Round.findAll({ where: { orgId }, raw: true }));
    return v2RoundsByOrg.get(orgId);
  };

  const resolveRoundId = (v1RoundId, route, batchId = null) => {
    if (!v1RoundId) return Promise.resolve(null);
    const v1Round = v1RoundById.get(Number(v1RoundId));               // step 2
    if (!v1Round?.name) { bump(stats.roundMisses, `v1 round ${v1RoundId} not found / unnamed`); return Promise.resolve(null); }

    const schoolId = schoolFor(route);
    const key = `${route.orgId}:${schoolId}:${route.programId}:${norm(v1Round.name)}`;
    // memoised on the promise so parallel leads share one create
    return once(roundCache, key, async () => {

    // step 3 — match by name inside the org, prefer the exact school+program row
    const candidates = await roundsForOrg(route.orgId);
    const byName = candidates.filter((r) => norm(r.name) === norm(v1Round.name));
    const hit =
      byName.find((r) => r.schoolId === schoolId && r.programId === route.programId) ||
      byName.find((r) => r.programId === route.programId) ||
      byName.find((r) => r.schoolId === schoolId) ||
      byName[0] ||
      null;

    if (hit) {
      stats.roundsMatched += 1;
      return hit.id;
    }

    // step 4 — create it
    if (!CONFIG.target.createMissingRounds) {
      bump(stats.roundMisses, `"${v1Round.name}" missing and createMissingRounds=false`);
      return null;
    }
    if (!CONFIG.commit) {
      bump(stats.roundsWouldCreate, `${v1Round.name} (org ${route.orgId}, program ${route.programId})`);
      return null; // dry run writes nothing, so there is no id yet
    }

    const created = await tgt.Round.create({
      orgId: route.orgId,
      schoolId,
      programId: route.programId,
      batchId,                                   // the batch this lead resolved to, if any
      name: v1Round.name,
      startDate: v1Round.roundStartDate || null,
      endDate: v1Round.roundEndDate || null,
      isActive: String(v1Round.status || '').toLowerCase() !== 'inactive',
      displayOrder: 0,
      createdBy: CONFIG.target.migrationUserId,
    });
    ui.log(`  + created round "${v1Round.name}" -> rounds.id = ${created.id}`);
    stats.roundsCreated += 1;
    (await roundsForOrg(route.orgId)).push({
      id: created.id, name: v1Round.name, orgId: route.orgId, schoolId, programId: route.programId,
    });
    return created.id;
    });
  };

  /* ------------------------------------------------------------------ *
   * COHORT -> BATCH CHAIN (v1 manageLeads.cohortId -> v2 v2_leads.batch_id)
   * The two DBs name the same concept differently: v1 `cohorts.cohortName`,
   * receiving `batches.name`. Same shape as the round chain:
   *   1. take manageLeads.cohortId
   *   2. read cohortName from the SOURCE cohorts table
   *   3. find that name in the RECEIVING batches table (same org, preferring
   *      the same school + program)
   *   4. not there? CREATE the batch (dates carried over from the cohort)
   *   5. store that id in v2_leads.batch_id
   * ------------------------------------------------------------------ */
  const v1Cohorts = await src.Cohort.findAll({ where: { organizationId: CONFIG.source.organizationId }, raw: true });
  const v1CohortById = new Map(v1Cohorts.map((c) => [c.id, c]));
  const batchCache = new Map();
  const v2BatchesByOrg = new Map();
  const batchesForOrg = async (orgId) => {
    if (!v2BatchesByOrg.has(orgId)) v2BatchesByOrg.set(orgId, await tgt.Batch.findAll({ where: { orgId }, raw: true }));
    return v2BatchesByOrg.get(orgId);
  };

  const resolveBatchId = (v1CohortId, route) => {
    if (!v1CohortId) return Promise.resolve(null);
    const v1Cohort = v1CohortById.get(Number(v1CohortId));            // step 2
    if (!v1Cohort?.cohortName) { bump(stats.batchMisses, `v1 cohort ${v1CohortId} not found / unnamed`); return Promise.resolve(null); }

    const schoolId = schoolFor(route);
    const key = `${route.orgId}:${schoolId}:${route.programId}:${norm(v1Cohort.cohortName)}`;
    return once(batchCache, key, async () => {

    // step 3
    const candidates = await batchesForOrg(route.orgId);
    const byName = candidates.filter((b) => norm(b.name) === norm(v1Cohort.cohortName));
    const hit =
      byName.find((b) => b.schoolId === schoolId && b.programId === route.programId) ||
      byName.find((b) => b.programId === route.programId) ||
      byName.find((b) => b.schoolId === schoolId) ||
      byName[0] ||
      null;

    if (hit) {
      stats.batchesMatched += 1;
      return hit.id;
    }

    // step 4
    if (!CONFIG.target.createMissingBatches) {
      bump(stats.batchMisses, `"${v1Cohort.cohortName}" missing and createMissingBatches=false`);
      return null;
    }
    if (!CONFIG.commit) {
      bump(stats.batchesWouldCreate, `${v1Cohort.cohortName} (org ${route.orgId}, program ${route.programId})`);
      return null;
    }

    const created = await tgt.Batch.create({
      orgId: route.orgId,
      schoolId,
      programId: route.programId,
      name: v1Cohort.cohortName,
      startDate: v1Cohort.cohortStartDate || null,
      endDate: v1Cohort.cohortEndDate || null,
      isActive: String(v1Cohort.status || '').toLowerCase() !== 'inactive',
      createdBy: CONFIG.target.migrationUserId,
    });
    ui.log(`  + created batch "${v1Cohort.cohortName}" -> batches.id = ${created.id}`);
    stats.batchesCreated += 1;
    (await batchesForOrg(route.orgId)).push({
      id: created.id, name: v1Cohort.cohortName, orgId: route.orgId, schoolId, programId: route.programId,
    });
    return created.id;
    });
  };

  // tags share the same shape as everything else here (name-match, then create),
  // but live in their own builder so --tags-only can use them alone
  const tags = CONFIG.skipTags ? { resolveTagId: async () => null, resolveTagIds: async () => [] } : await buildTagCache(src, tgt);

  console.log(`[cache] v1 stages=${v1Stages.length} subStages=${v1SubStages.length} | v2 leadStage=${v2LeadStages.length} applicationStage=${v2AppStages.length}`);
  console.log(`[cache] v1 rounds=${v1Rounds.length} v1 cohorts=${v1Cohorts.length} | users resolved lazily (no bulk load)`);

  return { schoolFor, mapUserId, mapUserUuid, mapCounsellor, resolveLeadStage, resolveLeadSubStage, resolveAppStage, resolveAppSubStage, resolveRoundId, resolveBatchId, ...tags };
};

/* ==========================================================================
 * 4b. INDEXES
 * --------------------------------------------------------------------------
 * The migration is a small set of queries run over and over — once per batch,
 * hundreds of times. Each entry below is one of those queries' access paths.
 * Missing any of them turns that query into a sequential scan of a table with
 * millions of rows, every batch: that, and not the script's own work, is what
 * makes a run take hours instead of minutes.
 *
 * `satisfiedBy` lists the leading-column sets that make a query fast. An index
 * counts as "already there" if ANY of them matches an existing index, whatever
 * it is called — several of these tables already have exactly the right index
 * under a different name, and creating a second copy would only slow every
 * INSERT down. `columns` is what gets built when none of them match.
 * ========================================================================== */

const INDEX_PLAN = (tgt) => ({
  source: [
    {
      table: 'manageLeads',
      name: 'mig_manageleads_scan_idx',
      columns: '("organizationId", "applicationFormId", "programId", "userType", "isLeadDeleted", "id")',
      // equality columns first, the keyset range column last — that ordering is
      // what lets one index serve the filter, the `id > cursor` and the ORDER BY
      satisfiedBy: [['organizationid', 'applicationformid', 'programid', 'usertype', 'isleaddeleted', 'id']],
      why: 'the batch scan + the startup count. Without it every batch walks the pkey from the cursor and'
        + ' throws away ~95% of what it reads — over a 1.7M-row / 5.7GB table, for every batch.',
    },
    {
      table: 'Notes',
      name: 'mig_notes_leadid_idx',
      columns: '("leadId")',
      satisfiedBy: [['leadid']],
      why: 'Notes WHERE leadId IN (...) — once per batch',
    },
    {
      // composite on purpose: the age window (CONFIG.timelinesSince) is part of
      // the WHERE, so createdAt belongs in the index next to leadId. A plain
      // (leadId) index is still enough to avoid a seq scan, so it also counts.
      table: 'UserTimelines',
      name: 'mig_usertimelines_lead_created_idx',
      columns: '("leadId", "createdAt")',
      satisfiedBy: [['leadid', 'createdat'], ['leadid']],
      why: 'UserTimelines WHERE leadId IN (...) AND createdAt >= cutoff — the biggest read in the migration',
    },
    {
      table: 'applicationActivityTracker',
      name: 'mig_apptracker_leadid_idx',
      columns: '("leadId")',
      satisfiedBy: [['leadid']],
      why: 'applicationActivityTracker WHERE leadId IN (...) — once per batch',
    },
    {
      table: 'users',
      name: 'mig_users_uuid_idx',
      columns: '("uuid")',
      satisfiedBy: [['uuid']],
      why: 'manageLeads.assignTo -> source users.uuid (the counsellor chain); one lookup per distinct counsellor',
    },
  ],
  target: [
    {
      // v1_lead_id is unique-ish and highly selective, so an index that LEADS
      // with it serves `org_id = X AND v1_lead_id IN (...)` on its own — org_id
      // is just a filter on the handful of rows it returns. An (org_id,
      // v1_lead_id) index is equally fine; either way, do not build a second one.
      table: 'v2_leads',
      name: 'mig_v2_leads_v1lead_idx',
      columns: '("v1_lead_id")',
      satisfiedBy: [['v1_lead_id'], ['org_id', 'v1_lead_id']],
      why: 'THE dedup lookup — runs once per batch of every committing run',
    },
    {
      table: 'notes',
      name: 'mig_notes_v2lead_idx',
      columns: '("v2_lead_id")',
      satisfiedBy: [['v2_lead_id']],
      why: 'note dedup on re-runs: notes WHERE v2_lead_id IN (...) AND temp_id IS NOT NULL',
    },
    {
      table: 'timelines',
      name: 'mig_timelines_v2lead_idx',
      columns: '("v2_lead_id")',
      satisfiedBy: [['v2_lead_id']],
      why: 'timeline dedup on re-runs — without it every resumed batch scans every partition of a 35M+ row table',
    },
    {
      table: 'ApplicationActivityTrackers',
      name: 'mig_appacttrackers_leadid_idx',
      columns: '("leadId")',
      satisfiedBy: [['leadid']],
      why: 'tracker dedup: ApplicationActivityTrackers WHERE "leadId" IN (...)',
    },
    ...(CONFIG.skipTags ? [] : [{
      table: 'lead_tags',
      name: 'mig_lead_tags_v2lead_idx',
      columns: '("v2_lead_id")',
      // the partial UNIQUE (v2_lead_id, tag_id) already leads with the column
      satisfiedBy: [['v2_lead_id'], ['v2_lead_id', 'tag_id']],
      why: 'tag dedup: lead_tags WHERE v2_lead_id IN (...) — once per batch, and the'
        + ' whole of a --tags-only run',
    }]),
    {
      table: 'users',
      name: 'mig_users_lower_email_idx',
      columns: '(lower("email"))',
      // pg renders this as lower((email)::text) for a varchar column, lower(email) for text.
      // A plain (email) index cannot serve it — the expression has to match.
      satisfiedBy: [[/^lower\(\(?email/]],
      why: 'ensureTargetUser step 2 — users WHERE lower(email) = ...',
    },
    ...(tgt.v1IdColumn ? [{
      table: 'users',
      name: `mig_users_${tgt.v1IdColumn}_idx`,
      columns: `("${tgt.v1IdColumn}")`,
      satisfiedBy: [[tgt.v1IdColumn.toLowerCase()]],
      why: `ensureTargetUser step 1 — users WHERE ${tgt.v1IdColumn} = <source id>`,
    }] : []),
  ],
});

/* NOT in the plan on purpose: an (org_id, school_id, program_id, form_id,
 * v1_lead_id) index for --resume. That query runs ONCE per run, so a few
 * seconds of bitmap scan is cheaper than the write overhead a fifth index
 * would add to every one of the ~80k lead inserts. */

/**
 * Every index on a table, with the definition Postgres itself reports.
 * relkind 'p' matters as much as 'r': the receiving `timelines` is a
 * PARTITIONED table, and looking only for ordinary tables would report its
 * indexes as missing and then try to build duplicates.
 */
const listIndexes = async (sequelize, table) => sequelize.query(
  `SELECT i.relname AS name, ix.indisvalid AS valid, pg_get_indexdef(ix.indexrelid) AS def,
          t.relkind AS relkind
     FROM pg_class t
     JOIN pg_index ix ON t.oid = ix.indrelid
     JOIN pg_class i  ON i.oid = ix.indexrelid
    WHERE t.relname = :table AND t.relkind IN ('r', 'p')`,
  { replacements: { table }, type: Sequelize.QueryTypes.SELECT },
).catch(() => []);


/**
 * The columns/expressions an existing index is built on, normalised for
 * comparison. Parsed out of pg_get_indexdef because that is the only place the
 * real thing lives — expression indexes have no column list to read.
 */
const indexColumnsOf = (def) => {
  const usingAt = def.search(/\sUSING\s/i);
  const start = def.indexOf('(', usingAt < 0 ? 0 : usingAt);
  if (start < 0) return [];

  let depth = 0, end = -1;
  for (let i = start; i < def.length; i += 1) {
    if (def[i] === '(') depth += 1;
    else if (def[i] === ')' && --depth === 0) { end = i; break; }
  }
  if (end < 0) return [];

  // split the column list on top-level commas only — lower((email)::text) has its own
  const parts = [];
  let nest = 0, cur = '';
  for (const ch of def.slice(start + 1, end)) {
    if (ch === '(') nest += 1;
    else if (ch === ')') nest -= 1;
    else if (ch === ',' && nest === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);

  return parts.map((p) => p
    .trim()
    .replace(/\s+(ASC|DESC|NULLS\s+(FIRST|LAST))/gi, '')
    .replace(/\s+\w+_ops$/i, '')       // opclass, e.g. text_pattern_ops
    .replace(/"/g, '')
    .toLowerCase());
};

const leadsWith = (cols, leading) =>
  leading.every((want, i) => (want instanceof RegExp ? want.test(cols[i] || '') : cols[i] === want));

/** Does any existing index on the table start the way one of `satisfiedBy` wants? */
const isSatisfied = (existing, want) => existing.some((ix) => {
  if (!ix.valid) return false;                       // a dead CONCURRENTLY build is not an index
  const cols = indexColumnsOf(ix.def);
  return want.satisfiedBy.some((leading) => leadsWith(cols, leading));
});

/** Which of the wanted indexes are not there yet (and any left-over invalid ones). */
const checkIndexes = async (sequelize, wanted) => {
  const byTable = new Map();
  for (const w of wanted) {
    if (!byTable.has(w.table)) byTable.set(w.table, await listIndexes(sequelize, w.table));
  }

  // Only ordinary tables: on a partitioned parent, indisvalid=false is the
  // normal state until every partition is attached, so flagging those would be
  // pure noise. On a plain table it really does mean a build that died.
  const invalid = [];
  for (const [table, rows] of byTable) {
    for (const ix of rows) if (!ix.valid && ix.relkind === 'r') invalid.push({ table, name: ix.name });
  }

  const missing = wanted.filter((w) => !isSatisfied(byTable.get(w.table) || [], w));
  return { missing, invalid, present: wanted.length - missing.length };
};

const indexDDL = (w) =>
  `CREATE INDEX ${CONFIG.indexMode === 'concurrent' ? 'CONCURRENTLY ' : ''}IF NOT EXISTS "${w.name}"`
  + ` ON "${w.table}" ${w.columns}`;

/**
 * Build the missing indexes on ONE dedicated connection.
 *
 * CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so these go
 * out as plain autocommit statements — and on their own pooled connection, so
 * the `SET statement_timeout = 0` that keeps a long build from being killed
 * still applies to them.
 */
const createIndexes = async (label, cfg, missing) => {
  const sequelize = new Sequelize(cfg.database, cfg.username, cfg.password, {
    host: cfg.host,
    port: Number(cfg.port || 5432),
    dialect: 'postgres',
    logging: false,
    dialectOptions: cfg.ssl ? { ssl: { require: true, rejectUnauthorized: false } } : {},
    pool: { max: 1, min: 1, acquire: 120000, idle: 3600000 },
  });

  let built = 0, failed = 0;
  try {
    await sequelize.authenticate();
    await sequelize.query('SET statement_timeout = 0').catch(() => {});

    for (const w of missing) {
      // `IF NOT EXISTS` would quietly keep a dead CONCURRENTLY build that happens
      // to carry our name, and we would report success on an unusable index.
      await sequelize.query(`DROP INDEX IF EXISTS "${w.name}"`).catch(() => {});

      const ddl = indexDDL(w);
      console.log(`  … [${label}] building ${w.name} on "${w.table}" ${w.columns}`);
      const t0 = Date.now();
      try {
        await sequelize.query(ddl);
        built += 1;
        console.log(`  ✓ [${label}] ${w.name} — ${fmtDuration((Date.now() - t0) / 1000)}`);
      } catch (err) {
        failed += 1;
        console.warn(`  ✗ [${label}] ${w.name} FAILED after ${fmtDuration((Date.now() - t0) / 1000)}: ${err.message}`);
        console.warn(`      run it by hand as a DB owner:  ${ddl};`);
        if (CONFIG.indexMode === 'concurrent') {
          console.warn(`      a failed CONCURRENTLY build leaves an invalid index behind:  DROP INDEX IF EXISTS "${w.name}";`);
        }
      }
    }
  } catch (err) {
    console.warn(`  ✗ [${label}] could not open a connection for index work: ${err.message}`);
  } finally {
    await sequelize.close().catch(() => {});
  }
  return { built, failed };
};

/**
 * Report — and, with --ensure-indexes, create — the indexes every batch reads
 * through. Runs after preflight so the schema is already known to be sane.
 */
const indexStep = async (src, tgt) => {
  if (CONFIG.skipIndexCheck) { console.log('\n[index] --skip-index-check — not looking at indexes.'); return; }

  const plan = INDEX_PLAN(tgt);
  console.log('\n[index] checking the indexes this migration reads through…');

  const sides = [
    { label: 'source', cfg: SRC_DB, wanted: plan.source, result: await checkIndexes(src.sequelize, plan.source) },
    { label: 'target', cfg: TGT_DB, wanted: plan.target, result: await checkIndexes(tgt.sequelize, plan.target) },
  ];

  for (const s of sides) {
    console.log(`  ${s.label}: ${s.result.present}/${s.wanted.length} present, ${s.result.missing.length} missing`);
    for (const w of s.result.missing) console.log(`      MISSING  "${w.table}" ${w.columns}\n               ${w.why}`);
    for (const bad of s.result.invalid) {
      console.warn(`      INVALID  "${bad.table}".${bad.name} — a CONCURRENTLY build that died. Postgres will not use it:`);
      console.warn(`               DROP INDEX IF EXISTS "${bad.name}";`);
    }
  }

  const totalMissing = sides.reduce((n, s) => n + s.result.missing.length, 0);
  if (!totalMissing) { console.log('  every index this migration needs is already in place.'); return; }

  if (!CONFIG.ensureIndexes) {
    console.log('\n[index] NOT creating them (default is check-only). Either run these once by hand:\n');
    for (const s of sides) for (const w of s.result.missing) console.log(`  -- ${s.label}\n  ${indexDDL(w)};`);
    console.log('\n  …or let the script build them:  node scripts/migrateLeadsToV2.js --indexes-only');
    console.log('  Until then expect sequential scans on every batch — the run will be slow.\n');
    return;
  }

  console.log(`\n[index] building ${totalMissing} index(es), mode=${CONFIG.indexMode}`
    + `${CONFIG.indexMode === 'concurrent' ? ' (CONCURRENTLY — slower, but does not block the live DB)' : ' (BLOCKING — writes to these tables wait)'}`);
  console.log('  This is a one-off cost; on the big source tables it can take several minutes each.\n');

  let built = 0, failed = 0;
  for (const s of sides) {
    if (!s.result.missing.length) continue;
    const r = await createIndexes(s.label, s.cfg, s.result.missing);
    built += r.built; failed += r.failed;
  }
  console.log(`\n[index] ${built} built, ${failed} failed.`);
  if (failed) console.log('  The migration will still run — the queries behind the failed indexes just stay slow.');
};

/* ==========================================================================
 * 5. PREFLIGHT
 * ========================================================================== */

const preflight = async (src, tgt) => {
  await src.sequelize.authenticate();
  await tgt.sequelize.authenticate();
  console.log(`[db] source = ${SRC_DB.database}@${SRC_DB.host}`);
  console.log(`[db] target = ${TGT_DB.database}@${TGT_DB.host}`);

  // the static target scope must point at rows that really exist
  const route = CONFIG.target;
  if (!route.orgId) throw new Error('CONFIG.target.orgId is required.');

  const [org] = await tgt.sequelize.query(
    'SELECT id, name FROM organizations WHERE id = :id',
    { replacements: { id: route.orgId }, type: Sequelize.QueryTypes.SELECT },
  );
  if (!org) {
    const sample = await tgt.sequelize.query(
      'SELECT id, name FROM organizations ORDER BY id LIMIT 20',
      { type: Sequelize.QueryTypes.SELECT },
    );
    throw new Error(
      `CONFIG.target.orgId = ${route.orgId} does not exist in ${TGT_DB.database}@${TGT_DB.host}.\n` +
      `        Organizations that DO exist there: ${sample.map((o) => `${o.id}:${o.name}`).join(', ') || '(none — wrong database?)'}`,
    );
  }

  const check = async (table, id, label) => {
    if (id == null) { console.warn(`[warn] CONFIG.target.${label} is null -> that column will be NULL.`); return '—'; }
    const [row] = await tgt.sequelize.query(
      `SELECT id FROM "${table}" WHERE id = :id`,
      { replacements: { id }, type: Sequelize.QueryTypes.SELECT },
    );
    if (!row) throw new Error(`CONFIG.target.${label} = ${id} does not exist in "${table}".`);
    return id;
  };
  const school = await check('schools', route.schoolId, 'schoolId');
  const program = await check('programs', route.programId, 'programId');
  const form = await check('applicationForms', route.formId, 'formId');

  console.log(`[target] org ${org.id} "${org.name}" | school ${school} | program ${program} | form ${form}`);

  if (!CONFIG.target.fallbackAdminUserId) console.warn('[warn] target.fallbackAdminUserId not set -> notes whose author cannot be mapped will be skipped (admin_id is NOT NULL).');

  /* Every column this script writes must actually exist. The receiving app applies
   * a global snake_case define to some tables and not others, so this is verified
   * against information_schema rather than assumed — a mismatch is reported here,
   * up front, instead of blowing up on the first lead. */
  const writeModels = {
    v2_leads: tgt.V2Lead, notes: tgt.Note, timelines: tgt.Timeline,
    ApplicationActivityTrackers: tgt.ActivityTracker, users: tgt.User,
    leadStage: tgt.LeadStage, leadSubStage: tgt.LeadSubStage,
    applicationStage: tgt.ApplicationStage, applicationSubStage: tgt.ApplicationSubStage,
    rounds: tgt.Round, batches: tgt.Batch,
    ...(CONFIG.skipTags ? {} : { tags: tgt.Tag, lead_tags: tgt.LeadTagLink }),
  };
  const schemaIssues = [];
  for (const [table, model] of Object.entries(writeModels)) {
    const cols = await probeColumns(tgt.sequelize, table);
    if (!cols.size) { schemaIssues.push(`  ${table}: TABLE NOT FOUND`); continue; }
    const missing = Object.values(model.rawAttributes)
      .map((a) => a.field || a.fieldName)
      .filter((f) => f && !cols.has(f));
    if (missing.length) schemaIssues.push(`  ${table}: missing column(s) ${missing.join(', ')}`);
  }
  if (schemaIssues.length) {
    throw new Error(
      `the receiving schema does not match what this script writes:\n${schemaIssues.join('\n')}\n` +
      '        Fix the matching model definition in section 3 of this script (usually a\n' +
      '        camelCase vs snake_case `field:` mapping) and re-run the dry run.',
    );
  }
  console.log(`[schema] all ${Object.keys(writeModels).length} target tables verified`);

  /* notes.lead_id and timelines.lead_id are FKs to the LEGACY `leads` table, so
   * they are NOT where a v2 lead id belongs — both tables have v2_lead_id for
   * that. They are left NULL. This only checks the constraint if someone turns
   * target.writeLegacyLeadId on. */
  const legacyLeadFk = async (table, column) => {
    const rows = await tgt.sequelize.query(
      `SELECT con.conname, rel.relname AS referenced_table, att.attname AS column_name
         FROM pg_constraint con
         JOIN pg_class child ON child.oid = con.conrelid
         JOIN pg_class rel   ON rel.oid   = con.confrelid
         JOIN unnest(con.conkey) AS k(attnum) ON true
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum
        WHERE con.contype = 'f' AND child.relname = :table`,
      { replacements: { table }, type: Sequelize.QueryTypes.SELECT },
    );
    return rows.find((r) => r.referenced_table === 'leads' && r.column_name === column) || null;
  };

  if (CONFIG.target.writeLegacyLeadId) {
    for (const [table, column] of [['notes', 'lead_id'], ['timelines', 'lead_id']]) {
      const fk = await legacyLeadFk(table, column);
      if (fk) {
        console.warn(`[warn] writeLegacyLeadId is on, but ${table} has FK "${fk.conname}" -> leads(id).`);
        console.warn(`        => every ${table} insert will FAIL. Set target.writeLegacyLeadId back to false.`);
      }
    }
  } else {
    console.log('[schema] notes.lead_id / timelines.lead_id left NULL — v2_lead_id is the link to v2_leads.');
  }

  return {};
};

/* ==========================================================================
 * 6. MIGRATION
 * ========================================================================== */

/**
 * Resolve everything this lead needs and build its v2_leads row — WITHOUT writing.
 * Split out from the write so a whole batch can be prepared first and then
 * inserted in one round-trip.
 */
const prepareLead = async ({ lead, notes, timelines, tracker, appManager, caches }) => {
  const route = CONFIG.target;   // static org / school / program / form
  const schoolId = caches.schoolFor(route);

  // Everything that needs a DB round-trip (and may CREATE a row in the receiving
  // DB) is resolved up-front, because applyMap itself is synchronous.
  const resolvedLeadStageId = await caches.resolveLeadStage(lead.leadStageId, route);
  const resolvedSubStageId = await caches.resolveLeadSubStage(lead.leadSubStageId, resolvedLeadStageId);
  const resolvedPrevStageId = await caches.resolveLeadStage(lead.previousLeadStage, route);
  const resolvedAppStageId = appManager ? await caches.resolveAppStage(appManager.applicationStageId, route) : null;
  const resolvedAppSubStageId = appManager ? await caches.resolveAppSubStage(appManager.applicationSubStageId, resolvedAppStageId) : null;
  const resolvedBatchId = await caches.resolveBatchId(lead.cohortId, route);          // v1 cohorts -> v2 batches
  const resolvedRoundId = await caches.resolveRoundId(lead.roundId, route, resolvedBatchId);

  const resolvedUserId = await caches.mapUserId(lead.userId);
  const resolvedCounsellorId = await caches.mapCounsellor(lead);                      // assignTo -> counsellor_id
  const resolvedReassignedBy = await caches.mapUserId(lead.reassignedBy);

  // manageLeads.tags is an array of NAMES -> receiving `tags` ids (created when
  // absent). The lead_tags join rows themselves are built after the insert, once
  // the new v2 lead id is known — see buildChildRows.
  const tagNames = CONFIG.skipTags ? [] : tagNamesOf(lead.tags);
  if (tagNames.length) stats.leadsWithTags += 1;
  stats.tagLinksFound += tagNames.length;
  const resolvedTagIds = await caches.resolveTagIds(tagNames);

  // note authors / timeline actors — one lookup per distinct source user id
  const childUserIds = new Map();
  for (const srcId of [...notes.map((n) => n.userId), ...timelines.map((t) => t.userId)]) {
    if (srcId && !childUserIds.has(srcId)) childUserIds.set(srcId, await caches.mapUserId(srcId));
  }
  // timeline stage ids — one lookup per distinct source stage id
  const childStageIds = new Map();
  for (const srcId of timelines.map((t) => t.leadStageId)) {
    if (srcId && !childStageIds.has(srcId)) childStageIds.set(srcId, await caches.resolveLeadStage(srcId, route));
  }

  const ctx = {
    route,
    schoolId,
    newLeadId: null, // filled after the lead row is created
    tracker,
    tagIds: resolvedTagIds,
    resolvers: {
      orgId: () => route.orgId,
      schoolId: () => schoolId,
      formId: () => route.formId,
      programId: () => route.programId,
      batchId: () => resolvedBatchId,
      roundId: () => resolvedRoundId,
      leadTableId: () => CONFIG.target.leadTableId,
      createdBy: () => CONFIG.target.migrationUserId,

      leadUserId: () => resolvedUserId,
      counsellorId: () => resolvedCounsellorId,
      reassignedBy: () => resolvedReassignedBy,

      leadStageId: () => resolvedLeadStageId,
      leadSubStageId: () => resolvedSubStageId,
      previousLeadStageId: () => resolvedPrevStageId,
      applicationStageId: () => resolvedAppStageId,
      applicationSubStageId: () => resolvedAppSubStageId,
      leadStageDate: () => tracker?.lastLeadStageUpdated ?? tracker?.firstLeadStageUpdated ?? null,

      widgetId: (row) => (row.widgetId ? CONFIG.target.widgetIdMap[row.widgetId] ?? null : null),

      leadPayload: (row) => {
        let base = row.leadPayload;
        if (typeof base === 'string') { try { base = JSON.parse(base); } catch { base = { raw: base }; } }
        if (!base || typeof base !== 'object' || Array.isArray(base)) base = base ? { raw: base } : {};
        if (!CONFIG.stashUnmapped) return base;
        const legacy = {};
        for (const f of UNMAPPED_LEAD_FIELDS) {
          if (row[f] !== null && row[f] !== undefined && row[f] !== '') legacy[f] = row[f];
        }
        legacy.v1LeadId = row.id;
        legacy.v1OrganizationId = row.organizationId;
        legacy.v1SchoolId = row.schoolId;
        legacy.v1ApplicationFormId = row.applicationFormId;
        legacy.v1LeadStageId = row.leadStageId;
        legacy.v1LeadSubStageId = row.leadSubStageId;
        legacy.migratedAt = new Date().toISOString();
        return { ...base, __legacy: legacy };
      },

      // notes / timelines
      newLeadId: (_row, c) => c.newLeadId,
      // notes.lead_id / timelines.lead_id belong to the LEGACY `leads` table.
      // The v2 link is v2_lead_id, so these stay NULL.
      legacyLeadId: (_row, c) => (CONFIG.target.writeLegacyLeadId ? c.newLeadId : null),
      noteAdminId: (row) => childUserIds.get(row.userId) ?? CONFIG.target.fallbackAdminUserId ?? null,

      timelineUserId: (row) => childUserIds.get(row.userId) ?? null,
      timelineEventType: (row) => timelineTitleOf(row) || 'activity',   // column is NOT NULL
      timelineTitle: (row) => timelineTitleOf(row),
      timelineMetadata: (row) => {
        const evt = parseJson(row.eventType);
        return {
          ...parseJson(row.payload),
          icon: evt?.icon ?? null,
          date: row.date ?? null,
          time: row.time ?? null,
          leadStageId: childStageIds.get(row.leadStageId) ?? null,   // resolved v2 stage
          __legacy: {
            v1TimelineId: row.id,          // <- the re-run dedup key
            v1LeadId: row.leadId,
            v1UserId: row.userId ?? null,
            v1LeadStageId: row.leadStageId ?? null,
            v1TemplateId: row.templateId ?? null,
            v1EventType: evt ?? row.eventType ?? null,
          },
        };
      },
    },
  };

  // build the v2_leads row now; the children are mapped later, once the insert
  // has handed back the new lead id (ctx.newLeadId)
  const leadRow = applyMap(LEAD_FIELD_MAP, lead, ctx);

  return { ctx, leadRow };
};

/**
 * Turn one prepared lead's children into insert-ready rows, now that the v2 lead
 * id is known. `isNew` leads cannot have children yet, so the dedup sets are only
 * consulted for leads that already existed.
 */
const buildChildRows = (p, leadId, isNew, sets) => {
  p.ctx.newLeadId = leadId;
  const out = { notes: [], timelines: [], tags: [], tracker: null, trackerExists: false };

  for (const n of p.notes) {
    if (!isNew && sets.notes?.has(`${leadId}:${n.id}`)) { stats.notesAlready += 1; continue; }
    const row = applyMap(NOTE_FIELD_MAP, n, p.ctx);
    if (!row.adminId) { stats.notesWithoutAdmin += 1; continue; }   // admin_id is NOT NULL
    out.notes.push(row);
  }
  for (const tl of p.timelines) {
    if (!isNew && sets.timelines?.has(`${leadId}:${tl.id}`)) { stats.timelinesAlready += 1; continue; }
    out.timelines.push(applyMap(TIMELINE_FIELD_MAP, tl, p.ctx));
  }
  for (const tagId of p.ctx.tagIds || []) {
    if (!isNew && sets.tags?.has(`${leadId}:${tagId}`)) { stats.tagLinksAlready += 1; continue; }
    out.tags.push(tagLinkRow(leadId, tagId, p.lead.id, p.ctx));
  }
  if (p.tracker) {
    out.tracker = applyMap(TRACKER_FIELD_MAP, p.tracker, p.ctx);
    out.trackerExists = !isNew && Boolean(sets.trackers?.has(leadId));
  }
  return out;
};

/**
 * Write a whole prepared batch.
 *
 * FAST PATH — all brand-new leads go in as ONE bulk INSERT, then all of their
 * notes / timelines / trackers as one bulk INSERT each, inside a single
 * transaction. That is ~5 round-trips per BATCH instead of ~6 per LEAD, which is
 * the difference between hours and minutes over a WAN link to RDS.
 *
 * If that transaction fails, the batch is retried lead-by-lead so one bad row
 * cannot cost the other 499.
 */
const writeBatch = async ({ tgt, prepared, existingByV1Id, sets, oneByOne = false }) => {
  let fresh = prepared.filter((p) => !existingByV1Id.has(p.lead.id));
  const already = prepared.filter((p) => existingByV1Id.has(p.lead.id));

  /* Re-check before a RETRY.
   * A dropped connection can lose the acknowledgement of a COMMIT that Postgres
   * actually applied: the client sees an error and rolls back (a no-op, the work
   * is already committed). Re-inserting blindly at that point duplicates every
   * lead in the batch. So the retry path asks the DB what really landed. */
  if (oneByOne && fresh.length) {
    const landed = await tgt.V2Lead.findAll({
      where: { orgId: CONFIG.target.orgId, v1LeadId: { [Op.in]: fresh.map((p) => p.lead.id) } },
      attributes: ['id', 'v1LeadId'], raw: true,
    });
    if (landed.length) {
      for (const r of landed) existingByV1Id.set(r.v1LeadId, r.id);
      ui.log(`  i ${landed.length} of those leads were already committed — not re-inserting them`);
      already.push(...fresh.filter((p) => existingByV1Id.has(p.lead.id)));
      fresh = fresh.filter((p) => !existingByV1Id.has(p.lead.id));
    }
  }

  /* ---- brand-new leads ------------------------------------------------ */
  if (fresh.length) {
    const groups = oneByOne ? fresh.map((p) => [p]) : [fresh];
    for (const group of groups) {
      const t = await tgt.sequelize.transaction();
      try {
        const createdLeads = await bulkInsert(tgt.V2Lead, group.map((p) => p.leadRow), t, { returning: true });
        // pair by v1_lead_id rather than trusting row order
        const idByV1 = new Map(createdLeads.map((r) => [r.v1LeadId, r.id]));

        const allNotes = [], allTimelines = [], allTrackers = [], allTags = [];
        for (const p of group) {
          const leadId = idByV1.get(p.lead.id);
          if (!leadId) throw new Error(`no id returned for v1 lead ${p.lead.id}`);
          const child = buildChildRows(p, leadId, true, sets);
          allNotes.push(...child.notes);
          allTimelines.push(...child.timelines);
          allTags.push(...child.tags);
          if (child.tracker) allTrackers.push(child.tracker);
        }

        await bulkInsert(tgt.Note, allNotes, t);
        await bulkInsert(tgt.Timeline, allTimelines, t);
        await bulkInsert(tgt.ActivityTracker, allTrackers, t);
        // ON CONFLICT DO NOTHING against the (v2_lead_id, tag_id) unique index —
        // a lead can carry the same name twice under different casing, and a
        // re-run must never abort the whole batch over an existing link
        await bulkInsert(tgt.LeadTagLink, allTags, t, { ignoreDuplicates: true });

        await t.commit();
        stats.migrated += group.length;
        stats.notes += allNotes.length;
        stats.timelines += allTimelines.length;
        stats.trackers += allTrackers.length;
        stats.tagLinks += allTags.length;
      } catch (err) {
        await t.rollback();
        if (!oneByOne) {
          // isolate the offender instead of losing the whole batch
          ui.log(`  ! batch insert failed (${err.message}) — retrying ${group.length} leads individually`);
          await writeBatch({ tgt, prepared: group, existingByV1Id, sets, oneByOne: true });
        } else {
          const p = group[0];
          stats.failed += 1;
          stats.errors.push({ v1LeadId: p.lead.id, email: p.lead.registeredEmail, stage: 'write', error: err.message });
          ui.log(`  ✗ lead ${p.lead.id} (${p.lead.registeredEmail}): ${err.message}`);
        }
      }
    }
  }

  /* ---- leads already migrated: backfill their children ---------------- */
  for (const p of already) {
    const leadId = existingByV1Id.get(p.lead.id);
    const t = await tgt.sequelize.transaction();
    try {
      if (CONFIG.updateExisting) {
        await tgt.V2Lead.update(p.leadRow, { where: { id: leadId }, transaction: t });
        stats.updated += 1;
      } else {
        // Lead row untouched, but its notes / timelines / tracker may still be
        // missing from an earlier partial run — each dedups on its own key.
        stats.skippedExisting += 1;
      }
      const child = buildChildRows(p, leadId, false, sets);
      if (child.notes.length) { await bulkInsert(tgt.Note, child.notes, t); stats.notes += child.notes.length; }
      if (child.timelines.length) { await bulkInsert(tgt.Timeline, child.timelines, t); stats.timelines += child.timelines.length; }
      if (child.tags.length) { await bulkInsert(tgt.LeadTagLink, child.tags, t, { ignoreDuplicates: true }); stats.tagLinks += child.tags.length; }
      if (child.tracker) {
        if (child.trackerExists) await tgt.ActivityTracker.update(child.tracker, { where: { leadId }, transaction: t });
        else await tgt.ActivityTracker.create(child.tracker, { transaction: t });
        stats.trackers += 1;
      }
      await t.commit();
    } catch (err) {
      await t.rollback();
      stats.failed += 1;
      stats.errors.push({ v1LeadId: p.lead.id, email: p.lead.registeredEmail, stage: 'write', error: err.message });
      ui.log(`  ✗ lead ${p.lead.id} (${p.lead.registeredEmail}): ${err.message}`);
    }
  }
};

/* ==========================================================================
 * 6b. VERIFY  (--verify)
 * --------------------------------------------------------------------------
 * Answers "the target has N leads but I can only find M of them in the source".
 * Reads every migrated row out of v2_leads, then looks its v1_lead_id up in
 * manageLeads with NO filter at all, and classifies the misses:
 *
 *   - gone            : the source row no longer exists (hard-deleted)
 *   - filter-drifted  : the row IS there, but no longer matches the migration
 *                       filter (e.g. userType flipped lead -> applicant), so a
 *                       re-run of the migration WHERE clause would not find it
 *   - present         : still matches; any shortfall is on the query side
 *
 * It also counts DISTINCT emails on both sides, because a lookup done by email
 * collapses duplicates and will under-report all by itself.
 * ======================================================================== */
const verifyGap = async (src, tgt) => {
  const F = CONFIG.source;
  console.log(`\n[verify] target v2_leads WHERE org_id=${CONFIG.target.orgId}`);

  const targetRows = await tgt.V2Lead.findAll({
    where: { orgId: CONFIG.target.orgId },
    attributes: ['id', 'v1LeadId', 'registeredEmail', 'createdAt'],
    raw: true,
  });

  const withV1 = targetRows.filter((r) => r.v1LeadId != null);
  const v1Ids = withV1.map((r) => r.v1LeadId);
  const distinctV1 = new Set(v1Ids);
  const tgtEmails = new Set(targetRows.map((r) => norm(r.registeredEmail)).filter(Boolean));

  console.log(`  rows in target            : ${targetRows.length}`);
  console.log(`  with v1_lead_id           : ${withV1.length}   (${targetRows.length - withV1.length} NULL — not from this script)`);
  console.log(`  DISTINCT v1_lead_id       : ${distinctV1.size}${distinctV1.size !== withV1.length ? `   <-- ${withV1.length - distinctV1.size} DUPLICATE rows` : ''}`);
  console.log(`  DISTINCT registered_email : ${tgtEmails.size}${tgtEmails.size !== targetRows.length ? `   <-- ${targetRows.length - tgtEmails.size} rows share an email with another row` : ''}`);

  // when were they written? rows created before this migration are not ours
  const byDay = new Map();
  for (const r of targetRows) {
    const d = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 13) : 'null';
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  console.log('  created_at (UTC hour)     :');
  for (const [h, n] of [...byDay.entries()].sort()) console.log(`      ${h}:00  ${n}`);

  if (!distinctV1.size) { console.log('\n  nothing carries a v1_lead_id — stopping.'); return; }

  /* ---- look every id up in the SOURCE with no filter ------------------- */
  const ids = [...distinctV1];
  const srcRows = [];
  for (let i = 0; i < ids.length; i += 2000) {
    const part = await src.ManageLead.findAll({
      where: { id: { [Op.in]: ids.slice(i, i + 2000) } },
      attributes: ['id', 'registeredEmail', 'organizationId', 'applicationFormId',
        'programId', 'isLeadDeleted', 'userType'],
      raw: true,
    });
    srcRows.push(...part);
  }
  const srcById = new Map(srcRows.map((r) => [r.id, r]));

  const gone = [];
  const drifted = [];
  const driftReasons = new Map();
  const emailMismatch = [];

  for (const t of withV1) {
    const s = srcById.get(t.v1LeadId);
    if (!s) { gone.push(t.v1LeadId); continue; }

    const why = [];
    if (s.organizationId !== F.organizationId) why.push(`organizationId=${s.organizationId}`);
    if (s.applicationFormId !== F.applicationFormId) why.push(`applicationFormId=${s.applicationFormId}`);
    if (s.programId !== F.programId) why.push(`programId=${s.programId}`);
    if (asBool(s.isLeadDeleted, false) !== F.isLeadDeleted) why.push(`isLeadDeleted=${s.isLeadDeleted}`);
    if (s.userType !== F.userType) why.push(`userType='${s.userType}'`);
    if (why.length) {
      drifted.push(t.v1LeadId);
      bump(driftReasons, why.join(' + '));
    }
    if (norm(t.registeredEmail) && norm(s.registeredEmail) && norm(t.registeredEmail) !== norm(s.registeredEmail)) {
      emailMismatch.push(`${t.v1LeadId}: target "${t.registeredEmail}" vs source "${s.registeredEmail}"`);
    }
  }

  const srcEmails = new Set(srcRows.map((r) => norm(r.registeredEmail)).filter(Boolean));

  console.log(`\n[verify] those ${ids.length} ids looked up in source manageLeads (NO filter):`);
  console.log(`  found in source           : ${srcRows.length}`);
  console.log(`  NOT in source at all      : ${gone.length}`);
  console.log(`  found but filter-drifted  : ${drifted.length}   <-- a filtered re-query would MISS these`);
  console.log(`  still matching the filter : ${srcRows.length - drifted.length}`);
  console.log(`  DISTINCT source emails    : ${srcEmails.size} across ${srcRows.length} rows`
    + `${srcEmails.size !== srcRows.length ? `   <-- an email lookup can only ever return ${srcEmails.size}` : ''}`);
  console.log(`  email differs src vs tgt  : ${emailMismatch.length}`);

  if (driftReasons.size) {
    console.log('\n  why they drifted out of the filter:');
    for (const [k, n] of [...driftReasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`      ${n.toString().padStart(6)}  ${k}`);
  }
  if (gone.length) console.log(`\n  ids missing from source (first 25): ${gone.slice(0, 25).join(', ')}`);
  if (emailMismatch.length) console.log(`\n  email mismatches (first 10):\n      ${emailMismatch.slice(0, 10).join('\n      ')}`);

  console.log('\n[verify] verdict:');
  if (gone.length) {
    console.log(`  ${gone.length} target rows point at manageLeads ids that DO NOT EXIST. Either those rows`);
    console.log('  were deleted from the source after migration, or they were not written by this');
    console.log('  script (something else populates v1_lead_id in the receiving DB).');
  }
  if (drifted.length) {
    console.log(`  ${drifted.length} rows are still in the source but no longer match the migration filter.`);
    console.log('  Re-running the filtered WHERE clause under-reports by exactly this many.');
  }
  if (srcEmails.size < srcRows.length) {
    console.log(`  ${srcRows.length - srcEmails.size} source leads share an email with another lead — a lookup keyed on`);
    console.log(`  email collapses them and can return at most ${srcEmails.size} distinct rows.`);
  }
  if (!gone.length && !drifted.length && srcEmails.size === srcRows.length) {
    console.log('  every target row maps to a live, still-matching, uniquely-emailed source lead.');
    console.log('  The shortfall is in how the lookup query was run (truncated IN list, extra');
    console.log('  WHERE conditions, or a row-limit in the SQL client) — not in the data.');
  }
  console.log('');
};

/**
 * Where should this run pick up? Returns a manageLeads.id to start AFTER
 * (0 = from the beginning). Leads are always walked id-ASC, so one number is
 * enough to express "carry on from where the last run died".
 *
 * --after-id wins over --resume wins over --skip; they are alternatives, not
 * a combination.
 */
const resolveStartId = async (src, tgt, where) => {
  if (CONFIG.afterId) {
    console.log(`[resume] --after-id=${CONFIG.afterId}`);
    return CONFIG.afterId;
  }

  if (CONFIG.resume) {
    // The high-water mark of what is already in the receiving DB FOR THIS
    // TARGET SCOPE. Scoping by form/program matters: org 12 also holds ~424k
    // v1_lead_id values from earlier, unrelated migrations, and the max across
    // all of them would skip most of this run's work.
    const row = await tgt.V2Lead.findOne({
      where: {
        orgId: CONFIG.target.orgId,
        schoolId: CONFIG.target.schoolId,
        programId: CONFIG.target.programId,
        formId: CONFIG.target.formId,
        v1LeadId: { [Op.ne]: null },
      },
      attributes: ['v1LeadId'],
      order: [['v1LeadId', 'DESC']],
      raw: true,
    });
    if (!row) {
      console.log('[resume] nothing migrated into this target scope yet — starting from the beginning.');
      return 0;
    }
    console.log(`[resume] highest v1_lead_id already in v2_leads (org ${CONFIG.target.orgId}`
      + ` / school ${CONFIG.target.schoolId} / program ${CONFIG.target.programId} / form ${CONFIG.target.formId})`
      + ` = ${row.v1LeadId}`);
    return row.v1LeadId;
  }

  if (CONFIG.skip) {
    // One OFFSET query to turn a count into an id, then keyset pagination from
    // there. OFFSET is slow, but it runs exactly once instead of per batch.
    const row = await src.ManageLead.findOne({
      where, attributes: ['id'], order: [['id', 'ASC']], offset: CONFIG.skip - 1, raw: true,
    });
    if (!row) {
      console.log(`[resume] --skip=${CONFIG.skip} is past the end of the result set — nothing left to do.`);
      return Number.MAX_SAFE_INTEGER;
    }
    console.log(`[resume] --skip=${CONFIG.skip} -> manageLeads.id ${row.id} is lead #${CONFIG.skip}; starting after it`);
    return row.id;
  }

  return 0;
};

/* ==========================================================================
 * 6c. TAGS-ONLY  (--tags-only)
 * --------------------------------------------------------------------------
 * A backfill pass for a migration that is otherwise finished: everything else
 * is already in the receiving DB and only the tags are outstanding.
 *
 * It walks the SAME source filter as a normal run, but:
 *   - the source SELECT keeps only rows that actually carry a tag, so a scope
 *     of 80k leads with 650 tagged ones reads 650 of them
 *   - it reads NO child tables (no notes, no timelines, no tracker) and
 *     resolves NO stages / users / rounds / batches
 *   - it never writes to v2_leads. A lead that has not been migrated yet is
 *     counted and skipped, not created — run the normal migration for those
 *     first, then come back here.
 *
 * Re-running is free: every link dedups on (v2_lead_id, tag_id), both in the
 * pre-read below and via ON CONFLICT DO NOTHING on the insert itself.
 * ========================================================================== */
const runTagsOnly = async (src, tgt) => {
  const route = CONFIG.target;
  // no autoSchoolIdByOrg pass here (that lives in buildCaches, which this mode
  // deliberately skips) — an unset target.schoolId simply leaves school_id NULL
  const schoolId = route.schoolId ?? null;
  const ctx = { route, schoolId };

  const tagCache = await buildTagCache(src, tgt);

  /* Only the tagged rows. There is no index on manageLeads.tags, but the scan
   * index still serves the org/form/program/id part of the WHERE — this just
   * stops 79k untagged leads from crossing the wire and being dedup-looked-up. */
  const where = {
    organizationId: CONFIG.source.organizationId,
    applicationFormId: CONFIG.source.applicationFormId,
    programId: CONFIG.source.programId,
    isLeadDeleted: CONFIG.source.isLeadDeleted,
    userType: CONFIG.source.userType,
    [Op.and]: [Sequelize.literal('"tags" IS NOT NULL AND array_length("tags", 1) > 0')],
  };
  if (CONFIG.leadIds.length) where.id = { [Op.in]: CONFIG.leadIds };

  const total = await src.ManageLead.count({ where });
  console.log(`\n[scan] TAGS ONLY — manageLeads in scope WITH at least one tag -> ${total}`);
  console.log(`[mode] ${CONFIG.commit ? 'COMMIT' : 'DRY RUN (no writes) — add --commit to apply'}`);
  if (CONFIG.resume || CONFIG.skip) {
    console.log('[note] --resume / --skip are ignored in --tags-only: the whole point of this mode is to');
    console.log('       revisit leads that are ALREADY in v2_leads. Use --after-id=N to restart a long run.');
  }
  if (CONFIG.afterId) console.log(`[resume] --after-id=${CONFIG.afterId}`);
  console.log('');

  let lastId = CONFIG.afterId || 0;
  let processed = 0;
  stats.startedAfterId = lastId;
  ui.start(CONFIG.limit ? Math.min(CONFIG.limit, total) : total);

  for (;;) {
    const idClause = where.id
      ? { [Op.and]: [where.id, { [Op.gt]: lastId }] }
      : { [Op.gt]: lastId };

    const tFetch = Date.now();
    const leads = await src.ManageLead.findAll({
      where: { ...where, id: idClause },
      attributes: ['id', 'tags', 'registeredEmail'],
      order: [['id', 'ASC']],
      limit: CONFIG.batchSize,
      raw: true,
    });
    stats.msSourceFetch += Date.now() - tFetch;
    if (!leads.length) break;

    const slice = CONFIG.limit ? leads.slice(0, Math.max(0, CONFIG.limit - processed)) : leads;
    if (!slice.length) break;
    stats.scanned += slice.length;

    /* ---- which of them are in v2_leads, and what is already linked ------
     * Both reads happen in a dry run too — without them the report could not
     * say how many leads are missing or how many links already exist. */
    const tDedup = Date.now();
    const existingRows = await tgt.V2Lead.findAll({
      where: { orgId: route.orgId, v1LeadId: { [Op.in]: slice.map((l) => l.id) } },
      attributes: ['id', 'v1LeadId'], raw: true,
    });
    const v2IdByV1 = new Map(existingRows.map((r) => [r.v1LeadId, r.id]));

    const existingTagKeys = new Set();
    if (existingRows.length) {
      const linked = await tgt.sequelize.query(
        'SELECT v2_lead_id, tag_id FROM lead_tags WHERE v2_lead_id IN (:ids)',
        { replacements: { ids: existingRows.map((r) => r.id) }, type: Sequelize.QueryTypes.SELECT },
      );
      for (const r of linked) existingTagKeys.add(`${r.v2_lead_id}:${r.tag_id}`);
    }
    stats.msDedupFetch += Date.now() - tDedup;

    /* ---- build the links ------------------------------------------------ */
    const tPrep = Date.now();
    const rows = [];
    for (const lead of slice) {
      const names = tagNamesOf(lead.tags);
      stats.leadsWithTags += 1;
      stats.tagLinksFound += names.length;

      const v2LeadId = v2IdByV1.get(lead.id);
      if (!v2LeadId) {
        // not migrated yet (or migrated into a different org) — this mode never creates leads
        stats.tagLeadsNotMigrated += 1;
        if (stats.tagLeadMissingSample.length < 25) stats.tagLeadMissingSample.push(lead.id);
        ui.tick();
        continue;
      }

      for (const tagId of await tagCache.resolveTagIds(names)) {
        if (existingTagKeys.has(`${v2LeadId}:${tagId}`)) { stats.tagLinksAlready += 1; continue; }
        existingTagKeys.add(`${v2LeadId}:${tagId}`);   // guard against a repeat inside this batch
        rows.push(tagLinkRow(v2LeadId, tagId, lead.id, ctx));
      }
      ui.tick();
    }
    stats.msPrepare += Date.now() - tPrep;

    /* ---- write ---------------------------------------------------------- */
    const tWrite = Date.now();
    if (CONFIG.commit && rows.length) {
      const t = await tgt.sequelize.transaction();
      try {
        await bulkInsert(tgt.LeadTagLink, rows, t, { ignoreDuplicates: true });
        await t.commit();
        stats.tagLinks += rows.length;
      } catch (err) {
        await t.rollback();
        // one bad link (a tag or lead deleted underneath us) must not cost the batch
        ui.log(`  ! tag batch insert failed (${err.message}) — retrying ${rows.length} links individually`);
        for (const row of rows) {
          try {
            await tgt.LeadTagLink.create(row, { ignoreDuplicates: true });
            stats.tagLinks += 1;
          } catch (e) {
            stats.failed += 1;
            stats.errors.push({ v1LeadId: row.v1LeadId, stage: 'tag-write', error: e.message });
            ui.log(`  ✗ lead ${row.v1LeadId} tag ${row.tagId}: ${e.message}`);
          }
        }
      }
    } else if (!CONFIG.commit) {
      stats.tagLinks += rows.length;   // "would write"
    }
    stats.msWrite += Date.now() - tWrite;

    processed += slice.length;
    lastId = slice[slice.length - 1].id;
    stats.lastIdProcessed = lastId;
    if (CONFIG.limit && processed >= CONFIG.limit) break;
    if (stats.failed >= CONFIG.maxFailures) {
      ui.log(`[abort] ${stats.failed} tag links failed (--max-failures=${CONFIG.maxFailures}).`);
      break;
    }
  }

  ui.stop();
};

const run = async () => {
  if (CONFIG.tagsOnly && CONFIG.skipTags) {
    throw new Error('--tags-only and --skip-tags cancel each other out — pick one.');
  }
  // credentials must actually be filled in
  for (const [label, cfg] of [['SRC_DB (FROM)', SRC_DB], ['TGT_DB (TO)', TGT_DB]]) {
    const blank = ['host', 'database', 'username', 'password']
      .filter((k) => !cfg[k] || String(cfg[k]).startsWith('PASTE_'));
    if (blank.length) throw new Error(`${label}: fill in ${blank.join(', ')} at the top of this script.`);
  }

  const src = await buildSource(SRC_DB);
  const tgt = await buildTarget(TGT_DB);
  tgtV1IdColumn = tgt.v1IdColumn;

  if (CONFIG.verify) {
    await verifyGap(src, tgt);
    await src.sequelize.close();
    await tgt.sequelize.close();
    return;
  }

  const flags = await preflight(src, tgt);

  // Do this BEFORE any of the heavy reading starts — every batch below runs the
  // same queries, so an index built here pays for itself within the first few.
  await indexStep(src, tgt);
  if (CONFIG.indexesOnly) {
    console.log(`\n[index] ${CONFIG.ensureIndexes ? '--indexes-only' : '--check-indexes'}: stopping here.`
      + ' Re-run without it to migrate.\n');
    await src.sequelize.close();
    await tgt.sequelize.close();
    return;
  }

  /* --tags-only short-circuits the whole migration: no caches, no child reads,
   * no lead writes. See section 6c. */
  if (CONFIG.tagsOnly) {
    await runTagsOnly(src, tgt);
    report();
    await src.sequelize.close();
    await tgt.sequelize.close();
    return;
  }

  const caches = await buildCaches(src, tgt);

  const where = {
    organizationId: CONFIG.source.organizationId,
    applicationFormId: CONFIG.source.applicationFormId,
    programId: CONFIG.source.programId,
    isLeadDeleted: CONFIG.source.isLeadDeleted,
    userType: CONFIG.source.userType,
  };
  if (CONFIG.leadIds.length) where.id = { [Op.in]: CONFIG.leadIds };

  const total = await src.ManageLead.count({ where });
  console.log(`\n[scan] manageLeads WHERE organizationId=${CONFIG.source.organizationId} AND applicationFormId=${CONFIG.source.applicationFormId} AND programId=${CONFIG.source.programId} AND isLeadDeleted=${CONFIG.source.isLeadDeleted} AND userType='${CONFIG.source.userType}' -> ${total}`);

  const startAfterId = await resolveStartId(src, tgt, where);
  let remaining = total;
  if (startAfterId > 0) {
    remaining = await src.ManageLead.count({
      where: { ...where, id: where.id ? { [Op.and]: [where.id, { [Op.gt]: startAfterId }] } : { [Op.gt]: startAfterId } },
    });
    console.log(`[resume] starting AFTER manageLeads.id = ${startAfterId}`
      + `  ->  ${remaining} of ${total} leads left (${total - remaining} already behind the cursor)`);
  }

  console.log(`[mode] ${CONFIG.commit ? 'COMMIT' : 'DRY RUN (no writes) — add --commit to apply'}`);
  console.log(`[perf] batch=${CONFIG.batchSize} concurrency=${CONFIG.concurrency} pipelined-fetch=on`
    + `${CONFIG.skipTimelines ? ' | TIMELINES SKIPPED' : ''}`
    + `${CONFIG.skipTags ? ' | TAGS SKIPPED' : ''}`
    + `${!CONFIG.skipTimelines ? ` | ${timelineWindowLabel()}` : ''}\n`);

  let lastId = startAfterId;
  let processed = 0;
  stats.startedAfterId = startAfterId;
  ui.start(CONFIG.limit ? Math.min(CONFIG.limit, remaining) : remaining);

  /**
   * Read one batch of leads plus all of their children from the SOURCE.
   * Kept as a function so the next batch can be fetched WHILE the current one is
   * being written — source reads and target writes then overlap instead of
   * queueing behind each other (they hit two different databases).
   */
  const fetchBatch = async (afterId) => {
    const batchWhere = { ...where, id: where.id ? where.id : { [Op.gt]: afterId } };
    if (where.id) batchWhere.id = { [Op.and]: [where.id, { [Op.gt]: afterId }] };

    const tFetch = Date.now();
    const leads = await src.ManageLead.findAll({
      where: batchWhere, order: [['id', 'ASC']], limit: CONFIG.batchSize, raw: true,
    });
    if (!leads.length) { stats.msSourceFetch += Date.now() - tFetch; return null; }

    const leadIds = leads.map((l) => l.id);
    const amIds = leads.map((l) => l.applicationManagerId).filter(Boolean);

    // No ORDER BY on the child reads: sorting tens of thousands of rows costs
    // real time and nothing downstream depends on the order.
    const timelineWhere = { leadId: { [Op.in]: leadIds } };
    if (CONFIG.timelinesSince) timelineWhere.createdAt = { [Op.gte]: CONFIG.timelinesSince };

    const [notes, timelines, trackers, appManagers] = await Promise.all([
      src.Notes.findAll({ where: { leadId: { [Op.in]: leadIds } }, raw: true }),
      CONFIG.skipTimelines ? [] : src.UserTimeline.findAll({ where: timelineWhere, raw: true }),
      src.ActivityTracker.findAll({ where: { leadId: { [Op.in]: leadIds } }, raw: true }),
      amIds.length ? src.ApplicationManager.findAll({ where: { id: { [Op.in]: amIds } }, raw: true }) : Promise.resolve([]),
    ]);
    stats.msSourceFetch += Date.now() - tFetch;

    const group = (rows, key) => rows.reduce((m, r) => { (m[r[key]] ||= []).push(r); return m; }, {});
    return {
      leads,
      leadIds,
      notesByLead: group(notes, 'leadId'),
      timelinesByLead: group(timelines, 'leadId'),
      trackerByLead: new Map(trackers.map((t) => [t.leadId, t])),
      amById: new Map(appManagers.map((a) => [a.id, a])),
      lastId: leads[leads.length - 1].id,
    };
  };

  // A prefetch that rejects while we are busy writing must not surface as an
  // unhandled rejection — attach a no-op handler now; `await` still throws later.
  const prefetch = (afterId) => { const p = fetchBatch(afterId); p.catch(() => {}); return p; };

  let inflight = prefetch(lastId);   // prime the pipeline

  for (;;) {
    const batch = await inflight;
    if (!batch) break;
    const { leads, leadIds, notesByLead, timelinesByLead, trackerByLead, amById } = batch;

    // kick off the NEXT read now, so it runs while this batch is written
    const moreWanted = !(CONFIG.limit && processed + leads.length >= CONFIG.limit);
    inflight = moreWanted ? prefetch(batch.lastId) : Promise.resolve(null);

    /* ---- ONE round-trip per batch instead of ~4 per lead --------------
     * Which of these leads is already in the receiving DB, and which of their
     * children are already written. A brand-new lead needs no dedup check at
     * all, so the common first-run path does zero extra SELECTs. */
    let existingByV1Id = new Map();
    const existingNoteKeys = new Set();
    const existingTimelineKeys = new Set();
    const existingTrackerLeadIds = new Set();
    const existingTagKeys = new Set();

    const tDedup = Date.now();
    if (CONFIG.commit) {
      const existingRows = await tgt.V2Lead.findAll({
        where: { orgId: CONFIG.target.orgId, v1LeadId: { [Op.in]: leadIds } },
        attributes: ['id', 'v1LeadId'], raw: true,
      });
      existingByV1Id = new Map(existingRows.map((r) => [r.v1LeadId, r.id]));

      const existingIds = existingRows.map((r) => r.id);
      if (existingIds.length) {
        const [noteRows, tlRows, trkRows, tagRows] = await Promise.all([
          tgt.sequelize.query(
            'SELECT v2_lead_id, temp_id FROM notes WHERE v2_lead_id IN (:ids) AND temp_id IS NOT NULL',
            { replacements: { ids: existingIds }, type: Sequelize.QueryTypes.SELECT },
          ),
          tgt.sequelize.query(
            `SELECT v2_lead_id, (metadata -> '__legacy' ->> 'v1TimelineId') AS v1id
               FROM timelines WHERE v2_lead_id IN (:ids)`,
            { replacements: { ids: existingIds }, type: Sequelize.QueryTypes.SELECT },
          ),
          tgt.sequelize.query(
            'SELECT "leadId" FROM "ApplicationActivityTrackers" WHERE "leadId" IN (:ids)',
            { replacements: { ids: existingIds }, type: Sequelize.QueryTypes.SELECT },
          ),
          CONFIG.skipTags ? Promise.resolve([]) : tgt.sequelize.query(
            'SELECT v2_lead_id, tag_id FROM lead_tags WHERE v2_lead_id IN (:ids)',
            { replacements: { ids: existingIds }, type: Sequelize.QueryTypes.SELECT },
          ),
        ]);
        for (const r of noteRows) existingNoteKeys.add(`${r.v2_lead_id}:${r.temp_id}`);
        for (const r of tlRows) if (r.v1id) existingTimelineKeys.add(`${r.v2_lead_id}:${r.v1id}`);
        for (const r of trkRows) existingTrackerLeadIds.add(r.leadId);
        for (const r of tagRows) existingTagKeys.add(`${r.v2_lead_id}:${r.tag_id}`);
      }
    }

    stats.msDedupFetch += Date.now() - tDedup;

    const slice = CONFIG.limit ? leads.slice(0, Math.max(0, CONFIG.limit - processed)) : leads;
    stats.scanned += slice.length;

    /* ---- 1. PREPARE (resolve + map) — parallel, almost all cache hits ---- */
    const tPrep = Date.now();
    const prepared = [];
    await pool(slice, CONFIG.concurrency, async (lead) => {
      const item = {
        lead,
        notes: notesByLead[lead.id] || [],
        timelines: timelinesByLead[lead.id] || [],
        tracker: trackerByLead.get(lead.id) || null,
        appManager: lead.applicationManagerId ? amById.get(lead.applicationManagerId) || null : null,
      };
      stats.notesFound += item.notes.length;
      stats.timelinesFound += item.timelines.length;
      stats.trackersFound += item.tracker ? 1 : 0;
      try {
        const { ctx, leadRow } = await prepareLead({ ...item, caches });
        prepared.push({ ...item, ctx, leadRow });
      } catch (err) {
        stats.failed += 1;
        stats.errors.push({ v1LeadId: lead.id, email: lead.registeredEmail, stage: 'resolve', error: err.message });
        ui.log(`  ✗ lead ${lead.id} (${lead.registeredEmail}) [resolve]: ${err.message}`);
      }
      ui.tick();
    });

    stats.msPrepare += Date.now() - tPrep;

    /* ---- 2. WRITE — one bulk INSERT per table for the whole batch -------- */
    const tWrite = Date.now();
    if (CONFIG.commit) {
      await writeBatch({
        tgt, prepared, existingByV1Id,
        sets: { notes: existingNoteKeys, timelines: existingTimelineKeys, trackers: existingTrackerLeadIds, tags: existingTagKeys },
      });
    } else {
      for (const p of prepared) {
        stats.migrated += 1;
        stats.notes += p.notes.length;
        stats.timelines += p.timelines.length;
        stats.trackers += p.tracker ? 1 : 0;
        stats.tagLinks += (p.ctx.tagIds || []).length;
        if (CONFIG.verbose) console.log(JSON.stringify(p.leadRow, null, 2));
      }
    }
    stats.msWrite += Date.now() - tWrite;
    processed += slice.length;

    lastId = batch.lastId;
    stats.lastIdProcessed = lastId;
    if (CONFIG.limit && processed >= CONFIG.limit) break;
    if (stats.failed >= CONFIG.maxFailures) {
      ui.log(`[abort] ${stats.failed} leads failed (--max-failures=${CONFIG.maxFailures}). Stopping so the cause can be fixed; everything committed so far stays.`);
      break;
    }
  }

  ui.stop();
  report();
  await src.sequelize.close();
  await tgt.sequelize.close();
};

/* ==========================================================================
 * 7. REPORT
 * ========================================================================== */

const report = () => {
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`);

  /* --tags-only did none of the lead / note / timeline work, so printing those
   * lines as zeros would only invite the question "why did nothing migrate?". */
  if (CONFIG.tagsOnly) {
    console.log('\n============ SUMMARY (TAGS ONLY) ============');
    console.log(`mode                 : ${CONFIG.commit ? 'COMMIT' : 'DRY RUN'}`);
    console.log(`resume cursor        : started after id ${stats.startedAfterId} -> got through id ${stats.lastIdProcessed}`);
    console.log(`tagged leads scanned : ${stats.scanned}   (source rows that carry at least one tag)`);
    console.log(`  of those, in v2    : ${stats.scanned - stats.tagLeadsNotMigrated}`);
    console.log(`  NOT in v2_leads    : ${stats.tagLeadsNotMigrated}${stats.tagLeadsNotMigrated ? '   <-- migrate these leads first, then re-run this' : ''}`);
    if (stats.tagLeadMissingSample.length) console.log(`  their v1 ids (first ${stats.tagLeadMissingSample.length}): ${stats.tagLeadMissingSample.join(', ')}`);
    console.log(`tag names on source  : ${stats.tagLinksFound}`);
    console.log(`lead_tags ${CONFIG.commit ? 'written    ' : 'WOULD write'}: ${stats.tagLinks}`);
    console.log(`  already linked     : ${stats.tagLinksAlready}`);
    if (stats.tagNamesUnresolved) {
      console.log(`  NOT counted above  : ${stats.tagNamesUnresolved} tag names resolved to no tag`
        + `${CONFIG.commit ? '   (createMissingTags is off — see the list below)' : '   <-- a DRY RUN creates no tags, so these could not be linked yet; --commit does both'}`);
    }
    console.log(`tags matched/created : ${stats.tagsMatched} / ${stats.tagsCreated}`);
    if (stats.tagsWouldCreate.size) console.log(`tags that WOULD be created : ${top(stats.tagsWouldCreate).join(', ')}`);
    if (stats.tagMisses.size)       console.log(`tag names left unlinked    : ${top(stats.tagMisses).join(', ')}`);
    console.log(`failed               : ${stats.failed}`);
    const secOnly = (ms) => `${(ms / 1000).toFixed(0)}s`;
    console.log(`time spent           : source fetch ${secOnly(stats.msSourceFetch)} | dedup lookups ${secOnly(stats.msDedupFetch)}`
      + ` | prepare ${secOnly(stats.msPrepare)} | write ${secOnly(stats.msWrite)}`);
    if (stats.lastIdProcessed) console.log(`\nto carry on from here:  node scripts/migrateLeadsToV2.js --commit --tags-only --after-id=${stats.lastIdProcessed}`);
    console.log('=============================================\n');
    writeReportFile();
    return;
  }

  console.log('\n================ SUMMARY ================');
  console.log(`mode                 : ${CONFIG.commit ? 'COMMIT' : 'DRY RUN'}`);
  console.log(`resume cursor        : started after id ${stats.startedAfterId} -> got through id ${stats.lastIdProcessed}`);
  console.log(`leads scanned        : ${stats.scanned}`);
  console.log(`leads inserted       : ${stats.migrated}`);
  console.log(`leads updated        : ${stats.updated}`);
  console.log(`leads skipped (exist): ${stats.skippedExisting}`);
  console.log(`leads failed         : ${stats.failed}`);
  console.log(`notes                : ${stats.notes} written / ${stats.notesFound} found in source`
    + `${stats.notesAlready ? `  (${stats.notesAlready} already there)` : ''}`
    + `${stats.notesWithoutAdmin ? `  (${stats.notesWithoutAdmin} SKIPPED: no mappable admin_id — set target.fallbackAdminUserId)` : ''}`);
  console.log(`timelines            : ${stats.timelines} written / ${stats.timelinesFound} found in source`
    + `${stats.timelinesAlready ? `  (${stats.timelinesAlready} already there)` : ''}`);
  console.log(`timeline window      : ${CONFIG.skipTimelines ? 'SKIPPED ENTIRELY' : timelineWindowLabel()}`
    + `${CONFIG.timelinesSince && !CONFIG.skipTimelines ? '  (older rows were never read from the source)' : ''}`);
  console.log(`activity trackers    : ${stats.trackers} written / ${stats.trackersFound} found in source`);
  console.log(`tags (lead_tags)     : ${CONFIG.skipTags ? 'SKIPPED ENTIRELY'
    : `${stats.tagLinks} links written / ${stats.tagLinksFound} tag names on ${stats.leadsWithTags} tagged leads`
      + `${stats.tagLinksAlready ? `  (${stats.tagLinksAlready} already linked)` : ''}`}`);
  if (!CONFIG.skipTags) console.log(`tags matched / created: ${stats.tagsMatched} / ${stats.tagsCreated}   (v1 manageLeads.tags names -> v2 tags.name)`
    + `${stats.tagNamesUnresolved ? `  (${stats.tagNamesUnresolved} tag names resolved to no tag${CONFIG.commit ? '' : ' — a DRY RUN creates none'})` : ''}`);
  if (stats.tagsWouldCreate.size) console.log(`tags that WOULD be created  : ${top(stats.tagsWouldCreate).join(', ')}`);
  if (stats.tagMisses.size)       console.log(`tag names left unlinked     : ${top(stats.tagMisses).join(', ')}`);
  console.log(`counsellors mapped   : ${stats.counsellorResolved}`);
  console.log(`users created        : ${stats.usersCreated}${tgtV1IdColumn ? `   (source id stamped in users.${tgtV1IdColumn})` : '   (no v1 id column in receiving users)'}`);
  console.log(`stages / sub-stages created: ${stats.stagesCreated} / ${stats.subStagesCreated}`);
  if (stats.usersWouldCreate.size)  console.log(`users that WOULD be created  : ${top(stats.usersWouldCreate).slice(0, 20).join(', ')}`);
  if (stats.userOrgMismatches.size) console.log(`users matched OUTSIDE org ${CONFIG.target.orgId}  : ${top(stats.userOrgMismatches).slice(0, 20).join(', ')}`);
  if (stats.userRoleRejected.size)  console.log(`counsellor left unassigned (email is a ${CONFIG.target.counsellorExcludedRoles.join('/')}) : ${top(stats.userRoleRejected).slice(0, 20).join(', ')}`);
  if (stats.stagesWouldCreate.size) console.log(`stages that WOULD be created : ${top(stats.stagesWouldCreate).join(', ')}`);
  console.log(`rounds matched / created : ${stats.roundsMatched} / ${stats.roundsCreated}`);
  console.log(`batches matched / created: ${stats.batchesMatched} / ${stats.batchesCreated}   (v1 cohorts -> v2 batches)`);
  if (stats.roundsWouldCreate.size)  console.log(`rounds that WOULD be created : ${top(stats.roundsWouldCreate).join(', ')}`);
  if (stats.batchesWouldCreate.size) console.log(`batches that WOULD be created: ${top(stats.batchesWouldCreate).join(', ')}`);
  if (stats.roundMisses.size)        console.log(`round misses                 : ${top(stats.roundMisses).slice(0, 15).join(', ')}`);
  if (stats.batchMisses.size)        console.log(`batch misses                 : ${top(stats.batchMisses).slice(0, 15).join(', ')}`);
  if (stats.counsellorMisses.size)  console.log(`counsellor misses            : ${top(stats.counsellorMisses).slice(0, 15).join(', ')}`);
  if (stats.unresolvedLeadStages.size) console.log(`unresolved lead stages       : ${top(stats.unresolvedLeadStages).join(', ')}`);
  if (stats.unresolvedSubStages.size)  console.log(`unresolved sub-stages        : ${top(stats.unresolvedSubStages).join(', ')}`);
  if (stats.unresolvedAppStages.size)  console.log(`unresolved application stages: ${top(stats.unresolvedAppStages).join(', ')}`);
  if (stats.unresolvedUsers.size)      console.log(`unmapped users               : ${[...stats.unresolvedUsers].slice(0, 20).join(', ')}${stats.unresolvedUsers.size > 20 ? ' …' : ''}`);
  const sec = (ms) => `${(ms / 1000).toFixed(0)}s`;
  console.log(`\ntime spent           : source fetch ${sec(stats.msSourceFetch)} | dedup lookups ${sec(stats.msDedupFetch)}`
    + ` | prepare ${sec(stats.msPrepare)} | write ${sec(stats.msWrite)}`);
  console.log('  source fetch or dedup lookups dominating? that is missing indexes, not the script:'
    + '\n     node scripts/migrateLeadsToV2.js --indexes-only'
    + '\n   builds every index these queries read through (section 4b lists them). Prepare/write'
    + '\n   dominating instead means the receiving DB is the limit — try --concurrency / --batch-size.');
  console.log(`dropped tracker columns (no v2 home): ${UNMAPPED_TRACKER_FIELDS.join(', ')}`);
  if (stats.lastIdProcessed) {
    console.log(`\nto carry on from here:  node scripts/migrateLeadsToV2.js --commit --after-id=${stats.lastIdProcessed}`);
    console.log('  (or just --resume, which reads the same cursor back out of v2_leads)');
    if (stats.failed) {
      console.log(`  NOTE: ${stats.failed} leads failed BELOW that id. Resuming will not retry them —`);
      console.log('        finish the tail first, then re-run once from 0 to backfill.');
    }
  }
  console.log('=========================================\n');
  writeReportFile();
};

/** The machine-readable twin of the summary above. */
const writeReportFile = () => {
  try {
    fs.mkdirSync(CONFIG.reportDir, { recursive: true });
    const file = path.join(CONFIG.reportDir, `migrateLeadsToV2-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({
      config: { ...CONFIG, leadIds: CONFIG.leadIds.length },
      stats: {
        ...stats,
        unresolvedLeadStages: Object.fromEntries(stats.unresolvedLeadStages),
        unresolvedSubStages: Object.fromEntries(stats.unresolvedSubStages),
        unresolvedAppStages: Object.fromEntries(stats.unresolvedAppStages),
        unresolvedUsers: [...stats.unresolvedUsers],
        counsellorMisses: Object.fromEntries(stats.counsellorMisses),
        roundsWouldCreate: Object.fromEntries(stats.roundsWouldCreate),
        roundMisses: Object.fromEntries(stats.roundMisses),
        batchesWouldCreate: Object.fromEntries(stats.batchesWouldCreate),
        batchMisses: Object.fromEntries(stats.batchMisses),
        usersWouldCreate: Object.fromEntries(stats.usersWouldCreate),
        userRoleRejected: Object.fromEntries(stats.userRoleRejected),
        userOrgMismatches: Object.fromEntries(stats.userOrgMismatches),
        stagesWouldCreate: Object.fromEntries(stats.stagesWouldCreate),
        tagsWouldCreate: Object.fromEntries(stats.tagsWouldCreate),
        tagMisses: Object.fromEntries(stats.tagMisses),
      },
    }, null, 2));
    console.log(`report written -> ${file}`);
  } catch (e) {
    console.warn('could not write report file:', e.message);
  }
};

run().catch((err) => {
  ui.stop();
  console.error('\nMIGRATION ABORTED:', err);
  process.exit(1);
});

export {
  LEAD_FIELD_MAP, NOTE_FIELD_MAP, TIMELINE_FIELD_MAP, TRACKER_FIELD_MAP,
  UNMAPPED_LEAD_FIELDS, UNMAPPED_TRACKER_FIELDS, applyMap,
};
