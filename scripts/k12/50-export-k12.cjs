/**
 * K12 EXPORT - step 1 of 2. READ ONLY: writes files, never a database row.
 *
 *   node scripts/k12/50-export-k12.cjs
 *
 * Reads v1 form 114 (K12), resolves every mapping against LIVE v2, and writes
 * data/k12/<runId>/. Aborts rather than guess if a mapping cannot be resolved.
 *
 * Scope: live leads only (the user chose to skip the 106 deleted ones), and only
 * leads that are not in v2 yet - so a re-run is incremental, like the UG chain.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connect } = require('../lib/db.cjs');
const { Progress } = require('../lib/progress.cjs');
const M = require('../lib/maps.cjs');
const K = require('./lib-k12.cjs');

const REPOS = 'C:/Users/Prateek/Desktop/Repos';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const DIR = path.join(REPOS, 'data', 'k12', RUN_ID);

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(84) + '\n' + t + '\n' + '='.repeat(84));
const warnings = [];
const warn = m => { warnings.push(m); log('  WARN  ' + m); };
const { stripPlus, trimOrNull } = K;

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  hr(`K12 EXPORT   run ${RUN_ID}`);
  log(`  v1 org ${K.V1.org} / school ${K.V1.school} / program ${K.V1.program} / form ${K.V1.form}`);
  log(`  v2 org ${K.V2.org} / school ${K.V2.school} / program ${K.V2.program} / form ${K.V2.form} / batch ${K.V2.batch} / round ${K.V2.round}`);

  const v1 = await connect('v1'), v2 = await connect('v2');
  try {
    // ----------------------------------------------------------------- 1. target still as expected
    hr('1. the target, re-checked right now');
    const tgt = (await v2.query(`select f.id form, f."programId" program, f."cohortId" batch, f."roundId" round, f."schoolId" school,
        f."organizationId" org, f."isActive" active from "applicationForms" f where f.id = $1`, [K.V2.form])).rows[0];
    if (!tgt) throw new Error(`v2 form ${K.V2.form} does not exist`);
    for (const [k, want] of [['org', K.V2.org], ['school', K.V2.school], ['program', K.V2.program], ['batch', K.V2.batch], ['round', K.V2.round]]) {
      if (Number(tgt[k]) !== want) throw new Error(`v2 form ${K.V2.form} ${k} is ${tgt[k]}, expected ${want} - refusing to export`);
    }
    const lt = (await v2.query('select id, table_name from org_lead_tables where org_id = $1 and school_id = $2 and is_active', [K.V2.org, K.V2.school])).rows[0];
    if (!lt || lt.id !== K.V2.leadTable) throw new Error('the v2 lead table for this school is not the one this export was built for');
    log(`  form ${tgt.form} -> program ${tgt.program}, batch ${tgt.batch}, round ${tgt.round}, lead table ${lt.id} ${lt.table_name}   OK`);

    // ----------------------------------------------------------------- 2. scope
    //
    // Every live K12 lead is in scope, and each one is then put in one of two piles:
    //
    //   NEW            not in v2 yet          -> leads.ndjson, inserted
    //   ALREADY IN V2  has a v2_leads row     -> delta_leads.ndjson, and the importer only
    //                                            writes what its rules allow (--with-delta)
    //
    // The satellites (timelines, notes, tags, tracker, score history) are read for BOTH
    // piles, because a lead migrated last week can have picked up a new note or a new
    // timeline in v1 since - and every satellite insert is keyed on a unique index, so
    // re-offering the old ones costs nothing. This is what makes a second run a re-sync
    // rather than a one-shot.
    hr('2. scope: every live v1 K12 lead, split into new and already-in-v2');
    const { rows: allLive } = await v1.query(
      `select * from "manageLeads" where "applicationFormId" = $1 and "isLeadDeleted" = false order by id`, [K.V1.form]);
    const ids = allLive.map(r => r.id);
    const have = new Map();                       // v1 lead id -> the v2 lead id it became
    for (let i = 0; i < ids.length; i += 20000) {
      const { rows } = await v2.query(
        'select id, v1_lead_id from v2_leads where v1_lead_id = any($1::int[])', [ids.slice(i, i + 20000)]);
      rows.forEach(r => have.set(r.v1_lead_id, Number(r.id)));
    }
    const toImport = allLive.filter(l => !have.has(l.id));
    const alreadyIn = allLive.filter(l => have.has(l.id));
    const scope = allLive;
    const { rows: [del] } = await v1.query('select count(*)::int n from "manageLeads" where "applicationFormId" = $1 and "isLeadDeleted"', [K.V1.form]);
    log(`  live in v1 ${allLive.length}   already in v2 ${have.size}   TO INSERT ${toImport.length}`);
    log(`  deleted in v1 ${del.n} - deliberately NOT migrated (user's decision 2026-10-08)`);
    if (alreadyIn.length) {
      const changed = alreadyIn.filter(l => new Date(l.updatedAt) > new Date(l.createdAt)).length;
      log(`  of the ${alreadyIn.length} already in v2, ${changed} have been edited in v1 since they were created`);
    }
    if (!toImport.length && !alreadyIn.length) log('  nothing to do.');

    // ----------------------------------------------------------------- 3. maps
    hr('3. mappings, built from the live databases');
    const { stage, subStage } = await M.buildStageMaps(v1, v2);
    const { map: ugCounsellors } = await M.buildCounsellorMap(v1, v2);
    log(`  stage map ${stage.size} entries, sub-stage map ${subStage.size}, observed school-${K.V2.school} counsellor map ${ugCounsellors.size}`);

    // v1 users behind every assignTo uuid in scope
    const uuids = [...new Set(scope.map(l => l.assignTo).filter(Boolean))];
    const { rows: v1Staff } = uuids.length
      ? await v1.query('select id, uuid, name, email, "mobileNumber" mob, "countryCode" cc, password, "isDeleted" del, timezone, image, "createdAt", "updatedAt" from users where uuid = any($1::uuid[])', [uuids])
      : { rows: [] };
    const staffByUuid = new Map(v1Staff.map(u => [u.uuid, u]));

    /** v2 account for a v1 staff row: reassignment first, then the +1 account, then the plain one. */
    const resolveCounsellor = async (uuid) => {
      const u = staffByUuid.get(uuid);
      if (!u) return { id: null, how: 'no v1 user behind the uuid' };
      if (K.COUNSELLOR_REASSIGN[u.id]) return { id: K.COUNSELLOR_REASSIGN[u.id], how: `reassigned by the user's decision (v1 ${u.id} ${u.email})` };
      const obs = ugCounsellors.get(uuid);
      if (obs) return { id: Number(obs), how: 'the account school-18 leads already use' };
      const base = (u.email || '').split('@')[0], dom = (u.email || '').split('@')[1];
      if (u.email) {
        const { rows } = await v2.query(
          `select id, email, role, status from users where organization_id = $1 and lower(email) in (lower($2), lower($3)) and role <> 'student' order by email`,
          [K.V2.org, u.email, `${base}+1@${dom}`]);
        // An email guess is the weakest of the three paths, so it is not allowed to hand a
        // lead to an account nobody can sign in to. (The observed map and the user's
        // reassignment decision are evidence, and are trusted even if the account is
        // disabled - that is what school-18 leads already point at.)
        const usable = r => String(r.status || '').toLowerCase() !== 'disabled';
        const p1 = rows.find(r => r.email.toLowerCase() === `${base}+1@${dom}`.toLowerCase());
        if (p1 && usable(p1)) return { id: Number(p1.id), how: 'matched the +1 account by email' };
        const plain = rows.find(r => r.email.toLowerCase() === u.email.toLowerCase());
        if (plain && usable(plain)) return { id: Number(plain.id), how: 'matched the plain account by email (no +1 account exists)' };
        const disabled = [p1, plain].filter(Boolean).filter(r => !usable(r));
        if (disabled.length && !K.COUNSELLOR_CREATE.includes(u.id)) {
          return { id: null, how: `the only v2 account(s) matching this email are DISABLED (${disabled.map(r => r.id + ' ' + r.email).join(', ')}) - the lead(s) arrive UNASSIGNED rather than owned by an account nobody can sign in to` };
        }
      }
      if (K.COUNSELLOR_CREATE.includes(u.id)) return { id: null, pendingV1Id: u.id, how: 'account will be CREATED by the importer' };
      return { id: null, how: 'NO v2 account' };
    };
    const counsellorFor = new Map(), counsellorHow = new Map();
    for (const uuid of uuids) {
      const r = await resolveCounsellor(uuid);
      counsellorFor.set(uuid, r);
      const u = staffByUuid.get(uuid);
      counsellorHow.set(`${u ? u.email : uuid} -> ${r.id || (r.pendingV1Id ? 'CREATE ' + r.pendingV1Id : 'NULL')} (${r.how})`,
        scope.filter(l => l.assignTo === uuid).length);
    }
    [...counsellorHow.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => log(`    ${String(n).padStart(4)} leads  ${k}`));
    const unresolved = uuids.filter(u => { const r = counsellorFor.get(u); return !r.id && !r.pendingV1Id; });
    if (unresolved.length) warn(`${unresolved.length} counsellor uuid(s) resolve to NULL - those leads arrive unassigned`);

    // staff accounts to create
    const outStaff = v1Staff.filter(u => K.COUNSELLOR_CREATE.includes(u.id)).map(u => ({
      v1_id: u.id, email: trimOrNull(u.email), name: trimOrNull(u.name), phone: trimOrNull(u.mob),
      country_code: stripPlus(u.cc),
      // createUser() leaves users.school_id NULL and expresses access through
      // user_schools - the three live school-18 counsellors look exactly like that.
      role: K.USER_FLOW.role, user_type: K.USER_FLOW.userType, organization_id: K.V2.org, school_id: null,
      country_iso: K.USER_FLOW.countryIso,
      status: K.USER_FLOW.status, timezone: u.timezone, image: u.image, login_count: 0,
      created_at: u.createdAt, updated_at: u.updatedAt,
      // the wiring v2's own createUser() writes - see USER_FLOW in lib-k12.cjs
      wiring: {
        roleIds: K.USER_FLOW.roleIds, schoolIds: K.USER_FLOW.schoolIds,
        programIds: K.USER_FLOW.programIds, formIds: K.USER_FLOW.formIds,
        orgRole: K.USER_FLOW.orgRole, invitedBy: K.USER_FLOW.actorUserId,
        displayName: trimOrNull(u.name), displayEmail: (u.email || '').toLowerCase().trim(),
      },
    }));
    for (const s of outStaff) s.email = (s.email || '').toLowerCase().trim();   // createUser() normalises
    for (const s of outStaff) {
      const { rows } = await v2.query('select id, email from users where v1_id = $1 or lower(email) = lower($2)', [s.v1_id, s.email || '~']);
      if (rows.length) warn(`staff ${s.email} already has a v2 row ${JSON.stringify(rows)} - the importer reuses it instead of creating one`);
      // The importer generates a strong password and hashes it the way v2 does, so the v1
      // hash is deliberately NOT carried over and no credential sits in the export files.
    }
    log(`  staff accounts to create: ${outStaff.length} ${JSON.stringify(outStaff.map(s => s.email))}`);

    // students: only for the live applicant rows in scope
    const studentV1Ids = [...new Set(toImport.map(l => l.userId).filter(Boolean))];
    const { rows: haveStu } = studentV1Ids.length
      ? await v2.query('select id, v1_id, email from users where v1_id = any($1::int[])', [studentV1Ids]) : { rows: [] };
    const stuByV1 = new Map(haveStu.map(r => [r.v1_id, Number(r.id)]));
    const needStu = studentV1Ids.filter(id => !stuByV1.has(id));
    const { rows: v1Stu } = needStu.length ? await v1.query('select * from users where id = any($1::int[])', [needStu]) : { rows: [] };
    const outStudents = [];
    for (const u of v1Stu) {
      if (!u.email) { warn(`v1 student ${u.id} has no email; users.email is NOT NULL - the lead keeps user_id NULL`); continue; }
      const { rows: byEmail } = await v2.query('select id from users where lower(email) = lower($1) and organization_id = $2', [u.email, K.V2.org]);
      if (byEmail.length) { stuByV1.set(u.id, Number(byEmail[0].id)); warn(`v1 student ${u.id} ${u.email} already exists in v2 as ${byEmail[0].id} - reusing it`); continue; }
      outStudents.push({
        v1_id: u.id, email: u.email, name: trimOrNull(u.name), phone: trimOrNull(u.mobileNumber),
        password_hash: u.password || null, country_code: stripPlus(u.countryCode),
        role: 'student', user_type: 'Institute Users', organization_id: K.V2.org, school_id: K.V2.school,
        status: 'active', timezone: u.timezone, image: u.image, login_count: 0,
        created_at: u.createdAt, updated_at: u.updatedAt,
      });
    }
    log(`  student accounts to create: ${outStudents.length}`);

    // tags
    const tagNames = [...new Set(scope.flatMap(l => (l.tags || [])).map(t => String(t).trim()).filter(Boolean))];
    const { rows: v2Tags } = tagNames.length
      ? await v2.query('select id, name from tags where org_id = $1 and lower(btrim(name)) = any($2::text[])',
        [K.V2.org, tagNames.map(t => t.toLowerCase())]) : { rows: [] };
    const tagIdByName = new Map(v2Tags.map(r => [r.name.trim().toLowerCase(), Number(r.id)]));
    const { rows: v1TagCat } = tagNames.length
      ? await v1.query('select id, "tagName" nm from "LeadTags" where lower(btrim("tagName")) = any($1::text[])', [tagNames.map(t => t.toLowerCase())]) : { rows: [] };
    const v1TagIdByName = new Map(v1TagCat.map(r => [r.nm.trim().toLowerCase(), r.id]));
    const outTagsCreate = [];
    for (const nm of tagNames) {
      if (tagIdByName.has(nm.toLowerCase())) continue;
      if (!K.TAGS_CREATE.some(t => t.toLowerCase() === nm.toLowerCase())) {
        warn(`tag "${nm}" is not in v2 and was not on the user's create list - its links are skipped`);
        continue;
      }
      outTagsCreate.push({ org_id: K.V2.org, name: nm, v1_tag_id: v1TagIdByName.get(nm.toLowerCase()) ?? null });
    }
    log(`  tags: ${tagIdByName.size} already in v2, ${outTagsCreate.length} to create ${JSON.stringify(outTagsCreate.map(t => t.name))}`);

    // ----------------------------------------------------------------- 4. satellites from v1
    hr('4. reading the satellites');
    const leadIds = scope.map(l => l.id);      // NEW + already-in-v2, so a re-run picks up new activity
    const chunked = async (sql, label) => {
      const out = [];
      const p = new Progress(leadIds.length || 1, label);
      for (let i = 0; i < leadIds.length; i += 2000) {
        const part = leadIds.slice(i, i + 2000);
        const { rows } = await v1.query(sql, [part]);
        out.push(...rows);
        p.tick(part.length);
      }
      p.done();
      return out;
    };
    // Only the last TIMELINE_MONTHS months (user's decision 2026-10-08). The cutoff is
    // anchored at the start of this export, so every batch uses the same boundary, and it
    // keeps every row inside an ATTACHED monthly partition of v2.timelines - nothing lands
    // in timelines_pdefault.
    const tlCutoff = new Date(Date.now() - K.TIMELINE_MONTHS * 30.44 * 24 * 3600 * 1000);
    const tl = await chunked(
      'select * from "UserTimelines" where "leadId" = any($1::int[]) and "isDeleted" = false and "createdAt" >= '
        + "'" + tlCutoff.toISOString() + "'::timestamptz",
      'timelines (last ' + K.TIMELINE_MONTHS + ' months)');
    log('  timeline cutoff ' + tlCutoff.toISOString().slice(0, 10) + ' - older activity is deliberately NOT migrated');
    const nt = await chunked('select * from "Notes" where "leadId" = any($1::int[])', 'notes');
    const tk = await chunked('select * from "applicationActivityTracker" where "leadId" = any($1::int[]) order by id', 'trackers');
    const sh = await chunked('select * from "LeadScoreHistories" where "leadId" = any($1::int[]) order by "createdAt", id', 'score history');
    log(`  timelines ${tl.length} (in window)  notes ${nt.length}  trackers ${tk.length}  score history ${sh.length}`);

    // The widget answers. K12 has NO application stream (0 ApplicationManager rows for form
    // 114), but widget answers in v1 hang off the LEAD, not off an application, so they are
    // here regardless - 13,880 of them. This is the table the v1 lead download reads to
    // build its dynamic columns ("School & City" among them). Dropdown answers keep the real
    // value in fieldoptions, exactly as v1's own CSV exporter resolves them.
    const ansRows = await chunked(
      `select r."manageLeadId" lead_id, r."sectionFieldId" fid, sf.label,
              coalesce(nullif(btrim(r.value), ''), nullif(btrim(fo.value), ''), nullif(btrim(fo.label), ''),
                       nullif(btrim(r."fileAttachmentName"), '')) val,
              r."createdAt" at, r.id rid
         from "manageLeadResponses" r
         left join sectionfields sf on sf.id = r."sectionFieldId"
         left join fieldoptions fo on fo.id = r."fieldOptionId"
        where r."manageLeadId" = any($1::int[])`, 'widget answers');
    // One answer per (lead, field): a lead can submit the same widget again, so the LATEST
    // answer is the current one (616 pairs have 2, a few have up to 21).
    const answersByLead = new Map();
    for (const a of ansRows) {
      if (!a.val) continue;
      let m = answersByLead.get(a.lead_id);
      if (!m) { m = new Map(); answersByLead.set(a.lead_id, m); }
      const prev = m.get(a.fid);
      const newer = !prev || new Date(a.at) > new Date(prev.at) ||
        (new Date(a.at).getTime() === new Date(prev.at).getTime() && a.rid > prev.rid);
      if (newer) m.set(a.fid, { fid: a.fid, label: a.label, val: String(a.val).trim(), at: a.at, rid: a.rid });
    }
    log(`  widget answers ${ansRows.length} raw -> ${[...answersByLead.values()].reduce((n, m) => n + m.size, 0)} current, over ${answersByLead.size} lead(s)`);

    // Which of the destination columns actually exist in v2 right now. under_graduate.school_and_city
    // is the one to watch: v2's own K12 widget (widget 100, form 128) declares it, but the
    // column was never created, so v2 itself keeps that answer only in lead_payload.
    const ugAvailable = new Set((await v2.query(
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
      [K.V2.formTable])).rows.map(r => r.column_name));
    const ansDestCols = [...new Set(Object.values(K.ANSWERS).map(d => d.ug).filter(Boolean))];
    const ugMissing = ansDestCols.filter(c => !ugAvailable.has(c));
    log(`  answer destination columns in ${K.V2.formTable}: ${ansDestCols.filter(c => ugAvailable.has(c)).join(', ') || 'none'}`);
    if (ugMissing.length) {
      warn(`${K.V2.formTable} has no column ${ugMissing.join(', ')} - v2's own K12 widget declares `
        + `school_and_city but it was never created, so those answers are written to `
        + `lead_payload.formFields (where v2 itself keeps them) instead of a table column`);
    }

    // v1's tracker knows a stage-update time for 82 leads that have no stage timeline at
    // all (the colleague's script used this column as its only source). Take the LATEST of
    // the two, so neither source is lost.
    const trackerStageAt = new Map();
    for (const t of tk) if (t.lastLeadStageUpdated) trackerStageAt.set(t.leadId, t.lastLeadStageUpdated);

    // the last MAIN stage change per lead, for lead_stage_date (v2 stamps it on a stage change)
    const stageEventAt = new Map();
    for (const t of tl) {
      const title = t.eventType && t.eventType.title;
      if (title !== 'Changed_Lead_Stage' && title !== 'Stage Assigned') continue;
      const cur = stageEventAt.get(t.leadId);
      if (!cur || new Date(t.createdAt) > new Date(cur)) stageEventAt.set(t.leadId, t.createdAt);
    }

    // actors / authors
    const actorV1 = [...new Set([
      ...tl.map(t => Number(t.payload && t.payload.userId)).filter(n => Number.isFinite(n)),
      ...nt.map(n => n.userId).filter(Boolean),
      ...scope.map(l => l.reassignedBy).filter(Boolean),
    ])];
    const actorMap = await M.buildUserMap(v2, actorV1);
    log(`  v1 actors referenced ${actorV1.length}, resolved to a v2 user ${actorMap.size}`);

    // ----------------------------------------------------------------- 5. build the rows
    hr('5. building the v2 rows');
    const outLeads = [], outUg = [], outTagLinks = [], unknownEvents = new Map();
    const outDelta = [], outDeltaUg = [];       // the already-in-v2 pile
    const stageMiss = new Map();
    const unmappedAnswers = new Map();      // v1 field id -> how many leads (reported, and kept in the payload)
    const answerUse = new Map();            // "label -> destination" -> how many leads
    const noteUse = (k) => answerUse.set(k, (answerUse.get(k) || 0) + 1);
    const p1 = new Progress(scope.length || 1, 'v2_leads');
    for (const l of scope) {
      const cr = l.assignTo ? counsellorFor.get(l.assignTo) : null;
      if (l.leadStageId != null && !stage.has(l.leadStageId)) {
        stageMiss.set(l.leadStageId, (stageMiss.get(l.leadStageId) || 0) + 1);
      }
      // the lead's current widget answers, newest first so one destination keeps the newest
      const ans = answersByLead.get(l.id) ? [...answersByLead.get(l.id).values()] : [];
      ans.sort((a, b) => (new Date(b.at) - new Date(a.at)) || (b.rid - a.rid));
      const ugExtra = {}, formFields = {}, v1Answers = {}, leadFill = {};
      for (const a of ans) {
        const d = K.ANSWERS[a.fid];
        if (!d) {                                  // a v1 widget field nobody has mapped yet
          unmappedAnswers.set(a.fid + ' "' + (a.label || '?') + '"', (unmappedAnswers.get(a.fid + ' "' + (a.label || '?') + '"') || 0) + 1);
          v1Answers[a.label || ('v1 field ' + a.fid)] = a.val;
          continue;
        }
        if (d.carried) { noteUse(d.label + ' -> already in ' + d.carried); continue; }
        if (d.v1AnswersOnly) { v1Answers[d.label] = a.val; noteUse(d.label + ' -> lead_payload.__v1_answers (no v2 column)'); continue; }
        if (d.payload && formFields[d.payload] === undefined) {
          formFields[d.payload] = a.val;
          noteUse(d.label + ' -> lead_payload.formFields.' + d.payload);
        }
        if (d.ug) {
          if (ugAvailable.has(d.ug)) {
            if (ugExtra[d.ug] === undefined) { ugExtra[d.ug] = a.val; noteUse(d.label + ' -> ' + K.V2.formTable + '.' + d.ug); }
          } else if (!d.payload) {
            if (v1Answers[d.label] === undefined) { v1Answers[d.label] = a.val; noteUse(d.label + ' -> lead_payload.__v1_answers (' + d.ug + ' missing in v2)'); }
          }
        }
        if (d.lead && leadFill[d.lead] === undefined) leadFill[d.lead] = a.val;
      }
      // "School & City" also arrives as the v1 lead column `school` on the widgets that are
      // wired that way. The lead column is what the v1 CRM shows, so it wins; the answer
      // only fills in when it is empty.
      const schoolCol = trimOrNull(l.school);
      if (schoolCol !== null) {
        formFields[K.SCHOOL_AND_CITY.payloadKey] = schoolCol;
        if (ugAvailable.has(K.SCHOOL_AND_CITY.ugColumn)) ugExtra[K.SCHOOL_AND_CITY.ugColumn] = schoolCol;
        noteUse('manageLeads.school (School & City) -> lead_payload.formFields.' + K.SCHOOL_AND_CITY.payloadKey);
        if (ugAvailable.has(K.SCHOOL_AND_CITY.ugColumn)) {
          noteUse('manageLeads.school (School & City) -> ' + K.V2.formTable + '.' + K.SCHOOL_AND_CITY.ugColumn);
        }
      }

      const row = {
        org_id: K.V2.org, school_id: K.V2.school, program_id: K.V2.program,
        batch_id: K.V2.batch, round_id: K.V2.round, form_id: K.V2.form, lead_table_id: K.V2.leadTable,
        user_id: l.userId ? (stuByV1.get(l.userId) ?? null) : null,
        registered_name: l.registeredName, registered_email: l.registeredEmail, registered_mobile: l.registeredMobile,
        country_code: stripPlus(l.countryCode),
        status: 'active',
        lead_score: l.leadScore,
        lead_stage_id: l.leadStageId == null ? null : (stage.get(l.leadStageId) ?? null),
        lead_sub_stage_id: l.leadSubStageId == null ? null : (subStage.get(l.leadSubStageId) ?? null),
        previous_lead_stage: l.previousLeadStage == null ? null : (stage.get(l.previousLeadStage) ?? null),
        lead_stage_date: (() => {
          const cands = [stageEventAt.get(l.id), trackerStageAt.get(l.id)].filter(Boolean).map(d => new Date(d));
          if (!cands.length) return l.createdAt;
          const best = new Date(Math.max(...cands.map(d => d.getTime())));
          return best < new Date(l.createdAt) ? l.createdAt : best.toISOString();
        })(),
        counsellor_id: cr ? cr.id : null,
        is_mobile_verified: l.isMobileVerified ?? false,
        is_email_verified: l.isEmailVerified ?? false,
        alternate_email: l.alternateEmail, alternate_mobile_number: l.alternateMobileNumber,
        source: l.source, medium: l.medium, campaign: l.campaign,
        secondary_source: l.secondarySource, secondary_medium: l.secondaryMedium, secondary_campaign: l.secondaryCampaign,
        tertiary_source: l.tertiarySource, tertiary_medium: l.tertiaryMedium, tertiary_campaign: l.tertiaryCampaign,
        lead_origin: l.leadOrigin, lead_device: l.leadDevice, registered_device: l.registeredDevice,
        created_at: l.createdAt, updated_at: l.updatedAt, registered_on: l.registeredOn,
        is_payment_done: false, payment_status: l.paymentStatus || 'pending', payment_initiated: false,
        form_percentage_filled: 0,
        lead_payload: l.leadPayload,
        city: l.city, state: l.state, iso_code: l.isoCode, lead_country: l.leadCountry,
        grade: trimOrNull(l.grade),
        // v1 widget ids are NOT v2 widget ids: v1 78 is "UG TBM Widget", v2 78 is
        // "PGP Bharat" on school 27. Copying the number mislabels the lead, so leave it
        // NULL unless a real map exists. (The old migration copied it - see the note in
        // 10-k12-migration.md about 2,217 mislabelled school-18 rows.)
        widget_id: null,
        applicant_name: trimOrNull(l.registeredName),
        fb_lead_id: l.fbLeadId === null || l.fbLeadId === undefined ? null : String(l.fbLeadId),
        program_eligible: l.programEligible,
        reassigned_on: l.reassignedOn,
        reassigned_by: l.reassignedBy ? ((actorMap.get(l.reassignedBy) || {}).id ?? null) : null,
        crisp_chat_link: l.crispChatLink, chat_summary: l.chatSummary,
        is_chatbot_lead: l.isChatbotLead ?? false,
        application_form_initiated: false, application_form_submitted: false,
        is_edit_access_granted: false,
        type: l.userType === 'applicant' ? 'applicant' : 'lead',
        is_deleted: false,
        source_url: l.sourceUrl,
        lead_type: l.leadType || 'primary',
        is_enrolled: false, final_decision: 'NOT_ELIGIBLE',
        concat_smc: l.concatSMC,
        human_handoff: l.humanHandoff === null || l.humanHandoff === undefined ? null : String(l.humanHandoff),
        v1_lead_id: l.id, v1_application_id: null, v1_user_id: l.userId ?? null,
        is_inbound_lead: l.isInboundLead ?? false,
        test_lead: false,
        automation_tags: [],
        _v1: {
          assignTo: l.assignTo || null,
          counsellorPendingV1Id: cr && cr.pendingV1Id ? cr.pendingV1Id : null,
          studentV1Id: l.userId ?? null,
          stageId: l.leadStageId, subStageId: l.leadSubStageId, userType: l.userType,
        },
      };
      for (const [src, dst] of K.ATTRIBUTION_FIELDS) row[dst] = trimOrNull(l[src]);
      for (const c of K.QUESTION_FIELDS) row[c] = trimOrNull(l[c]);
      // A v2_leads column the v1 lead column left empty, but a widget answer knows
      // (grade: the lead column has 5,228 of 7,486, the answers cover 6,203).
      for (const [col, val] of Object.entries(leadFill)) {
        if (row[col] === null || row[col] === undefined || String(row[col]).trim() === '') {
          row[col] = val;
          noteUse('answer fills v2_leads.' + col);
        }
      }
      {
        const base = (l.leadPayload && typeof l.leadPayload === 'object' && !Array.isArray(l.leadPayload)) ? l.leadPayload : {};
        const add = {};
        if (K.STASH_LEGACY) {
          const legacy = {};
          for (const c of K.LEGACY_FIELDS) if (l[c] !== null && l[c] !== undefined && l[c] !== '') legacy[c] = l[c];
          // v1's primary triple. Identical to source/medium/campaign on 7,479 of 7,486 K12
          // leads, and v2 has no primary_* column, so only a real difference is kept.
          for (const [col, sameAs] of K.PRIMARY_FIELDS) {
            const v = trimOrNull(l[col]);
            if (v !== null && v !== trimOrNull(l[sameAs])) { legacy[col] = v; noteUse(col + ' differs from ' + sameAs + ' -> lead_payload.__legacy'); }
          }
          if (Object.keys(legacy).length) add.__legacy = legacy;
        }
        // Where v2's own widget keeps its form answers, so a migrated K12 lead and one
        // created by the widget today read the same way.
        if (Object.keys(formFields).length) {
          const baseFF = (base.formFields && typeof base.formFields === 'object' && !Array.isArray(base.formFields)) ? base.formFields : {};
          add.formFields = { ...baseFF, ...formFields };
        }
        // Any answer with no v2 column at all, under its v1 label - never dropped silently.
        if (Object.keys(v1Answers).length) add.__v1_answers = v1Answers;
        if (Object.keys(add).length) row.lead_payload = { ...base, ...add };
      }
      if (have.has(l.id)) { row.v2_lead_id = have.get(l.id); outDelta.push(row); } else outLeads.push(row);

      const ug = {
        org_id: K.V2.org, v1_lead_id: l.id, created_at: l.createdAt, updated_at: l.updatedAt,
        city: trimOrNull(l.city), state: trimOrNull(l.state), grade: trimOrNull(l.grade),
      };
      // the widget answers, but never over a value the v1 lead column already gave us
      for (const [col, val] of Object.entries(ugExtra)) {
        if (ug[col] === null || ug[col] === undefined || String(ug[col]).trim() === '') ug[col] = val;
      }
      if (Object.keys(ug).some(c => !['org_id', 'v1_lead_id', 'created_at', 'updated_at'].includes(c) && ug[c] !== null && ug[c] !== undefined)) {
        if (have.has(l.id)) { ug.v2_lead_id = have.get(l.id); outDeltaUg.push(ug); } else outUg.push(ug);
      }

      for (const raw of (l.tags || [])) {
        const nm = String(raw).trim();
        if (!nm) continue;
        const id = tagIdByName.get(nm.toLowerCase()) ?? null;
        const willCreate = outTagsCreate.some(t => t.name.toLowerCase() === nm.toLowerCase());
        if (id === null && !willCreate) continue;
        outTagLinks.push({ v1_lead_id: l.id, tag_name: nm, tag_id: id, org_id: K.V2.org, school_id: K.V2.school });
      }
      p1.tick();
    }
    p1.done();
    for (const [id, n] of stageMiss) {
      warn(`v1 stage ${id} has no v2 school-${K.V2.school} equivalent (it belongs to another organisation) - lead_stage_id NULL on ${n} lead(s)`);
    }
    hr('5a. where every widget answer went');
    [...answerUse.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => log(`    ${String(n).padStart(5)} lead(s)  ${k}`));
    if (!answerUse.size) log('    (no widget answers in scope)');
    for (const [k, n] of unmappedAnswers) {
      warn(`v1 widget field ${k} is not in ANSWERS (lib-k12.cjs) - kept in lead_payload.__v1_answers on ${n} lead(s)`);
    }
    // the union of under_graduate columns this export actually fills, for the importer
    const ugColumns = ['org_id', 'lead_id', 'v1_lead_id', 'created_at', 'updated_at',
      ...[...new Set([...outUg, ...outDeltaUg].flatMap(r => Object.keys(r)))]
        .filter(c => !['org_id', 'v1_lead_id', 'created_at', 'updated_at', 'v2_lead_id'].includes(c)).sort()];
    log(`  ${K.V2.formTable} columns written: ${ugColumns.join(', ')}`);
    log(`  v2_leads to INSERT ${outLeads.length}   under_graduate ${outUg.length}   lead_tags ${outTagLinks.length}`);
    log(`  already in v2 (delta candidates) ${outDelta.length}   their form rows ${outDeltaUg.length}`);
    log(`  applicants among them: ${outLeads.filter(r => r.type === 'applicant').length} (no application data exists in v1 for this form)`);

    // timelines
    const outTl = [];
    for (const t of tl) {
      const title = (t.eventType && t.eventType.title) || null;
      let ev;
      if (title && K.EXTRA_EVENT_TYPES[title]) ev = { event_type: K.EXTRA_EVENT_TYPES[title], known: true };
      else ev = M.toEventType(title);
      if (!ev.known) unknownEvents.set(title, (unknownEvents.get(title) || 0) + 1);
      const actorId = Number(t.payload && t.payload.userId);
      const actor = Number.isFinite(actorId) ? actorMap.get(actorId) : null;
      outTl.push({
        org_id: K.V2.org, school_id: K.V2.school,
        v1_lead_id: t.leadId, v1_timeline_id: t.id, lead_id: null,
        event_type: ev.event_type, title, description: t.message ?? null,
        metadata: t.payload ?? null,
        lead_stage_id: t.leadStageId == null ? null : (stage.get(t.leadStageId) ?? null),
        template_id: null,
        v1_counsellor_id: Number.isFinite(actorId) ? actorId : null,
        created_by: actor ? actor.id : null,
        created_at: t.createdAt,
        // timelines.updated_at is NOT NULL with no default
        updated_at: t.updatedAt || t.createdAt,
      });
    }
    for (const [title, n] of unknownEvents) warn(`timeline title "${title}" was not in any map - slugified instead (${n} row(s))`);
    log(`  timelines ${outTl.length}  (authored ${outTl.filter(r => r.created_by).length}, stage-linked ${outTl.filter(r => r.lead_stage_id).length})`);

    // notes
    const outNotes = [];
    for (const n of nt) {
      const a = n.userId ? actorMap.get(n.userId) : null;
      outNotes.push({
        org_id: K.V2.org, school_id: K.V2.school, v1_lead_id: n.leadId, v1_note_id: n.id,
        content: n.message === null || n.message === undefined ? null : String(n.message).trim(),
        admin_id: a ? a.id : null, v1_counsellor_id: n.userId ?? null,
        created_at: n.createdAt, updated_at: n.updatedAt ?? n.createdAt,
        _pendingAdminV1Id: a ? null : (n.userId ?? null),
      });
    }
    const noteNoAuthor = outNotes.filter(n => !n.admin_id && !K.COUNSELLOR_CREATE.includes(n._pendingAdminV1Id));
    if (noteNoAuthor.length) warn(`${noteNoAuthor.length} note(s) have an author with no v2 user and none is being created - notes.admin_id is NOT NULL, so the importer will hold them back`);
    log(`  notes ${outNotes.length} (resolved author ${outNotes.filter(n => n.admin_id).length}, pending created account ${outNotes.filter(n => !n.admin_id && n._pendingAdminV1Id).length})`);

    // activity trackers - column-for-column copy
    const TRK = ['applicationForm_start_date', 'payment_Initiated_date', 'payment_last_Initiated_date',
      'counsellor_first_activity_date', 'counsellor_last_activity_date', 'application_fee_paidOn',
      'application_last_activity_date', 'lastLeadStageUpdated', 'firstLeadStageUpdated', 'applicationFormSubmittedOn'];
    const seenTrk = new Set(), outTrk = [];
    for (const t of tk) {
      if (seenTrk.has(t.leadId)) { warn(`v1 lead ${t.leadId} has more than one tracker row - keeping the earliest (v2 has UNIQUE on v1_leadId)`); continue; }
      seenTrk.add(t.leadId);
      const row = { v1_leadId: t.leadId, v1_applicationId: t.applicationId ?? null, createdAt: t.createdAt, updatedAt: t.updatedAt };
      for (const c of TRK) row[c] = t[c] ?? null;
      outTrk.push(row);
    }
    log(`  activity trackers ${outTrk.length}`);

    // lead score history
    const scoreMaps = await M.buildScoreMaps(v1, v2);
    if (scoreMaps.disagree.length) warn(`score map disagrees with migrated rows: ${scoreMaps.disagree.slice(0, 3).join('; ')}`);
    const outScore = [], runTotal = new Map();
    for (const r of sh) {
      const before = runTotal.get(r.leadId) || 0;
      const delta = Number(r.score) || 0;
      const after = before + delta;
      runTotal.set(r.leadId, after);
      const cid = scoreMaps.criteria.get(r.criteriaId), mid = scoreMaps.mapping.get(r.mappingId);
      if (cid === undefined) warn(`score history ${r.id}: v1 criteriaId ${r.criteriaId} has no v2 equivalent`);
      if (mid === undefined) warn(`score history ${r.id}: v1 mappingId ${r.mappingId} has no v2 equivalent`);
      outScore.push({
        v1_lead_id: r.leadId, v1_history_id: r.id, dedupeKey: `v1_history:${r.id}`,
        criteriaId: cid ?? null, mappingId: mid ?? null, mappingValue: delta, delta,
        scoreBefore: before, leadScore: after, schoolId: K.V2.school, source: 'v1_history',
        createdBy: null, createdAt: r.createdAt, occurredAt: r.createdAt,
        metadata: { v1LeadId: r.leadId, v1HistoryId: r.id, v1CreatedBy: r.createdBy, v1CriteriaId: r.criteriaId, v1MappingId: r.mappingId },
      });
    }
    for (const [v1LeadId, total] of runTotal) {
      const lead = outLeads.find(l => l.v1_lead_id === v1LeadId);
      if (lead && Number(lead.lead_score ?? 0) !== total) warn(`lead ${v1LeadId}: score history sums to ${total} but lead_score is ${lead.lead_score}`);
    }
    log(`  lead score history ${outScore.length} over ${runTotal.size} lead(s)`);

    // ----------------------------------------------------------------- 6. assertions
    hr('6. assertions');
    let errs = 0;
    const must = (c, m) => { if (!c) { errs++; log('  ERROR  ' + m); } };
    for (const r of outLeads) {
      must(r.org_id === K.V2.org && r.school_id === K.V2.school, `lead ${r.v1_lead_id} is not org/school scoped`);
      must(r.form_id === K.V2.form && r.program_id === K.V2.program, `lead ${r.v1_lead_id} has the wrong form/program`);
      must(r.batch_id === K.V2.batch && r.round_id === K.V2.round, `lead ${r.v1_lead_id} has the wrong batch/round`);
      must(r.is_deleted === false, `lead ${r.v1_lead_id} is marked deleted - deleted leads are out of scope`);
      must(r.v1_lead_id != null, 'a lead row has no v1_lead_id');
      if (!r.registered_name) warn(`v1 lead ${r.v1_lead_id} has no registered_name`);
    }
    const leadSet = new Set([...outLeads, ...outDelta].map(r => r.v1_lead_id));
    for (const r of outDelta) must(r.v2_lead_id > 0, `delta row for v1 lead ${r.v1_lead_id} has no v2 lead id`);
    for (const r of outTl) must(leadSet.has(r.v1_lead_id), `timeline ${r.v1_timeline_id} points at lead ${r.v1_lead_id}, which is not in this export`);
    for (const r of outNotes) must(leadSet.has(r.v1_lead_id), `note ${r.v1_note_id} points at a lead not in this export`);
    for (const r of outTrk) must(leadSet.has(r.v1_leadId), `tracker for lead ${r.v1_leadId} is not in this export`);
    for (const r of outScore) must(leadSet.has(r.v1_lead_id), `score history ${r.v1_history_id} is not in this export`);
    for (const r of outUg) must(leadSet.has(r.v1_lead_id), `under_graduate row for lead ${r.v1_lead_id} is not in this export`);
    must(new Set(outUg.map(r => r.v1_lead_id)).size === outUg.length, 'duplicate under_graduate rows for one lead');
    must(new Set([...outLeads, ...outDelta].map(r => r.v1_lead_id)).size === outLeads.length + outDelta.length,
      'a v1 lead is in both the insert pile and the delta pile');
    must(new Set(outTrk.map(r => r.v1_leadId)).size === outTrk.length, 'duplicate tracker rows for one lead');
    must(new Set(outTl.map(r => r.v1_timeline_id)).size === outTl.length, 'duplicate v1_timeline_id in the export');
    log(errs ? `  ${errs} ASSERTION(S) FAILED` : `  all assertions passed (${outLeads.length} leads and their satellites are in scope and consistent)`);
    if (errs) throw new Error('export assertions failed - nothing written');

    // ----------------------------------------------------------------- 7. files
    hr('7. writing files');
    const files = {};
    const writeNd = (name, rows) => {
      const f = path.join(DIR, name);
      fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
      files[name] = { rows: rows.length, sha256: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') };
      log(`  ${name.padEnd(28)} ${String(rows.length).padStart(7)} rows`);
    };
    writeNd('staff.ndjson', outStaff);
    writeNd('students.ndjson', outStudents);
    writeNd('tags_create.ndjson', outTagsCreate);
    writeNd('leads.ndjson', outLeads);
    writeNd('delta_leads.ndjson', outDelta);
    writeNd('delta_under_graduate.ndjson', outDeltaUg);
    writeNd('under_graduate.ndjson', outUg);
    writeNd('lead_tags.ndjson', outTagLinks);
    writeNd('timelines.ndjson', outTl);
    writeNd('notes.ndjson', outNotes);
    writeNd('activity_trackers.ndjson', outTrk);
    writeNd('lead_score_history.ndjson', outScore);

    // the 244 reassigned leads, for the team to redistribute in the CRM
    const reassigned = [...outLeads, ...outDelta].filter(r => {
      const u = r._v1.assignTo ? staffByUuid.get(r._v1.assignTo) : null;
      return u && K.COUNSELLOR_REASSIGN[u.id];
    });
    const csv = ['v1_lead_id,registered_name,registered_email,registered_mobile,v1_counsellor,assigned_to_v2_user,created_at']
      .concat(reassigned.map(r => {
        const u = staffByUuid.get(r._v1.assignTo);
        const q = v => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
        return [r.v1_lead_id, q(r.registered_name), q(r.registered_email), q(r.registered_mobile), q(u.email), r.counsellor_id, q(r.created_at)].join(',');
      }));
    fs.writeFileSync(path.join(DIR, 'reassigned_leads.csv'), csv.join('\n') + '\n');
    log(`  reassigned_leads.csv         ${reassigned.length} rows (for your team to redistribute)`);

    const manifest = {
      generatedAt: new Date().toISOString(), runId: RUN_ID, scope: { v1: K.V1, v2: K.V2 },
      decisions: { counsellorReassign: K.COUNSELLOR_REASSIGN, counsellorCreate: K.COUNSELLOR_CREATE, tagsCreate: K.TAGS_CREATE, deletedLeads: 'skipped' },
      counts: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.rows])),
      ugColumns,
      answerDestinations: Object.fromEntries([...answerUse.entries()].sort((a, b) => b[1] - a[1])),
      unmappedAnswers: Object.fromEntries(unmappedAnswers),
      files, warnings,
    };
    fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
    log('  manifest.json');

    hr('K12 EXPORT COMPLETE');
    log(`  run folder : ${DIR}`);
    log(`  leads ${outLeads.length} (+ ${outDelta.length} already in v2)  under_graduate ${outUg.length}  timelines ${outTl.length}  notes ${outNotes.length}  ` +
        `tags ${outTagLinks.length}  trackers ${outTrk.length}  score ${outScore.length}  staff ${outStaff.length}  students ${outStudents.length}`);
    log(`  warnings ${warnings.length}`);
    log('  Nothing was written to any database.');
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('EXPORT FAILED:', e.message); process.exit(1); });
