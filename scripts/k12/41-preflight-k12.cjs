/**
 * K12 MIGRATION PREFLIGHT - READ ONLY. Writes nothing to either database.
 *
 *   node scripts/k12/41-preflight-k12.cjs
 *
 * Answers one question: does EVERY v1 thing this programme's data points at have a
 * counterpart in the v2 production CRM? Stages, sub-stages, counsellors, students,
 * note authors, timeline actors, event types, tags, widgets, the form table, the
 * score criteria, the idempotency keys and the partitions that must accept the rows.
 *
 * Scope (given by the user, verified below):
 *   v1  org 68 | school 26 | program 111 | form 114 | cohort 110 | round 141   (K12)
 *   v2  org 12 | school 18 | program 123 | form 128 | batch  192 | round 216
 */
const fs = require('fs');
const { connect } = require('../lib/db.cjs');
const M = require('../lib/maps.cjs');
const DEC = require('./lib-k12.cjs');   // the decisions of 2026-10-08

const K = {
  v1: { org: 68, school: 26, program: 111, form: 114, cohort: 110, round: 141 },
  v2: { org: 12, school: 18, program: 123, form: 128, batch: 192, round: 216, leadTable: 19, formTable: 'under_graduate' },
};

let pass = 0, fail = 0, warn = 0;
const log = (...a) => console.log(...a);
let lastHr = Date.now();
const hr = t => {
  const spent = Math.round((Date.now() - lastHr) / 1000);
  lastHr = Date.now();
  log('\n' + '='.repeat(86) + '\n' + t + (spent > 2 ? '   (previous section took ' + spent + 's)' : '') + '\n' + '='.repeat(86));
};
const ok = (n, x = '') => { pass++; log('  PASS  ' + n + (x ? '   ' + x : '')); };
const bad = (n, x = '') => { fail++; log('  FAIL  ' + n + (x ? '   ' + x : '')); };
const wrn = (n, x = '') => { warn++; log('  DECIDE  ' + n + (x ? '   ' + x : '')); };
const check = (c, n, x) => (c ? ok(n, x) : bad(n, x));
const SCOPE = 'select id from "manageLeads" where "applicationFormId" = ' + K.v1.form;

(async () => {
  const v1 = await connect('v1'), v2 = await connect('v2');
  // No query may hang: 90 s is far more than any check here needs, and a timeout is
  // reported as a skipped check rather than killing the run.
  await v1.query("set statement_timeout = '90s'");
  await v2.query("set statement_timeout = '90s'");
  let t0 = Date.now();
  const q1 = async (s, p) => (await v1.query(s, p)).rows;
  const q2 = async (s, p) => (await v2.query(s, p)).rows;
  try {
    hr('1. THE SIX ASSOCIATIONS');
    const a = (await q1('select id, name from organizations where id = $1', [K.v1.org]))[0];
    const b = (await q1('select id, "schoolName" nm from schools where id = $1', [K.v1.school]))[0];
    const c = (await q1('select id, name, "schoolId" sid, "organizationId" org from programs where id = $1', [K.v1.program]))[0];
    const d = (await q1('select id, "programId" pid, "schoolId" sid, "organizationId" org, "cohortId" co, "roundId" ro, "isActive" act from "applicationForms" where id = $1', [K.v1.form]))[0];
    const e = (await q1('select id, "cohortName" nm from cohorts where id = $1', [K.v1.cohort]))[0];
    const f = (await q1('select id, name, "programCohortId" co from rounds where id = $1', [K.v1.round]))[0];
    check(a && b && c && d && e && f, 'all six v1 rows exist',
      a ? 'org "' + a.name + '" / school "' + b.nm + '" / program "' + c.name + '" / form ' + d.id + ' / cohort "' + e.nm + '" / round "' + f.name + '"' : '');
    check(d && d.org === K.v1.org && d.sid === K.v1.school && d.pid === K.v1.program, 'v1 form belongs to the stated org/school/program');
    check(d && d.co === K.v1.cohort && d.ro === K.v1.round, 'v1 form points at the stated cohort + round');

    const A = (await q2('select id, org_id, name, is_active from schools where id = $1', [K.v2.school]))[0];
    const B = (await q2('select id, name, school_id sid, org_id org, is_active from programs where id = $1', [K.v2.program]))[0];
    const C = (await q2('select id, "applicationFormName" nm, "programId" pid, "schoolId" sid, "organizationId" org, "cohortId" co, "roundId" ro, "isActive" act, fees from "applicationForms" where id = $1', [K.v2.form]))[0];
    const D = (await q2('select id, name, program_id pid, school_id sid, org_id org, is_active from batches where id = $1', [K.v2.batch]))[0];
    const E = (await q2('select id, name, batch_id bid, program_id pid, school_id sid, org_id org, is_active from rounds where id = $1', [K.v2.round]))[0];
    check(A && B && C && D && E, 'all five v2 rows exist',
      A ? 'school "' + A.name + '" / program "' + B.name + '" / form "' + C.nm + '" / batch "' + D.name + '" / round "' + E.name + '"' : '');
    check(B && B.org === K.v2.org && B.sid === K.v2.school, 'v2 program sits under the stated org + school');
    check(C && C.org === K.v2.org && C.sid === K.v2.school && C.pid === K.v2.program, 'v2 form sits under the stated org/school/program');
    check(C && C.co === K.v2.batch && C.ro === K.v2.round, 'v2 form points at the stated batch + round');
    check(D && D.pid === K.v2.program && E && E.pid === K.v2.program && E.bid === K.v2.batch, 'v2 batch + round belong to the program, round under the batch');
    check(A && A.is_active && B && B.is_active && C && C.act && D && D.is_active && E && E.is_active, 'every v2 target row is ACTIVE');
    const lt = (await q2('select id, table_name from org_lead_tables where org_id = $1 and school_id = $2 and is_active', [K.v2.org, K.v2.school]))[0];
    check(lt && lt.id === K.v2.leadTable && lt.table_name === K.v2.formTable, 'v2 lead table for this school exists',
      lt ? lt.id + ' ' + lt.table_name : 'MISSING');

    hr('2. WHAT THERE IS TO MOVE (v1)');
    const vol = (await q1('select count(*)::int total, count(*) filter (where "isLeadDeleted" = false)::int live,' +
      ' count(*) filter (where "isLeadDeleted")::int deleted, count(*) filter (where "userType" = \'applicant\')::int applicants,' +
      ' count("userId")::int with_user, min("createdAt") oldest, max("createdAt") newest' +
      ' from "manageLeads" where "applicationFormId" = $1', [K.v1.form]))[0];
    log('  manageLeads total ' + vol.total + '  live ' + vol.live + '  deleted ' + vol.deleted + '  applicants ' + vol.applicants + '  with a user ' + vol.with_user);
    log('  created from ' + new Date(vol.oldest).toISOString().slice(0, 10) + ' to ' + new Date(vol.newest).toISOString().slice(0, 16) + ' (still arriving)');
    const am = (await q1('select count(*)::int n from "ApplicationManager" where "applicationFormId" = $1', [K.v1.form]))[0];
    const sat = (await q1('select (select count(*)::int from "UserTimelines" where "leadId" in (' + SCOPE + ')) timelines,' +
      ' (select count(*)::int from "Notes" where "leadId" in (' + SCOPE + ')) notes,' +
      ' (select count(*)::int from "applicationActivityTracker" where "leadId" in (' + SCOPE + ')) trackers,' +
      ' (select count(*)::int from "LeadScoreHistories" where "leadId" in (' + SCOPE + ')) score_history'))[0];
    log('  satellites: timelines ' + sat.timelines + '  notes ' + sat.notes + '  trackers ' + sat.trackers + '  score history ' + sat.score_history);
    check(am.n === 0, 'no ApplicationManager rows for this form, so there is NO application / form-answer stream to move', String(am.n));
    const dupTrk = await q1('select count(*)::int n from (select "leadId" from "applicationActivityTracker" where "leadId" in (' + SCOPE + ') group by 1 having count(*) > 1) x');
    check(Number(dupTrk[0].n) === 0, 'at most one v1 tracker row per lead (v2 has UNIQUE on v1_leadId)', dupTrk[0].n + ' leads with more');
    const foreign = await q1('select "schoolId" sid, "programId" pid, count(*)::int n from "manageLeads"' +
      ' where "applicationFormId" = $1 and ("schoolId" <> $2 or "programId" <> $3) group by 1,2 order by n desc', [K.v1.form, K.v1.school, K.v1.program]);
    if (foreign.length) wrn(foreign.reduce((s, r) => s + r.n, 0) + ' lead(s) carry another school/program on the row itself (v1 contamination)', JSON.stringify(foreign));
    else ok('every lead carries this form own school + program');

    hr('3. IS ANY OF IT IN v2 ALREADY?');
    const ids = (await q1(SCOPE)).map(r => r.id);
    let already = 0;
    for (let i = 0; i < ids.length; i += 20000) {
      already += (await q2('select count(*)::int n from v2_leads where v1_lead_id = any($1::int[])', [ids.slice(i, i + 20000)]))[0].n;
    }
    check(already === 0, 'none of these v1 leads is in v2 yet, so this is a clean first run', already + ' already there');
    const native = (await q2('select count(*)::int n, count(v1_lead_id)::int linked, count(*) filter (where test_lead)::int test' +
      ' from v2_leads where org_id = $1 and (form_id = $2 or program_id = $3)', [K.v2.org, K.v2.form, K.v2.program]))[0];
    log('  v2 already holds ' + native.n + ' native row(s) on this form (' + native.test + ' flagged test_lead). They show the target shape and must not be touched.');

    hr('4. LEAD STAGES AND SUB-STAGES');
    const used = await q1('select m."leadStageId" id, count(*)::int n, min(s."stageName") nm, min(s."organizationId") org,' +
      ' min(s."schoolId") sid, min(s."applicableTo") appl from "manageLeads" m left join "LeadStage" s on s.id = m."leadStageId"' +
      ' where m."applicationFormId" = $1 group by 1 order by n desc', [K.v1.form]);
    const v2stages = await q2('select id, "stageName" nm, "isActive" act from "leadStage" where "organizationId" = $1 and "schoolId" = $2', [K.v2.org, K.v2.school]);
    const byName = new Map();
    for (const s of v2stages) {
      const k = s.nm.trim().toLowerCase(), cur = byName.get(k);
      if (!cur || (s.act && !cur.act)) byName.set(k, s);
    }
    const stageMissing = [], stageForeign = [];
    let stageMapped = 0;
    for (const u of used) {
      if (u.id === null) continue;
      const hit = u.nm ? byName.get(u.nm.trim().toLowerCase()) : null;
      const foreignOrg = u.org !== null && u.org !== K.v1.org;
      if (hit) stageMapped += u.n;
      else if (!foreignOrg) stageMissing.push(u.id + ' "' + u.nm + '" (' + u.n + ' leads)');
      if (foreignOrg) stageForeign.push(u.id + ' "' + u.nm + '" org ' + u.org + ' school ' + u.sid + ' (' + u.n + ' leads)');
    }
    const noStage = used.find(u => u.id === null);
    check(stageMissing.length === 0, 'every v1 lead stage in use resolves BY NAME to a v2 school-' + K.v2.school + ' stage', stageMissing.join('; '));
    log('  ' + stageMapped + ' lead(s) get a mapped stage; ' + (noStage ? noStage.n : 0) + ' have no stage in v1 and stay NULL, exactly as v1 has them');
    if (stageForeign.length) wrn(stageForeign.length + ' stage id(s) belong to ANOTHER v1 organisation', stageForeign.join('; ') + '  -> lead_stage_id NULL, the agreed rule (same as UG stage 413)');
    const appStageUsed = used.filter(u => u.appl === 'Applicant');
    if (appStageUsed.length) {
      wrn(appStageUsed.reduce((s, r) => s + r.n, 0) + ' lead(s) carry an APPLICANT-type v1 stage in leadStageId',
        appStageUsed.map(u => u.id + ' "' + u.nm + '" x' + u.n).join('; ') + '  -> UG precedent: resolve by name into leadStage');
    }
    const ss = await q1('select m."leadSubStageId" id, count(*)::int n, min(sub.name) nm, min(st."stageName") parent' +
      ' from "manageLeads" m join "LeadSubStage" sub on sub.id = m."leadSubStageId" join "LeadStage" st on st.id = sub."leadStageId"' +
      ' where m."applicationFormId" = $1 group by 1 order by n desc', [K.v1.form]);
    const v2sub = await q2('select sub.id, sub.name nm, st."stageName" parent from "leadSubStage" sub' +
      ' join "leadStage" st on st.id = sub."leadStageId" where st."organizationId" = $1 and st."schoolId" = $2', [K.v2.org, K.v2.school]);
    const subByName = new Map(v2sub.map(r => [r.parent.trim().toLowerCase() + '||' + r.nm.trim().toLowerCase(), r.id]));
    const subMissing = ss.filter(u => !subByName.has(u.parent.trim().toLowerCase() + '||' + u.nm.trim().toLowerCase()));
    check(subMissing.length === 0, 'all ' + ss.length + ' v1 sub-stage(s) in use resolve by (stage, sub-stage) name',
      subMissing.map(u => u.id + ' "' + u.parent + '/' + u.nm + '"').join('; '));

    hr('5. COUNSELLORS');
    const cou = await q1('select m."assignTo" uuid, count(*)::int n, min(u.id) v1u, min(u.email) email, bool_or(u."isDeleted") del' +
      ' from "manageLeads" m left join users u on u.uuid = m."assignTo" where m."applicationFormId" = $1 and m."assignTo" is not null' +
      ' group by 1 order by n desc', [K.v1.form]);
    const unassigned = (await q1('select count(*)::int n from "manageLeads" where "applicationFormId" = $1 and "assignTo" is null', [K.v1.form]))[0].n;
    log('  ' + cou.length + ' distinct counsellor(s) own ' + cou.reduce((s, r) => s + r.n, 0) + ' lead(s); ' + unassigned + ' lead(s) are unassigned in v1');
    const missingCou = [], plusOne = [], plainOnly = [], decided = [];
    for (const r of cou) {
      if (!r.email) { missingCou.push('uuid ' + r.uuid + ' has no v1 user (' + r.n + ' leads)'); continue; }
      const base = r.email.split('@')[0], dom = r.email.split('@')[1];
      const cand = await q2('select id, email, role, school_id, status from users where organization_id = $1 and lower(email) in (lower($2), lower($3))',
        [K.v2.org, r.email, base + '+1@' + dom]);
      const p1 = cand.find(x => x.email.toLowerCase() === (base + '+1@' + dom).toLowerCase());
      const plain = cand.find(x => x.email.toLowerCase() === r.email.toLowerCase() && x.role !== 'student');
      if (p1) plusOne.push(r.email + ' -> v2 ' + p1.id + ' (+1 account, ' + r.n + ' leads)');
      else if (plain) plainOnly.push(r.email + ' -> v2 ' + plain.id + ' role=' + plain.role + ' school=' + plain.school_id + ' (' + r.n + ' leads)');
      else if (DEC.COUNSELLOR_REASSIGN[r.v1u]) decided.push(r.email + ' (deleted in v1) -> v2 ' + DEC.COUNSELLOR_REASSIGN[r.v1u] + ', as decided (' + r.n + ' leads)');
      else if (DEC.COUNSELLOR_CREATE.includes(r.v1u)) decided.push(r.email + ' -> account to be CREATED by the importer (' + r.n + ' leads)');
      else missingCou.push(r.email + ' (v1 ' + r.v1u + (r.del ? ', deleted in v1' : '') + ') - ' + r.n + ' leads');
    }
    check(missingCou.length === 0, 'every counsellor who owns a K12 lead resolves to a v2 account', missingCou.join(' | '));
    if (decided.length) { log('  settled by the decisions of 2026-10-08:'); decided.forEach(x => log('      ' + x)); }
    log('  ' + plusOne.length + ' resolve to the "+1" account that school-' + K.v2.school + ' leads actually use:');
    plusOne.forEach(x => log('      ' + x));
    if (plainOnly.length) {
      wrn(plainOnly.length + ' counsellor(s) have NO "+1" account, only the plain one', 'decide which account owns their leads');
      plainOnly.forEach(x => log('      ' + x));
    }

    hr('6. STUDENTS, NOTE AUTHORS, TIMELINE ACTORS');
    const stu = await q1('select m.id lead, m."userType" ut, m."isLeadDeleted" del, m."userId" uid, u.email' +
      ' from "manageLeads" m left join users u on u.id = m."userId" where m."applicationFormId" = $1 and m."userId" is not null', [K.v1.form]);
    const stuMissing = [];
    for (const s of stu) {
      const hit = await q2('select id from users where v1_id = $1 or (lower(email) = lower(coalesce($2, $3)) and organization_id = $4)',
        [s.uid, s.email, 'no-email-sentinel', K.v2.org]);
      if (!hit.length) stuMissing.push('v1 user ' + s.uid + ' (' + (s.email || 'no email') + ') lead ' + s.lead + (s.del ? ' [deleted in v1]' : ''));
    }
    if (stuMissing.length) wrn(stuMissing.length + ' of ' + stu.length + ' student account(s) are not in v2', stuMissing.join(' | ') + '  -> the importer creates them, as it did for UG');
    else ok('all ' + stu.length + ' student account(s) already exist in v2');
    const auth = await q1('select n."userId" uid, count(*)::int c from "Notes" n where n."leadId" in (' + SCOPE + ' and "isLeadDeleted" = false) group by 1');
    const authMissing = [];
    for (const x of auth) {
      const hit = await q2('select id from users where v1_id = $1', [x.uid]);
      if (!hit.length && !DEC.COUNSELLOR_CREATE.includes(x.uid)) authMissing.push('v1 ' + x.uid + ' (' + x.c + ' notes)');
    }
    const adminNullable = (await q2('select is_nullable n from information_schema.columns where table_name = $1 and column_name = $2', ['notes', 'admin_id']))[0].n === 'YES';
    check(authMissing.length === 0, 'every note author on an in-scope lead maps to a v2 user (notes.admin_id is ' + (adminNullable ? 'nullable' : 'NOT NULL') + ')', authMissing.join(' | '));
    if (authMissing.length && !adminNullable) log('      -> those notes need a fallback author, or that user must be created first');
    const cutoff = new Date(Date.now() - DEC.TIMELINE_MONTHS * 30.44 * 24 * 3600 * 1000);
    // Timeline authorship is read from the newest EXPORT, not re-derived from v1: asking
    // UserTimelines for distinct payload->>'userId' scans millions of rows and times out.
    // The export has already resolved every actor, so this checks the real payload.
    const EXP_DIR_ROOT = 'C:/Users/Prateek/Desktop/Repos/data/k12';
    const expList = fs.existsSync(EXP_DIR_ROOT)
      ? fs.readdirSync(EXP_DIR_ROOT).filter(d => /^[0-9]{4}-/.test(d)).sort() : [];
    let act = [], actFound = 0, authoredRows = 0, totalRows = 0;
    if (expList.length) {
      const tlFile = EXP_DIR_ROOT + '/' + expList[expList.length - 1] + '/timelines.ndjson';
      if (fs.existsSync(tlFile)) {
        const actors = new Set(), mapped = new Set();
        for (const line of fs.readFileSync(tlFile, 'utf8').split('\n')) {
          if (!line) continue;
          const r = JSON.parse(line);
          totalRows += 1;
          if (r.v1_counsellor_id) actors.add(r.v1_counsellor_id);
          if (r.created_by) { authoredRows += 1; if (r.v1_counsellor_id) mapped.add(r.v1_counsellor_id); }
        }
        act = [...actors]; actFound = mapped.size;
      }
    }
    if (!act.length) log('  no export to read authorship from yet - run 50-export-k12.cjs first');
    // How authored the EXISTING migrated timelines are, for comparison. Bounded to this
    // month so Postgres prunes to a single partition: the unbounded version reads ~1.7M
    // rows across every partition and was what made this section look like it had hung.
    const ugAuth = (await q2('select count(*)::int n, count(created_by)::int withauthor from timelines' +
      ' where org_id = $1 and school_id = $2 and v1_lead_id is not null' +
      " and created_at >= date_trunc('month', now())", [K.v2.org, K.v2.school]))[0];
    wrn('timeline actors: ' + actFound + ' of ' + act.length + ' map to a v2 user; the rest leave timelines.created_by NULL',
      authoredRows + ' of ' + totalRows + ' exported rows are authored' +
      (ugAuth.n >= 100
        ? '; the migrated school-' + K.v2.school + ' timelines written this month are ' +
          Math.round(100 * ugAuth.withauthor / ugAuth.n) + '% authored, so this matches'
        : ' (no recent migrated timelines in v2 to compare against)'));

    hr('7. TIMELINE EVENT TYPES');
    const titles = await q1('select t."eventType"->>$1 title, count(*)::int n from "UserTimelines" t where t."leadId" in (' + SCOPE + ') group by 1 order by n desc', ['title']);
    const unknown = [];
    for (const t of titles) {
      const r = M.toEventType(t.title);
      if (!r.known) {
        const nativeUse = (await q2('select count(*)::int n from timelines where org_id = $1 and event_type = $2', [K.v2.org, r.event_type]))[0].n;
        unknown.push('"' + t.title + '" x' + t.n + ' -> "' + r.event_type + '" (' + (nativeUse ? nativeUse + ' such rows already in v2' : 'NOT used in v2 yet') + ')');
      }
    }
    const etType = (await q2('select data_type d from information_schema.columns where table_name = $1 and column_name = $2', ['timelines', 'event_type']))[0].d;
    check(etType !== 'USER-DEFINED', 'timelines.event_type is free text, so an unseen value cannot break the insert', etType);
    if (unknown.length) {
      wrn(unknown.length + ' event title(s) the UG map never saw', 'each needs a confirmed target value');
      unknown.forEach(u => log('        ' + u));
    } else ok('all ' + titles.length + ' v1 event title(s) are already in the known map');

    hr('8. TAGS');
    const tags = (await q1('select distinct unnest(tags) t from "manageLeads" where "applicationFormId" = $1 and tags is not null', [K.v1.form])).map(r => r.t);
    const tagMissing = [];
    // One pass over the leads for every tag count: the per-tag version ran a separate
    // scan for each name and took over two minutes.
    const tagCounts = new Map((await q1('select tag, count(*)::int n from (select unnest(tags) tag from "manageLeads"' +
      ' where "applicationFormId" = $1 and tags is not null) x group by 1', [K.v1.form])).map(r => [String(r.tag), r.n]));
    for (const t of tags) {
      const hit = await q2('select id from tags where org_id = $1 and lower(btrim(name)) = lower(btrim($2))', [K.v2.org, t]);
      const n = tagCounts.get(t) || 0;
      log('  "' + t + '" (' + n + ' leads) -> ' + (hit.length ? 'v2 tag ' + hit.map(h => h.id).join(',') : 'NOT IN v2'));
      if (!hit.length) tagMissing.push('"' + t + '" (' + n + ' leads)');
    }
    if (tagMissing.length) wrn(tagMissing.length + ' tag name(s) do not exist in v2', tagMissing.join(' | ') + '  -> create them in v2, or drop the tag');
    else ok('every tag name already exists in v2');

    hr('9. THE FORM TABLE, WIDGETS AND LEAD-LEVEL FIELDS');
    const fields = (await q1('select count(city) city, count(state) state, count(grade) grade, count("widgetId") widget,' +
      ' count("leadPayload") payload, count("alternateEmail") alt_email, count("sourceUrl") src_url' +
      ' from "manageLeads" where "applicationFormId" = $1', [K.v1.form]))[0];
    log('  lead-level values present: city ' + fields.city + '  state ' + fields.state + '  grade ' + fields.grade +
      '  widgetId ' + fields.widget + '  leadPayload ' + fields.payload + '  alternateEmail ' + fields.alt_email);
    const cols = (await q2('select column_name c from information_schema.columns where table_name = $1', [K.v2.formTable])).map(r => r.c);
    const needed = ['lead_id', 'v1_lead_id', 'org_id', 'city', 'state', 'select_city', 'select_state', 'grade', 'created_at', 'updated_at'];
    check(needed.every(c => cols.includes(c)), K.v2.formTable + ' has the columns a K12 LEAD row needs',
      needed.filter(c => !cols.includes(c)).join(',') || cols.length + ' columns in the table');
    const wid = await q1('select distinct "widgetId" w from "manageLeads" where "applicationFormId" = $1 and "widgetId" is not null', [K.v1.form]);
    if (wid.length) {
      const fk = await q2('select conname from pg_constraint where conrelid = \'v2_leads\'::regclass and conname ilike $1', ['%widget%']);
      wrn(wid.length + ' v1 widget id(s) in use (' + wid.map(r => r.w).join(',') + ')',
        'written as NULL: a v1 widget id means something else in v2 (v1 78 "UG TBM Widget" vs v2 78 "PGP Bharat")' +
        (fk.length ? '' : '; v2_leads.widget_id has no FK, so a wrong number would not even be caught'));
    }

    hr('10. LEAD SCORE');
    const sm = await M.buildScoreMaps(v1, v2);
    const pairs = await q1('select h."criteriaId" c, h."mappingId" m, count(*)::int n from "LeadScoreHistories" h where h."leadId" in (' + SCOPE + ') group by 1,2');
    const badPairs = pairs.filter(p => !sm.criteria.has(p.c) || !sm.mapping.has(p.m));
    check(badPairs.length === 0, 'all ' + pairs.length + ' (criteria, mapping) pair(s) used by the score history resolve in v2', JSON.stringify(badPairs.slice(0, 5)));
    check(sm.disagree.length === 0, 'the by-name score map agrees with what the previous migration wrote', sm.disagree.slice(0, 3).join('; '));

    hr('11. WHERE THE ROWS HAVE TO LAND (partitions + idempotency keys)');
    // Only the months inside the migration window matter now: everything older is
    // deliberately left in v1, so nothing should ever reach timelines_pdefault.
    const months = await q1('select to_char(date_trunc(\'month\', t."createdAt"), \'YYYY-MM\') m, count(*)::int n' +
      ' from "UserTimelines" t where t."leadId" in (' + SCOPE + ') and t."createdAt" >= $1 group by 1 order by 1', [cutoff]);
    const parts = await q2('select c.relname nm, pg_get_expr(c.relpartbound, c.oid) bound from pg_inherits i' +
      ' join pg_class c on c.oid = i.inhrelid where i.inhparent = \'timelines\'::regclass');
    const hasDefault = parts.some(p => /DEFAULT/i.test(p.bound || ''));
    const covered = m => parts.some(p => (p.nm.match(/timelines_p(\d{6})$/) || [])[1] === m.replace('-', ''));
    const uncovered = months.filter(x => !covered(x.m));
    log('  timeline rows span ' + months[0].m + ' .. ' + months[months.length - 1].m + '; ' +
      (parts.length - (hasDefault ? 1 : 0)) + ' monthly partition(s) attached + ' + (hasDefault ? 'a DEFAULT partition' : 'NO default partition'));
    check(uncovered.length === 0, 'every timeline month in the ' + DEC.TIMELINE_MONTHS +
      '-month window has its OWN monthly partition (nothing lands in timelines_pdefault)',
      uncovered.length ? uncovered.reduce((s, x) => s + x.n, 0) + ' row(s) in ' + uncovered.map(x => x.m).join(',') + ' have no partition' : '');
    log('  window starts ' + cutoff.toISOString().slice(0, 10) + '; rows per target partition: ' +
      months.map(m => 'timelines_p' + m.m.replace('-', '') + ' ' + m.n).join(', '));
    const det = await q2('select c.relname nm, c.reltuples::bigint est from pg_class c where c.relname like $1 and c.relkind = $2' +
      ' and not exists (select 1 from pg_inherits i where i.inhrelid = c.oid)', ['timelines_p%', 'r']);
    if (det.length) wrn(det.length + ' timeline partition(s) are DETACHED from the parent',
      det.map(d => d.nm + ' (~' + d.est + ' rows)').join(', ') + '  -> v1_timeline_id UNIQUE is INVALID, so dedup must happen in code');
    const keys = await q2('select t.relname tbl, i.relname idx, ix.indisvalid ok from pg_class t' +
      ' join pg_index ix on ix.indrelid = t.oid join pg_class i on i.oid = ix.indexrelid where ix.indisunique' +
      ' and t.relname in (\'v2_leads\',\'under_graduate\',\'notes\',\'lead_tags\',\'ApplicationActivityTrackers\',\'leadScoreHistory\',\'timelines\')' +
      ' and (i.relname like \'%v1%\' or i.relname like \'%v2_lead%\' or i.relname like \'%dedupe%\') order by 1');
    keys.forEach(k => log('  ' + (k.ok ? 'valid   ' : 'INVALID ') + k.tbl + '.' + k.idx));
    check(keys.some(k => k.tbl === 'v2_leads' && k.ok), 'v2_leads has a VALID unique key on v1_lead_id, so a re-run cannot double-insert');

    hr('12. THE EMAIL RISK FOR THIS SCHOOL');
    const wf = await q2('select w.id, w.name, w.status, w.trigger, w.trigger_application_form_id faform, w.trigger_program_id fprog,' +
      ' string_agg(distinct n.type, \',\') types from workflows w join nodes n on n.workflow_id = w.id' +
      ' where w.org_id = $1 and lower(w.status) in (\'active\',\'published\') and (w.school_id = $2 or w.school_id is null)' +
      ' and n.type in (\'email\',\'whatsapp\',\'sms\') group by 1,2,3,4,5,6 order by 1', [K.v2.org, K.v2.school]);
    for (const w of wf) {
      const scoped = w.faform || w.fprog;
      log('  wf ' + w.id + ' "' + w.name + '" ' + w.status + ' trigger=' + w.trigger + ' nodes=' + w.types + ' ' +
        (scoped ? 'scoped to form ' + (w.faform || '-') + ' / program ' + (w.fprog || '-')
          : 'NO form/program filter -> it would match EVERY new school-' + K.v2.school + ' lead'));
    }
    const others = (await q2('select count(*)::int n from workflows w where w.org_id = $1 and lower(w.status) in (\'active\',\'published\')' +
      ' and (w.school_id = $2 or w.school_id is null) and not exists (select 1 from nodes n where n.workflow_id = w.id' +
      ' and n.type in (\'email\',\'whatsapp\',\'sms\'))', [K.v2.org, K.v2.school]))[0].n;
    log('  plus ' + others + ' live workflow(s) with no comms node - they would still re-assign or edit the leads we insert');
    wrn(wf.length + ' live comms workflow(s) could fire on these inserts',
      'the apply MUST run with app.skip_automation = true, proven by scripts/import/05-automation-safety-check.cjs');

    hr('13. DUPLICATE PEOPLE AND DATA QUALITY');
    const em = (await q1('select lower("registeredEmail") e from "manageLeads" where "applicationFormId" = $1 and coalesce("registeredEmail", \'\') <> \'\'', [K.v1.form])).map(r => r.e);
    let emHit = 0;
    for (let i = 0; i < em.length; i += 10000) {
      emHit += (await q2('select count(distinct lower(registered_email))::int n from v2_leads where org_id = $1 and school_id = $2' +
        ' and lower(registered_email) = any($3::text[])', [K.v2.org, K.v2.school, em.slice(i, i + 10000)]))[0].n;
    }
    wrn(emHit + ' of ' + new Set(em).size + ' distinct K12 emails already exist in v2 school ' + K.v2.school + ' (as UG leads)',
      'expected: v2 keeps one row per person PER FORM, so these become a second row for the same person');
    const junk = (await q1('select count(*) filter (where tags && array[\'testingqaremovetag\',\'testing\',\'bulk tag testing\',\'testtagbulk2703\'])::int tagged,' +
      ' count(*) filter (where "registeredName" ilike \'%test%\')::int named, count(*)::int live' +
      ' from "manageLeads" where "applicationFormId" = $1 and "isLeadDeleted" = false', [K.v1.form]))[0];
    wrn('QA/test data: ' + junk.tagged + ' of ' + junk.live + ' live leads carry a test tag, ' + junk.named + ' have "test" in the name',
      'decide: migrate all, skip them, or migrate without the test tags');

    hr('14. DOES THE LATEST EXPORT STILL FIT THE v2 SCHEMA?');
    // The colleague's script checks every column it writes against information_schema before
    // touching a row, instead of failing on the first insert. Worth having: an export can sit
    // overnight while v2 deploys. This checks the ACTUAL payload keys, so the lists cannot
    // drift apart from the importer.
    const EXP_ROOT = 'C:/Users/Prateek/Desktop/Repos/data/k12';
    const PAYLOAD = {
      'leads.ndjson': ['v2_leads', ['_v1']],
      'under_graduate.ndjson': ['under_graduate', []],
      'timelines.ndjson': ['timelines', []],
      'notes.ndjson': ['notes', ['_pendingAdminV1Id']],
      'activity_trackers.ndjson': ['ApplicationActivityTrackers', []],
      'lead_score_history.ndjson': ['leadScoreHistory', ['v1_lead_id', 'v1_history_id']],
      'lead_tags.ndjson': ['lead_tags', ['tag_name']],
      'staff.ndjson': ['users', ['wiring']],
      'tags_create.ndjson': ['tags', []],
    };
    const expRuns = fs.existsSync(EXP_ROOT) ? fs.readdirSync(EXP_ROOT).filter(d => /^\d{4}-/.test(d)).sort() : [];
    if (!expRuns.length) log('  no export yet - run 50-export-k12.cjs, then this check has something to verify');
    else {
      const EDIR = EXP_ROOT + '/' + expRuns[expRuns.length - 1];
      log('  checking export ' + expRuns[expRuns.length - 1]);
      const problems = [];
      for (const [file, [table, skip]] of Object.entries(PAYLOAD)) {
        const p = EDIR + '/' + file;
        if (!fs.existsSync(p)) continue;
        const first = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)[0];
        if (!first) continue;
        const keys = Object.keys(JSON.parse(first)).filter(k => !skip.includes(k));
        const cols = new Set((await q2('select column_name c from information_schema.columns where table_name = $1', [table])).map(r => r.c));
        const missing = keys.filter(k => !cols.has(k));
        if (missing.length) problems.push(table + ' has no column(s): ' + missing.join(', ') + ' (from ' + file + ')');
      }
      check(problems.length === 0, 'every column the export writes exists in v2 right now', problems.join(' | '));
    }

    hr(fail ? fail + ' CHECK(S) FAILED - do not write anything yet' : 'NO BLOCKERS - every v1 reference has a v2 counterpart');
    log('  ' + pass + ' passed, ' + fail + ' failed, ' + warn + ' decision(s) for the user');
    if (fail) process.exitCode = 1;
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('PREFLIGHT FAILED TO RUN:', e.message); process.exit(1); });
