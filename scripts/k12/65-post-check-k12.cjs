/**
 * K12 POST-APPLY CHECK - READ ONLY.
 *
 *   node scripts/k12/65-post-check-k12.cjs [--run <id>]
 *
 * 1. Nothing reached a real person: automation events, workflow and node executions,
 *    communication logs for the leads this import created; the trigger still enabled.
 * 2. The data landed: counts against v1, and a field-by-field re-read of a sample of
 *    leads straight from v1.
 * 3. What the CRM now shows for K12.
 */
const fs = require('fs');
const path = require('path');
const { connect } = require('../lib/db.cjs');
const K = require('./lib-k12.cjs');

const ROOT = 'C:/Users/Prateek/Desktop/Repos/data/k12';
const args = process.argv.slice(2);
const runArg = args.includes('--run') ? args[args.indexOf('--run') + 1] : null;

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(84) + '\n' + t + '\n' + '='.repeat(84));
let pass = 0, fail = 0;
const check = (c, n, x = '') => { if (c) { pass++; log('  PASS  ' + n + (x ? '   ' + x : '')); } else { fail++; log('  FAIL  ' + n + (x ? '   ' + x : '')); } };
const readNd = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];

(async () => {
  const runs = fs.readdirSync(ROOT).filter(d => /^\d{4}-/.test(d)).sort();
  const runId = runArg || runs[runs.length - 1];
  const DIR = path.join(ROOT, runId);
  const leads = readNd(path.join(DIR, 'leads.ndjson'));
  const v1Ids = leads.map(l => l.v1_lead_id);
  const runDirs = fs.existsSync(path.join(DIR, 'runs')) ? fs.readdirSync(path.join(DIR, 'runs')).sort() : [];
  const applied = runDirs.map(d => path.join(DIR, 'runs', d, 'summary.json')).filter(fs.existsSync);
  hr(`K12 POST-APPLY CHECK   export ${runId}   apply runs: ${applied.length}`);
  if (!applied.length) log('  NOTE: no summary.json found - this export may not have been applied yet.');

  const v1 = await connect('v1'), v2 = await connect('v2');
  try {
    const { rows: mine } = await v2.query(
      'select id, v1_lead_id from v2_leads where v1_lead_id = any($1::int[]) and org_id = $2 and form_id = $3',
      [v1Ids, K.V2.org, K.V2.form]);
    const ids = mine.map(r => Number(r.id));
    const byV1 = new Map(mine.map(r => [r.v1_lead_id, Number(r.id)]));
    log(`  leads in the export ${v1Ids.length}; found in v2 on form ${K.V2.form}: ${ids.length}`);

    hr('PART 1 - did anything reach a real person?');
    const q1 = async (sql, p) => (await v2.query(sql, p)).rows[0];
    const ev = await q1(`select count(*)::int n from automation_events where table_name = 'v2_leads' and row_id = any($1::bigint[])`, [ids]);
    check(ev.n === 0, 'automation_events: 0 for the leads this import created', String(ev.n));
    const wf = await q1('select count(*)::int n from workflow_executions where lead_id = any($1::bigint[])', [ids]);
    check(wf.n === 0, 'workflow_executions: no workflow ran for these leads', String(wf.n));
    const ne = await q1(`select count(*)::int n from node_executions where lead_id = any($1::bigint[]) and type in ('email','whatsapp','sms')`, [ids]);
    check(ne.n === 0, 'node_executions: 0 email / whatsapp / sms for these leads', String(ne.n));
    try {
      const cl = await q1(`select count(*)::int n from "communicationLogs" where "leadId" = any($1::bigint[])`, [ids]);
      check(cl.n === 0, 'communicationLogs: nothing sent to these leads', String(cl.n));
    } catch { log('  note: communicationLogs not queryable here - skipped'); }
    const trg = await q1(`select tg.tgenabled from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
      where c.relname = 'v2_leads' and tg.tgname = 'trg_automation_v2_leads'`);
    check(trg && trg.tgenabled === 'O', 'the automation trigger is still ENABLED for the live CRM');

    hr('PART 2 - did the data land?');
    const { rows: [v1now] } = await v1.query(
      'select count(*)::int n from "manageLeads" where "applicationFormId" = $1 and "isLeadDeleted" = false', [K.V1.form]);
    check(ids.length === v1Ids.length, `every exported lead is in v2 (${ids.length} of ${v1Ids.length})`,
      v1Ids.filter(i => !byV1.has(i)).slice(0, 5).join(','));
    log(`  v1 live K12 leads right now: ${v1now.n}`);
    // Classify the gap instead of just counting it (an idea taken from the colleague's
    // --verify mode): a lead can also drop out by being deleted or by changing form.
    const { rows: gap } = await v1.query(
      `select m.id, m."isLeadDeleted" del, m."applicationFormId" form, m."createdAt" at
         from "manageLeads" m where m."applicationFormId" = $1 and m.id <> all($2::int[]) and m."isLeadDeleted" = false`,
      [K.V1.form, v1Ids]);
    const exportedAt = new Date(JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8')).generatedAt);
    const createdAfter = gap.filter(r => new Date(r.at) > exportedAt).length;
    log(`  v1 leads not in this export: ${gap.length} - created after the export ${createdAfter}, ` +
        `other ${gap.length - createdAfter} (re-run the export to pick them up)`);
    const { rows: [drift] } = await v1.query(
      `select count(*)::int n from "manageLeads" where id = any($1::int[]) and ("isLeadDeleted" or "applicationFormId" <> $2)`,
      [v1Ids, K.V1.form]);
    if (drift.n) log(`  note: ${drift.n} exported lead(s) have since been deleted in v1 or moved to another form - they stay in v2 as migrated`);
    const sat = (await v2.query(
      `select (select count(*)::int from under_graduate where lead_id = any($1::bigint[])) ug,
              (select count(*)::int from timelines where v2_lead_id = any($1::bigint[])) tl,
              (select count(*)::int from notes where v2_lead_id = any($1::bigint[])) nt,
              (select count(*)::int from lead_tags where v2_lead_id = any($1::bigint[])) tg,
              (select count(*)::int from "ApplicationActivityTrackers" where "leadId" = any($1::bigint[])) tk,
              (select count(*)::int from "leadScoreHistory" where "leadId" = any($1::bigint[])) sh`, [ids])).rows[0];
    const want = {
      ug: readNd(path.join(DIR, 'under_graduate.ndjson')).length,
      tl: readNd(path.join(DIR, 'timelines.ndjson')).length,
      nt: readNd(path.join(DIR, 'notes.ndjson')).length,
      tg: readNd(path.join(DIR, 'lead_tags.ndjson')).length,
      tk: readNd(path.join(DIR, 'activity_trackers.ndjson')).length,
      sh: readNd(path.join(DIR, 'lead_score_history.ndjson')).length,
    };
    for (const [k, label] of [['ug', 'under_graduate'], ['tl', 'timelines'], ['nt', 'notes'], ['tg', 'lead_tags'], ['tk', 'activity trackers'], ['sh', 'score history']]) {
      check(sat[k] >= want[k], `${label}: ${sat[k]} in v2, export had ${want[k]}`, sat[k] < want[k] ? `${want[k] - sat[k]} missing` : '');
    }
    const dupUg = (await v2.query('select count(*)::int n from (select lead_id from under_graduate where lead_id = any($1::bigint[]) group by 1 having count(*) > 1) x', [ids])).rows[0];
    check(dupUg.n === 0, 'no lead has two under_graduate rows', String(dupUg.n));
    const dupTl = (await v2.query('select count(*)::int n from (select v1_timeline_id from timelines where v2_lead_id = any($1::bigint[]) and v1_timeline_id is not null group by 1 having count(*) > 1) x', [ids])).rows[0];
    check(dupTl.n === 0, 'no v1 timeline was copied twice', String(dupTl.n));

    // field-by-field re-read against v1, on a sample
    const sample = v1Ids.slice(0, 40).concat(v1Ids.slice(-40)).filter(i => byV1.has(i));
    const { rows: src } = await v1.query('select * from "manageLeads" where id = any($1::int[])', [sample]);
    const { rows: dst } = await v2.query('select * from v2_leads where v1_lead_id = any($1::int[])', [sample]);
    const dstBy = new Map(dst.map(r => [r.v1_lead_id, r]));
    const diffs = [];
    for (const s of src) {
      const d = dstBy.get(s.id);
      if (!d) { diffs.push(`${s.id} missing in v2`); continue; }
      const same = (a, b) => (a === null || a === undefined ? b === null || b === undefined || b === '' : String(a) === String(b));
      if (!same(s.registeredName, d.registered_name)) diffs.push(`${s.id} name "${s.registeredName}" vs "${d.registered_name}"`);
      if (!same(s.registeredEmail, d.registered_email)) diffs.push(`${s.id} email`);
      if (!same(s.registeredMobile, d.registered_mobile)) diffs.push(`${s.id} mobile`);
      if (!same(s.source, d.source)) diffs.push(`${s.id} source`);
      if (new Date(s.createdAt).getTime() !== new Date(d.created_at).getTime()) diffs.push(`${s.id} created_at`);
      if (Number(s.leadScore || 0) !== Number(d.lead_score || 0)) diffs.push(`${s.id} lead_score ${s.leadScore} vs ${d.lead_score}`);
      if (d.org_id !== K.V2.org || d.school_id !== K.V2.school || d.form_id !== K.V2.form ||
          d.program_id !== K.V2.program || d.batch_id !== K.V2.batch || d.round_id !== K.V2.round) diffs.push(`${s.id} wrong scope`);
      if (d.is_deleted) diffs.push(`${s.id} is_deleted in v2`);
    }
    check(diffs.length === 0, `sample of ${sample.length} leads re-read from v1 matches v2 field by field`, diffs.slice(0, 5).join(' | '));

    // ---- the widget answers, including the "School & City" column the user asked about
    const expLeads = readNd(path.join(DIR, 'leads.ndjson'));
    const expUg = readNd(path.join(DIR, 'under_graduate.ndjson'));
    const key = K.SCHOOL_AND_CITY.payloadKey;
    const wantSac = expLeads.filter(l => l.lead_payload && l.lead_payload.formFields
      && l.lead_payload.formFields[key] !== undefined && l.lead_payload.formFields[key] !== null
      && String(l.lead_payload.formFields[key]).trim() !== '').length;
    // lead_payload is json, not jsonb, so it is cast before being asked
    const { rows: [sac] } = await v2.query(
      `select count(*)::int n from v2_leads
        where id = any($1::bigint[]) and (lead_payload::jsonb -> 'formFields') ? $2`, [ids, key]);
    check(sac.n >= wantSac, `"School & City" is on ${sac.n} lead(s) as lead_payload.formFields.${key} (export expected ${wantSac})`,
      sac.n < wantSac ? `${wantSac - sac.n} missing` : '');

    // every answer column the export filled, counted in v2
    const man = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
    const ugCols = (man.ugColumns || []).filter(c => !['org_id', 'lead_id', 'v1_lead_id', 'created_at', 'updated_at'].includes(c));
    if (ugCols.length) {
      const expCount = c => expUg.filter(r => r[c] !== null && r[c] !== undefined && String(r[c]).trim() !== '').length;
      const { rows: [got] } = await v2.query(
        `select ${ugCols.map((c, i) => `count("${c}") filter (where btrim("${c}"::text) <> '')::int as c${i}`).join(', ')}
           from under_graduate where lead_id = any($1::bigint[])`, [ids]);
      const bad = [];
      ugCols.forEach((c, i) => { const w = expCount(c), g = got['c' + i]; if (g < w) bad.push(`${c} ${g} < ${w}`); });
      ugCols.forEach((c, i) => log(`    under_graduate.${c.padEnd(30)} ${String(got['c' + i]).padStart(6)} in v2   (export had ${expCount(c)})`));
      check(bad.length === 0, `every ${K.V2.formTable} answer column holds at least what the export carried`, bad.join(' | '));
    }
    const sacCol = K.SCHOOL_AND_CITY.ugColumn;
    const { rows: hasCol } = await v2.query(
      "select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2",
      [K.V2.formTable, sacCol]);
    if (!hasCol.length) {
      log(`  NOTE  ${K.V2.formTable}.${sacCol} still does not exist in v2, so "School & City" lives only in`);
      log(`        lead_payload.formFields.${key} - which is where v2's own K12 widget keeps it too.`);
      log(`        To give it a real column (instant, no table rewrite), then backfill:`);
      log(`          ALTER TABLE ${K.V2.formTable} ADD COLUMN ${sacCol} varchar(255);`);
      log(`          UPDATE ${K.V2.formTable} ug SET ${sacCol} = l.lead_payload::jsonb -> 'formFields' ->> '${key}'`);
      log(`            FROM v2_leads l WHERE l.id = ug.lead_id AND l.form_id = ${K.V2.form}`);
      log(`              AND ug.${sacCol} IS NULL AND l.lead_payload::jsonb -> 'formFields' ? '${key}';`);
    }

    // the user's decisions
    const reassignTo = Object.values(K.COUNSELLOR_REASSIGN)[0];
    const { rows: [re] } = await v2.query('select count(*)::int n from v2_leads where id = any($1::bigint[]) and counsellor_id = $2', [ids, reassignTo]);
    const csvLines = fs.existsSync(path.join(DIR, 'reassigned_leads.csv'))
      ? fs.readFileSync(path.join(DIR, 'reassigned_leads.csv'), 'utf8').split('\n').filter(Boolean).length - 1 : 0;
    check(re.n === csvLines, `the reassigned leads point at v2 user ${reassignTo} (${re.n}, CSV says ${csvLines})`);
    for (const nm of K.TAGS_CREATE) {
      const { rows } = await v2.query('select id from tags where org_id = $1 and lower(btrim(name)) = lower($2)', [K.V2.org, nm]);
      check(rows.length === 1, `tag "${nm}" exists in v2`, rows.length ? 'id ' + rows[0].id : 'MISSING');
    }
    for (const v1u of K.COUNSELLOR_CREATE) {
      const { rows } = await v2.query('select id, email, role, school_id from users where v1_id = $1', [v1u]);
      check(rows.length === 1, `created account for v1 user ${v1u}`, rows.length ? `v2 ${rows[0].id} ${rows[0].email} role=${rows[0].role} school=${rows[0].school_id}` : 'MISSING');
    }

    hr('PART 3 - what the CRM now shows for K12');
    const { rows: shape } = await v2.query(
      `select count(*)::int leads, count(counsellor_id)::int with_counsellor, count(lead_stage_id)::int with_stage,
         count(lead_sub_stage_id)::int with_substage, count(*) filter (where type = 'applicant')::int applicants,
         count(grade)::int with_grade, count(city)::int with_city, count(lead_stage_date)::int with_stage_date,
         min(created_at)::date oldest, max(created_at)::date newest
       from v2_leads where org_id = $1 and form_id = $2 and not is_deleted`, [K.V2.org, K.V2.form]);
    log('  ' + JSON.stringify(shape[0]));
    const { rows: byStage } = await v2.query(
      `select coalesce(s."stageName", '(no stage)') stage, count(*)::int n from v2_leads l
         left join "leadStage" s on s.id = l.lead_stage_id
       where l.org_id = $1 and l.form_id = $2 and not l.is_deleted group by 1 order by n desc`, [K.V2.org, K.V2.form]);
    byStage.forEach(r => log(`    ${String(r.n).padStart(5)}  ${r.stage}`));
    const { rows: byCou } = await v2.query(
      `select coalesce(u.email, '(unassigned)') who, count(*)::int n from v2_leads l
         left join users u on u.id = l.counsellor_id
       where l.org_id = $1 and l.form_id = $2 and not l.is_deleted group by 1 order by n desc limit 20`, [K.V2.org, K.V2.form]);
    byCou.forEach(r => log(`    ${String(r.n).padStart(5)}  ${r.who}`));

    hr(fail ? `${fail} CHECK(S) FAILED` : 'ALL CHECKS PASSED');
    log(`  ${pass} passed, ${fail} failed`);
    if (fail) process.exitCode = 1;
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('POST-CHECK FAILED TO RUN:', e.message); process.exit(1); });
