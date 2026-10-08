/**
 * K12: DOES EVERY COLUMN OF THE v1 LEAD DOWNLOAD REACH v2?   READ ONLY.
 *
 *   node scripts/k12/43-dump-coverage-k12.cjs
 *
 * The user asked about the columns they see when they download K12 leads out of the old CRM
 * - "School & City" among them. This script answers that question from the two live
 * databases rather than from anyone's memory.
 *
 * The header list below is not invented: it is the one the old CRM itself builds, copied
 * from old_crm_backend/workflows/processors/csvExportProcessor.js (the org-68 variant, which
 * is K12's - it drops "Program Eligible" and adds "Human Handoff" and "Chat Summary"),
 * together with the v1 column behind each header, taken from the same file's row builder.
 *
 * The download has a SECOND half the file calls "dynamic headers": the widget answers out of
 * v1 manageLeadResponses. K12 has no application stream at all (0 ApplicationManager rows
 * for form 114), but widget answers hang off the LEAD, so there are 13,880 of them. Those
 * are checked too, every one, against the ANSWERS map in lib-k12.cjs.
 *
 * For every column it prints: how many of the live K12 leads have a value, and where that
 * value lands in v2. Anything populated with nowhere to land is a FAILURE.
 */
const { connect } = require('../lib/db.cjs');
const K = require('./lib-k12.cjs');

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(100) + '\n' + t + '\n' + '='.repeat(100));

/**
 * [dump header, v1 column, where it goes in v2]
 * A destination of the form table.column is checked against v2's information_schema.
 */
const DUMP = [
  ['Name', 'registeredName', 'v2_leads.registered_name + v2_leads.applicant_name'],
  ['Email', 'registeredEmail', 'v2_leads.registered_email'],
  ['Mobile', 'registeredMobile', 'v2_leads.registered_mobile'],
  ['Source', 'source', 'v2_leads.source'],
  ['Medium', 'medium', 'v2_leads.medium'],
  ['Campaign', 'campaign', 'v2_leads.campaign'],
  ['Primary Source', 'primarySource', 'same as Source on all but a handful; a real difference -> lead_payload.__legacy'],
  ['Primary Medium', 'primaryMedium', 'same as Medium on all but a handful; a real difference -> lead_payload.__legacy'],
  ['Primary Campaign', 'primaryCampaign', 'same as Campaign on all but a handful; a real difference -> lead_payload.__legacy'],
  ['Secondary Source', 'secondarySource', 'v2_leads.secondary_source'],
  ['Secondary Medium', 'secondaryMedium', 'v2_leads.secondary_medium'],
  ['Secondary Campaign', 'secondaryCampaign', 'v2_leads.secondary_campaign'],
  ['Tertiary Source', 'tertiarySource', 'v2_leads.tertiary_source'],
  ['Tertiary Medium', 'tertiaryMedium', 'v2_leads.tertiary_medium'],
  ['Tertiary Campaign', 'tertiaryCampaign', 'v2_leads.tertiary_campaign'],
  ['UTM Term', 'utmTerm', 'v2_leads.utm_term'],
  ['UTM Placement', 'utmPlacement', 'v2_leads.utm_placement'],
  ['UTM Content', 'utmContent', 'v2_leads.utm_content'],
  ['UTM Campaign ID', 'utmCampaignId', 'v2_leads.utm_campaign_id'],
  ['UTM Ad Group ID', 'utmAdGroupId', 'v2_leads.utm_ad_group_id'],
  ['UTM Creative ID', 'utmCreativeId', 'v2_leads.utm_creative_id'],
  ['Lead Type', 'leadType', 'v2_leads.lead_type'],
  ['Lead Origin', 'leadOrigin', 'v2_leads.lead_origin'],
  ['Source URL', 'sourceUrl', 'v2_leads.source_url'],
  ['Country Code', 'countryCode', 'v2_leads.country_code'],
  ['Alternate Email', 'alternateEmail', 'v2_leads.alternate_email'],
  ['Alternate Mobile', 'alternateMobileNumber', 'v2_leads.alternate_mobile_number'],
  ['Grades', 'grades', 'lead_payload.__legacy (v2 has no column; "Grade" is the real one)'],
  ['City', 'city', 'v2_leads.city + under_graduate.city'],
  ['School', 'school', 'THE "School & City" ANSWER -> lead_payload.formFields.school_and_city (+ under_graduate.school_and_city if that column exists)'],
  ['Grade', 'grade', 'v2_leads.grade + under_graduate.grade'],
  ['Lead Score', 'leadScore', 'v2_leads.lead_score (and every point of it in leadScoreHistory)'],
  ['User Type', 'userType', "v2_leads.type ('lead' / 'applicant')"],
  ['Mobile Verified', 'isMobileVerified', 'v2_leads.is_mobile_verified'],
  ['Email Verified', 'isEmailVerified', 'v2_leads.is_email_verified'],
  ['Payment Status', 'paymentStatus', 'v2_leads.payment_status'],
  ['Coupon Code', 'couponCode', 'NO SUCH COLUMN IN v1 - the download prints this header always empty'],
  ['Registered On', 'registeredOn', 'v2_leads.registered_on'],
  ['Updated At', 'updatedAt', 'v2_leads.updated_at'],
  ['Counsellor', 'assignTo', 'v2_leads.counsellor_id (resolved to a v2 user, see the decisions)'],
  ['Lead Stage', 'leadStageId', 'v2_leads.lead_stage_id (mapped to the school-18 stage of the same name)'],
  ['Lead Sub Stage', 'leadSubStageId', 'v2_leads.lead_sub_stage_id'],
  ['Program', 'programId', 'v2_leads.program_id = ' + K.V2.program + ' (K12 is a programme under school 18 in v2)'],
  ['Notes', '(Notes table)', 'notes.content, one row per note, with its author'],
  ['Tags', 'tags', 'lead_tags -> tags'],
  ['Concat SMC', 'concatSMC', 'v2_leads.concat_smc'],
  ['Human Handoff', 'humanHandoff', 'v2_leads.human_handoff'],
  ['Chat Summary', 'chatSummary', 'v2_leads.chat_summary'],
];
for (let i = 1; i <= 15; i++) DUMP.push(['Question ' + i, 'question' + i, 'v2_leads.question' + i]);
// the nine activity-tracker dates, which the download reads off the tracker row
for (const [h, c] of [['Application Form Start Date', 'applicationForm_start_date'],
  ['Payment Initiated Date', 'payment_Initiated_date'], ['Payment Last Initiated Date', 'payment_last_Initiated_date'],
  ['Counsellor First Activity Date', 'counsellor_first_activity_date'],
  ['Counsellor Last Activity Date', 'counsellor_last_activity_date'], ['Application Fee Paid On', 'application_fee_paidOn'],
  ['Last Lead Stage Updated', 'lastLeadStageUpdated'], ['First Lead Stage Updated', 'firstLeadStageUpdated'],
  ['Application Last Activity Date', 'application_last_activity_date']]) {
  DUMP.push([h, '(tracker) ' + c, 'ApplicationActivityTrackers."' + c + '"']);
}

(async () => {
  const v1 = await connect('v1'), v2 = await connect('v2');
  const q1 = async (s, p) => (await v1.query(s, p)).rows;
  const q2 = async (s, p) => (await v2.query(s, p)).rows;
  let fails = 0, decide = 0;
  const fail = m => { fails++; log('  FAIL   ' + m); };

  try {
    hr('K12: every column of the v1 lead download, and where it lands in v2');
    log('  v1 form ' + K.V1.form + ' (K12, org ' + K.V1.org + ')  ->  v2 form ' + K.V2.form
      + ' / program ' + K.V2.program + ' / school ' + K.V2.school);

    // ---------------------------------------------------------------- what v2 has
    const colsOf = async (t) => new Set((await q2(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [t]))
      .map(r => r.column_name));
    const v2Cols = { v2_leads: await colsOf('v2_leads'), under_graduate: await colsOf('under_graduate'),
      notes: await colsOf('notes'), lead_tags: await colsOf('lead_tags'), tags: await colsOf('tags'),
      ApplicationActivityTrackers: await colsOf('ApplicationActivityTrackers'), leadScoreHistory: await colsOf('leadScoreHistory') };

    // ---------------------------------------------------------------- what v1 has, and how much of it
    const v1Cols = new Set((await q1(
      "select column_name from information_schema.columns where table_name = 'manageLeads'")).map(r => r.column_name));
    const leadCols = DUMP.map(d => d[1]).filter(c => v1Cols.has(c));
    const sel = leadCols.map(c => `count("${c}") filter (where "${c}"::text <> '')::int as "${c}"`).join(', ');
    const [counts] = await q1(`select count(*)::int __total, ${sel} from "manageLeads"
        where "applicationFormId" = $1 and "isLeadDeleted" = false`, [K.V1.form]);
    const total = counts.__total;
    const [sat] = await q1(`select
        (select count(distinct "leadId")::int from "Notes" where "leadId" = any($1::int[])) notes,
        (select count(distinct "leadId")::int from "applicationActivityTracker" where "leadId" = any($1::int[])) trk
      from (select 1) x`, [(await q1(`select array_agg(id) a from "manageLeads" where "applicationFormId" = $1 and "isLeadDeleted" = false`, [K.V1.form]))[0].a]);

    log('\n  live K12 leads in v1: ' + total + '\n');
    log('  ' + 'DUMP COLUMN'.padEnd(32) + 'v1 COLUMN'.padEnd(34) + 'WITH A VALUE'.padStart(13) + '   LANDS IN v2');
    log('  ' + '-'.repeat(96));
    for (const [header, v1col, dest] of DUMP) {
      let n;
      if (v1col === '(Notes table)') n = sat.notes;
      else if (v1col.startsWith('(tracker) ')) n = sat.trk;
      else if (!v1Cols.has(v1col)) n = -1;
      else n = counts[v1col];
      const shown = n === -1 ? 'no column' : (n === 0 ? '-' : String(n));
      log('  ' + header.padEnd(32) + v1col.padEnd(34) + shown.padStart(13) + '   ' + dest);
      // a destination that names a real table.column must exist
      const m = /^([A-Za-z_]+)\."?([A-Za-z_0-9]+)"?/.exec(dest);
      if (m && v2Cols[m[1]]) {
        if (!v2Cols[m[1]].has(m[2])) fail(`${header}: v2 has no ${m[1]}.${m[2]}`);
      }
      if (n > 0 && /^NO SUCH/.test(dest)) fail(`${header}: ${n} value(s) in v1 and nowhere to put them`);
      if (n === -1 && !/^NO SUCH/.test(dest)) fail(`${header}: the v1 column "${v1col}" does not exist, but a destination is declared`);
    }

    // ---------------------------------------------------------------- the dynamic half
    hr('the "dynamic headers": every widget answer K12 leads actually have');
    const ans = await q1(`select r."sectionFieldId" fid, max(sf.label) label, max(sf.type) type,
          count(distinct r."manageLeadId")::int leads,
          count(*) filter (where coalesce(nullif(btrim(r.value), ''), nullif(btrim(fo.value), ''),
                                         nullif(btrim(fo.label), ''), nullif(btrim(r."fileAttachmentName"), '')) is not null)::int answered
        from "manageLeadResponses" r
        join "manageLeads" l on l.id = r."manageLeadId"
        left join sectionfields sf on sf.id = r."sectionFieldId"
        left join fieldoptions fo on fo.id = r."fieldOptionId"
       where l."applicationFormId" = $1 and l."isLeadDeleted" = false
       group by 1 order by 4 desc`, [K.V1.form]);
    log('  ' + 'v1 FIELD'.padEnd(8) + 'LABEL'.padEnd(46) + 'LEADS'.padStart(7) + 'ANSWERED'.padStart(10) + '   LANDS IN v2');
    log('  ' + '-'.repeat(96));
    for (const a of ans) {
      const d = K.ANSWERS[a.fid];
      let dest;
      if (!d) dest = 'NOT MAPPED';
      else if (d.carried) dest = 'already carried by ' + d.carried;
      else if (d.v1AnswersOnly) dest = 'lead_payload.__v1_answers (v2 has no column for it)';
      else {
        const parts = [];
        if (d.ug) parts.push(v2Cols.under_graduate.has(d.ug) ? 'under_graduate.' + d.ug : 'under_graduate.' + d.ug + ' (COLUMN MISSING)');
        if (d.lead) parts.push('v2_leads.' + d.lead + ' (when the v1 lead column is empty)');
        if (d.payload) parts.push('lead_payload.formFields.' + d.payload);
        dest = parts.join(' + ');
      }
      log('  ' + String(a.fid).padEnd(8) + String(a.label || '?').slice(0, 45).padEnd(46)
        + String(a.leads).padStart(7) + String(a.answered).padStart(10) + '   ' + dest);
      if (!d && a.answered > 0) fail(`v1 widget field ${a.fid} "${a.label}" has ${a.answered} answer(s) and is not in ANSWERS (lib-k12.cjs)`);
      if (d && d.ug && !v2Cols.under_graduate.has(d.ug)) {
        if (d.payload) {
          decide++;
          log('      DECIDE  under_graduate.' + d.ug + ' does not exist in v2. v2\'s OWN K12 widget (widget 100, form 128)');
          log('              declares it, but the column was never created, so v2 itself keeps this answer only in');
          log('              lead_payload.formFields.' + d.payload + ' - which is exactly where this migration puts it.');
          log('              Create the column and the export fills it as well; it needs no table rewrite:');
          log('                ALTER TABLE under_graduate ADD COLUMN ' + d.ug + ' varchar(255);');
        } else {
          fail(`under_graduate.${d.ug} does not exist and there is no payload fallback for "${a.label}"`);
        }
      }
    }

    // ---------------------------------------------------------------- the one the user asked about
    hr('"School & City", end to end');
    const [sc] = await q1(`select
        count(*) filter (where school is not null and btrim(school) <> '')::int lead_column,
        (select count(distinct r."manageLeadId")::int from "manageLeadResponses" r
           join "manageLeads" l2 on l2.id = r."manageLeadId"
          where l2."applicationFormId" = $1 and l2."isLeadDeleted" = false
            and r."sectionFieldId" in (10095, 3416)
            and coalesce(nullif(btrim(r.value), ''), '') <> '') answer
      from "manageLeads" where "applicationFormId" = $1 and "isLeadDeleted" = false`, [K.V1.form]);
    log('  In v1 it arrives two ways, because the K12 widgets are not all wired the same:');
    log(`    manageLeads.school (the "School" column of the download)   ${sc.lead_column} lead(s)`);
    log(`    widget answer 10095 "School & City" / 3416 "School"        ${sc.answer} lead(s)`);
    log('  Both are the same question, so both go to the same place in v2.');
    const widget = await q2(`select w.id, w.name, wf.label, c.table_name, c.column_name
        from widgets w join widget_fields wf on wf.widget_id = w.id
        left join widget_field_columns c on c.widget_field_id = wf.id
       where w.application_form_id = $1 and wf.label ilike '%school%'`, [K.V2.form]);
    for (const w of widget) {
      log(`\n  v2's own K12 widget ${w.id} "${w.name}" declares "${w.label}" -> ${w.table_name}.${w.column_name}`);
      const exists = (v2Cols[w.table_name] || new Set()).has(w.column_name);
      log('  that column ' + (exists ? 'EXISTS - the export writes it' : 'DOES NOT EXIST in v2'));
      if (!exists) {
        // lead_payload is json, not jsonb, so it is cast before being asked
        const [p] = await q2(`select count(*)::int n from v2_leads
            where form_id = $1 and (lead_payload::jsonb -> 'formFields') ? $2`, [K.V2.form, w.column_name]);
        log(`  so v2 keeps the answer in lead_payload.formFields.${w.column_name} instead - ${p.n} of v2's own K12 lead(s) already do`);
        log('  THIS MIGRATION WRITES THE SAME KEY, so a migrated lead and a lead the widget creates read identically.');
      }
    }
    const samples = await q1(`select id, school from "manageLeads" where "applicationFormId" = $1
        and "isLeadDeleted" = false and school is not null and length(school) > 18 order by id desc limit 5`, [K.V1.form]);
    log('\n  what the values actually look like (so you can see it is school AND city, free text):');
    samples.forEach(r => log(`    v1 lead ${r.id}: ${JSON.stringify(r.school)}`));

    // ---------------------------------------------------------------- verdict
    hr('RESULT');
    log(`  dump columns checked   ${DUMP.length}`);
    log(`  widget answer fields   ${ans.length}`);
    log(`  failures               ${fails}`);
    log(`  decisions for you      ${decide}`);
    if (!fails) log('\n  EVERY POPULATED COLUMN OF THE v1 K12 DOWNLOAD HAS A PLACE IN v2.');
    else log('\n  FIX THE FAILURES ABOVE BEFORE IMPORTING.');
    process.exitCode = fails ? 1 : 0;
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
