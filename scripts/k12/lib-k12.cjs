/**
 * K12 constants and the decisions taken for this migration.
 *
 *   v1  org 68 | school 26 | program 111 | form 114 | cohort 110 | round 141
 *   v2  org 12 | school 18 | program 123 | form 128 | batch  192 | round 216
 *
 * Verified against both databases by scripts/k12/41-preflight-k12.cjs.
 */
const V1 = { org: 68, school: 26, program: 111, form: 114, cohort: 110, round: 141 };
const V2 = { org: 12, school: 18, program: 123, form: 128, batch: 192, round: 216, leadTable: 19, formTable: 'under_graduate' };

/**
 * User decision 2026-10-08: Aditi Suryavanshi is deleted in v1, so her 244 leads go to
 * Soumya Sahdev instead of a re-created account. Keyed by the v1 user id behind the
 * `assignTo` uuid, so a rename on either side cannot silently re-point them.
 */
const COUNSELLOR_REASSIGN = { 357245: 4911750 };   // v1 Aditi Suryavanshi -> v2 Soumya Sahdev

/** User decision 2026-10-08: these two counsellors get a v2 account created from their v1 row. */
const COUNSELLOR_CREATE = [517092, 521628];        // Gagandeep Singh, Arshi Bansal

/**
 * How a created account must be wired, so it appears in User Management like any other
 * counsellor instead of being a bare `users` row. Taken from what v2's own
 * userService.createUser() writes (new_crm_backend/src/v2/services/userService.js:727)
 * and cross-checked against three live school-18 counsellors (4749645, 4805104, 4807089):
 *   users · org_users · user_roles · user_schools · user_programs · user_application_forms
 *   + an audit_logs entry.
 * K12 is a PROGRAM under school 18, so the account is scoped to program 123 / form 128.
 */
const USER_FLOW = {
  roleIds: [66],                 // "UG Counsellor", is_counsellor_role = true, level 1
  schoolIds: [V2.school],        // 18
  programIds: [V2.program],      // 123 (K12)
  formIds: [V2.form],            // 128
  orgRole: 'user',
  role: 'admin',                 // what createUser() writes for an admin-portal user
  userType: 'Institute Users',
  status: 'active',
  countryIso: 'IN',
  // org_users.invited_by / audit_logs.actor_id - the account the migration acts as
  actorUserId: 4640466,          // ugadmissions@mastersunion.org
  actorEmail: 'ugadmissions@mastersunion.org',
  bcryptRounds: 10,              // new_crm_backend/.env BCRYPT_ROUNDS
};

/** Only the last N months of timeline activity is migrated (user's decision 2026-10-08). */
const TIMELINE_MONTHS = 3;

/** Tag names the user asked us to create in v2 (they do not exist there yet). */
const TAGS_CREATE = ['testingqaremovetag', 'testtagbulk2703', 'PRIORITY'];

/**
 * Event titles K12 has that the UG migration never produced. Every target below is
 * already used natively in v2 except `inbound_call`, which v2 uses 655 times for the
 * same thing. `timelines.event_type` is varchar, so none of this can break an insert.
 */
const EXTRA_EVENT_TYPES = {
  'Lead Updated': 'lead_updated',
  'SMS_Sent': 'sms_sent',
  'Lead came from inbound call': 'inbound_call',
  'Payment Initiated': 'payment_initiated',
  'Lead Deleted': 'lead_deleted',
  'Counsellor Reassigned': 'counsellor_reassigned',
  'Counsellor Assigned': 'counsellor_assigned',
};

/**
 * Ad / attribution columns v1 populates and v2 has. The UG field map recorded these as
 * "always NULL on a migrated lead", which was true of the UG vendor leads it was derived
 * from - but WRONG in general: the already-migrated school-18 population carries gclid on
 * 1,955 rows, fb_lead_id on 4,759, utm_term on 2,173, form_name on 2,543, question12 on 31.
 * K12 is ad-driven, so these are real values. Found by reviewing the colleague's script.
 * [v1 column, v2 column]
 */
const ATTRIBUTION_FIELDS = [
  ['utmTerm', 'utm_term'], ['utmContent', 'utm_content'], ['utmPlacement', 'utm_placement'],
  ['utmCampaignId', 'utm_campaign_id'], ['utmAdGroupId', 'utm_ad_group_id'], ['utmCreativeId', 'utm_creative_id'],
  ['gclid', 'gclid'], ['fbclid', 'fbclid'], ['referrer', 'referrer'], ['formName', 'form_name'],
  ['instaHandle', 'insta_handle'], ['cbbLink', 'cbb_link'],
];

/** v1 question1..15 -> the same-named v2 columns (K12 uses question12 on 38 leads). */
const QUESTION_FIELDS = Array.from({ length: 15 }, (_, i) => 'question' + (i + 1));

/**
 * v1 columns with real values and NO v2 column. Kept under lead_payload.__legacy so the
 * data survives the move instead of being dropped silently (the colleague's idea).
 * Set STASH_LEGACY to false to keep lead_payload byte-identical to v1 instead.
 */
const STASH_LEGACY = true;
// `totalFormsInitiated` is deliberately NOT here: it is set on every single row (always 1),
// so stashing it would put a __legacy key on all 7,486 leads and tell you nothing.
// `school` is NOT here either - it is the "School & City" answer and now has a real
// destination (see SCHOOL_AND_CITY below), so stashing it would duplicate it.
const LEGACY_FIELDS = ['schoolAnandi', 'grades', 'programName', 'publisherSource'];

/**
 * "School & City" - the column the user asked about.
 *
 * In v1 it reaches the lead two ways, because the K12 widgets are not all configured the
 * same: widget field 10095 "School & City" (text, mandatory) and the older field 3416
 * "School" land in `manageLeadResponses`, while some widgets write the same answer
 * straight into `manageLeads.school`. All three are the same question, so all three
 * end up in the same place in v2.
 *
 * In v2 the K12 widget (widget 100 on form 128, school 18) declares this field as
 * `under_graduate.school_and_city` - but that column WAS NEVER CREATED, so v2's own
 * writer (`pickSatelliteFields`) silently drops it and the answer survives only inside
 * `v2_leads.lead_payload.formFields.school_and_city`. Verified on the two live K12 leads
 * the team submitted through that widget on 2026-10-08 (v2 leads 2335621, 2335715).
 *
 * So the migration writes BOTH:
 *   - `lead_payload.formFields.school_and_city` - always, because that is where v2 itself
 *     keeps it today, so migrated and natively-created K12 leads read the same way;
 *   - `under_graduate.school_and_city` - only if the column exists when the export runs.
 *     The export probes information_schema, so adding the column (one instant,
 *     metadata-only ALTER) before the run is enough to have it filled; adding it later is
 *     also fine, it can be backfilled from the payload.
 */
const SCHOOL_AND_CITY = { payloadKey: 'school_and_city', ugColumn: 'school_and_city' };

/**
 * v1 `primarySource/primaryMedium/primaryCampaign` - three more columns in the v1 lead
 * download. v2 has no `primary_*` column; it keeps one triple (source/medium/campaign)
 * plus secondary/tertiary. On K12 the primary triple is IDENTICAL to source/medium/campaign
 * on 7,479 of 7,486 leads, so it is already carried. Only the handful that genuinely differ
 * are stashed, under lead_payload.__legacy, so nothing is lost and 7,479 leads do not get a
 * pointless key. [v1 primary column, the v1 column it is compared with]
 */
const PRIMARY_FIELDS = [['primarySource', 'source'], ['primaryMedium', 'medium'], ['primaryCampaign', 'campaign']];

/**
 * The widget answers in v1 `manageLeadResponses`, and the v2 column each one belongs in.
 *
 * K12 has no application stream at all (0 `ApplicationManager` rows for form 114), which
 * is why this table was missed at first - but widget answers are stored per LEAD, not per
 * application, so 13,880 answers across 6,469 of the 7,486 live leads live here and would
 * otherwise never have moved. Found by working back from the v1 lead download, which the
 * user asked about: old_crm_backend/workflows/processors/csvExportProcessor.js builds its
 * dynamic columns from exactly this table.
 *
 * Keyed by the v1 `sectionfields.id`, so a renamed label cannot re-point an answer.
 *   ug      -> the `under_graduate` column (the v2 form table for school 18)
 *   lead    -> a `v2_leads` column, filled only when the v1 lead column itself is empty
 *   payload -> a `lead_payload.formFields` key (how v2's own widget stores it)
 *   carried -> already migrated from a `manageLeads` column; the answer adds nothing
 * Anything NOT listed here is reported by the export and kept in
 * `lead_payload.__v1_answers` under its v1 label, so a new v1 widget field can never be
 * dropped silently.
 */
const ANSWERS = {
  9986:  { label: 'Grade', ug: 'grade', lead: 'grade' },
  5075:  { label: 'Grade', ug: 'grade', lead: 'grade' },
  10095: { label: 'School & City', ug: SCHOOL_AND_CITY.ugColumn, payload: SCHOOL_AND_CITY.payloadKey },
  3416:  { label: 'School', ug: SCHOOL_AND_CITY.ugColumn, payload: SCHOOL_AND_CITY.payloadKey },
  6618:  { label: 'Which class are you currently studying in?', ug: 'current_grade_class' },
  5280:  { label: 'Professional Qualification', ug: 'professional_qualification' },
  5279:  { label: 'Professional Qualification', ug: 'professional_qualification' },
  8763:  { label: 'Academic Enrolment Status', ug: 'academic_enrolment_status' },
  3505:  { label: 'Parent Number', ug: 'parent_number' },
  5035:  { label: 'City', ug: 'city', lead: 'city' },
  4574:  { label: 'City', ug: 'city', lead: 'city' },
  6488:  { label: 'City', ug: 'city', lead: 'city' },
  4879:  { label: 'City', ug: 'city', lead: 'city' },
  9462:  { label: 'City', ug: 'city', lead: 'city' },
  6111:  { label: 'City', ug: 'city', lead: 'city' },
  6529:  { label: 'City', ug: 'city', lead: 'city' },
  6100:  { label: 'Full Name', carried: 'v2_leads.registered_name' },
  3405:  { label: 'Full Name', carried: 'v2_leads.registered_name' },
  6101:  { label: 'Email', carried: 'v2_leads.registered_email' },
  3406:  { label: 'Email', carried: 'v2_leads.registered_email' },
  6102:  { label: 'Phone Number', carried: 'v2_leads.registered_mobile' },
  3407:  { label: 'Phone Number', carried: 'v2_leads.registered_mobile' },
  // v2 has no column for this one. 1,015 leads were asked it but only 4 ever answered.
  6619:  { label: 'What is your English proficiency level?', v1AnswersOnly: true },
};


/**
 * RE-SYNC rules - which v2_leads columns 70-delta-k12.cjs may touch on a lead that is
 * ALREADY in v2, and under what condition. Fed to scripts/lib/repair-rules.cjs, which was
 * written for the UG repair and enforces the same three rules the user set on 2026-09-22:
 * never blank a v2 value, never overwrite v2 content, let progress move forward.
 *
 *   FILL      written only when v2 is EMPTY. Everything the lead "is" - name, contacts,
 *             location, attribution, the question answers, the stage and the counsellor.
 *             A stage or counsellor that v2 already holds is NEVER re-pointed by a script;
 *             the disagreement goes to delta_review.csv for a human (see DELTA_REVIEW).
 *   FWD_BOOL  false/NULL -> true only. A verified mobile cannot become unverified.
 *   FWD_NUM   only ever upwards (lead_score).
 *   FWD_DATE  only ever later (lead_stage_date).
 *
 * A column NOT listed here cannot be written by the delta at all - repair-rules refuses it.
 * Deliberately absent: the payment and application-progress columns (K12 has no application
 * stream at all, so v1 has nothing to say about them), is_deleted, and updated_at.
 * Checked against live v2_leads at startup, so a renamed column fails loudly.
 */
const DELTA_CLASSES = {
  FWD_BOOL: ['is_mobile_verified', 'is_email_verified', 'is_chatbot_lead', 'is_inbound_lead'],
  FWD_PAID: [],
  FWD_NUM: ['lead_score'],
  FWD_DATE: ['lead_stage_date'],
  FILL: [
    // identity and contact
    'registered_name', 'registered_email', 'registered_mobile', 'country_code',
    'alternate_email', 'alternate_mobile_number', 'applicant_name',
    // where they are
    'city', 'state', 'iso_code', 'lead_country', 'grade',
    // who owns them / where they are in the funnel
    'lead_stage_id', 'lead_sub_stage_id', 'previous_lead_stage', 'counsellor_id', 'user_id',
    'reassigned_on', 'reassigned_by',
    // how they arrived
    'source', 'medium', 'campaign', 'secondary_source', 'secondary_medium', 'secondary_campaign',
    'tertiary_source', 'tertiary_medium', 'tertiary_campaign',
    'lead_origin', 'lead_device', 'registered_device', 'registered_on', 'source_url',
    'utm_term', 'utm_content', 'utm_placement', 'utm_campaign_id', 'utm_ad_group_id',
    'utm_creative_id', 'gclid', 'fbclid', 'referrer', 'form_name', 'insta_handle', 'cbb_link',
    'fb_lead_id', 'program_eligible',
    // conversation and answers
    'crisp_chat_link', 'chat_summary', 'concat_smc', 'human_handoff',
    'question1', 'question2', 'question3', 'question4', 'question5', 'question6', 'question7',
    'question8', 'question9', 'question10', 'question11', 'question12', 'question13',
    'question14', 'question15',
  ],
};

/**
 * Columns where a difference between v1 and v2 is worth a human's attention rather than a
 * silent decision. Both sides hold a value and they disagree, so the delta leaves v2 alone
 * (rule 2) and writes the pair to delta_review.csv.
 */
const DELTA_REVIEW = ['lead_stage_id', 'lead_sub_stage_id', 'counsellor_id', 'lead_score',
  'registered_name', 'registered_email', 'registered_mobile', 'grade', 'city'];

const stripPlus = v => (v === null || v === undefined || v === '' ? null : String(v).replace(/^\+/, ''));
const trimOrNull = v => { if (v === null || v === undefined) return null; const s = String(v).trim(); return s === '' ? null : s; };

module.exports = { V1, V2, COUNSELLOR_REASSIGN, COUNSELLOR_CREATE, TAGS_CREATE, EXTRA_EVENT_TYPES,
  ATTRIBUTION_FIELDS, QUESTION_FIELDS, STASH_LEGACY, LEGACY_FIELDS, USER_FLOW, TIMELINE_MONTHS,
  SCHOOL_AND_CITY, PRIMARY_FIELDS, ANSWERS, DELTA_CLASSES, DELTA_REVIEW, stripPlus, trimOrNull };
