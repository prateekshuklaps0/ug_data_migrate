/**
 * READ-ONLY. Answers: are stages, sub-stages, application stages/sub-stages, tags
 * and the activity trackers actually being migrated - and if a column is empty in
 * the export, is that because the exporter drops it or because v1 has nothing?
 */
const { connect } = require('./lib/db.cjs');
const M = require('./lib/maps.cjs');

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(80) + '\n' + t + '\n' + '='.repeat(80));
const tally = (rows, f) => {
  const m = new Map();
  rows.forEach(r => { const k = f(r); m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

(async () => {
  const v1 = await connect('v1');
  const v2 = await connect('v2');
  try {
    // the exact 163 in scope
    const { rows: all } = await v1.query(
      'select id from "manageLeads" where "applicationFormId" = any($1::int[])', [M.V1_FORMS]);
    const allIds = all.map(r => r.id);
    const present = new Set();
    for (let i = 0; i < allIds.length; i += 20000) {
      const { rows } = await v2.query('select v1_lead_id from v2_leads where v1_lead_id = any($1::int[])', [allIds.slice(i, i + 20000)]);
      rows.forEach(r => present.add(r.v1_lead_id));
    }
    const missIds = allIds.filter(id => !present.has(id));
    const { rows: leads } = await v1.query('select * from "manageLeads" where id = any($1::int[])', [missIds]);
    log(`in-scope v1 leads: ${leads.length}`);

    // ------------------------------------------------------------ 1. lead stage
    hr('1. lead stage / sub-stage - what does v1 ACTUALLY hold for these leads?');
    log('  leadStageId    :', JSON.stringify(tally(leads, r => r.leadStageId)));
    log('  leadSubStageId :', JSON.stringify(tally(leads, r => r.leadSubStageId)));
    const withSub = leads.filter(r => r.leadSubStageId !== null);
    log(`\n  => ${leads.length} of ${leads.length} leads have a stage; only ${withSub.length} have a sub-stage IN V1.`);
    log('     The export writes a sub-stage for exactly those; the rest are NULL in v1 too.');
    const { rows: subNames } = withSub.length ? await v1.query(
      `select ss.id, ss.name, s."stageName" from "LeadSubStage" ss join "LeadStage" s on s.id = ss."leadStageId"
        where ss.id = any($1::int[])`, [withSub.map(r => r.leadSubStageId)]) : { rows: [] };
    subNames.forEach(s => log(`     v1 sub-stage ${s.id} "${s.stageName} / ${s.name}"`));

    // does the wider migrated population look the same?
    const { rows: pop } = await v2.query(`
      select count(*)::int n,
             count(lead_stage_id)::int with_stage,
             count(lead_sub_stage_id)::int with_sub
      from v2_leads where org_id=$1 and school_id=$2 and form_id in (104,105) and v1_lead_id is not null`,
      [M.ORG_V2, M.SCHOOL_V2]);
    log(`\n  for comparison, the 71,166 leads ALREADY migrated:`);
    log(`     ${pop[0].with_stage}/${pop[0].n} have a stage, ${pop[0].with_sub}/${pop[0].n} have a sub-stage ` +
        `(${(100 * pop[0].with_sub / pop[0].n).toFixed(1)}%)`);

    // ------------------------------------------------------------ 2. application stage
    hr('2. application stage / sub-stage');
    const amIds = leads.map(r => r.applicationManagerId).filter(Boolean);
    const { rows: ams } = amIds.length
      ? await v1.query('select * from "ApplicationManager" where id = any($1::int[])', [amIds]) : { rows: [] };
    log(`  in-scope applications: ${ams.length}`);
    ams.forEach(a => log(`    app ${a.id}: applicationStageId=${a.applicationStageId} applicationSubStageId=${a.applicationSubStageId}`));
    log('\n  applicationSubStageId across ALL v1 UG applications:');
    const { rows: allAms } = await v1.query(
      'select "applicationSubStageId" from "ApplicationManager" where "applicationFormId" = any($1::int[])', [M.V1_FORMS]);
    log('   ', JSON.stringify(tally(allAms, r => r.applicationSubStageId)).slice(0, 300));
    const { rows: v2App } = await v2.query(`
      select count(*)::int n, count(application_stage_id)::int with_stage, count(application_sub_stage_id)::int with_sub
      from v2_leads where org_id=$1 and school_id=$2 and type='applicant' and v1_application_id is not null`,
      [M.ORG_V2, M.SCHOOL_V2]);
    log(`\n  already-migrated applicants: ${v2App[0].with_stage}/${v2App[0].n} have an application stage, ` +
        `${v2App[0].with_sub}/${v2App[0].n} have a sub-stage`);

    // ------------------------------------------------------------ 3. tags
    hr('3. tags');
    log('  manageLeads.tags for the in-scope leads:', JSON.stringify(tally(leads, r => JSON.stringify(r.tags))));
    const tagged = leads.filter(r => Array.isArray(r.tags) && r.tags.length);
    log(`  => ${tagged.length} of ${leads.length} leads carry a tag in v1.`);
    tagged.forEach(t => log(`     v1 lead ${t.id}: ${JSON.stringify(t.tags)}`));
    const { rows: v2tag } = await v2.query(`
      select count(distinct v2_lead_id)::int leads_with_tags from lead_tags where org_id=$1 and school_id=$2`,
      [M.ORG_V2, M.SCHOOL_V2]);
    log(`  already in v2: ${v2tag[0].leads_with_tags} UG leads have at least one tag (out of 73,856)`);

    // ------------------------------------------------------------ 4. activity trackers
    hr('4. activity trackers  <-- the one I had NOT examined');
    for (const t of ['leadActivityTracker', 'applicationActivityTracker']) {
      const { rows: c } = await v1.query(`select column_name, data_type from information_schema.columns
        where table_name = '${t}' order by ordinal_position`);
      log(`\n  v1 "${t}" columns: ${c.rows ? '' : ''}${c.map(r => r.column_name).join(', ')}`);
    }
    const { rows: latCols } = await v1.query(`select column_name from information_schema.columns where table_name='leadActivityTracker' order by ordinal_position`);
    const latKey = latCols.map(r => r.column_name).find(c => /lead/i.test(c));
    log(`\n  join column on leadActivityTracker: ${latKey}`);
    const { rows: lat } = await v1.query(
      `select count(*)::int n, count(distinct "${latKey}")::int leads from "leadActivityTracker" where "${latKey}" = any($1::int[])`, [missIds]);
    log(`  rows for the 163 in-scope leads: ${JSON.stringify(lat[0])}`);
    const { rows: latAll } = await v1.query(`select count(*)::bigint n from "leadActivityTracker"`);
    log(`  rows in the whole v1 table      : ${latAll[0].n}`);

    const { rows: aatCols } = await v1.query(`select column_name from information_schema.columns where table_name='applicationActivityTracker' order by ordinal_position`);
    const aatKey = aatCols.map(r => r.column_name).find(c => /application|manager/i.test(c));
    log(`\n  join column on applicationActivityTracker: ${aatKey}`);
    if (amIds.length) {
      const { rows: aat } = await v1.query(
        `select count(*)::int n from "applicationActivityTracker" where "${aatKey}" = any($1::int[])`, [amIds]);
      log(`  rows for the in-scope applications: ${aat[0].n}`);
    }

    // did the PREVIOUS migration populate v2's tracker at all?
    const { rows: v2t } = await v2.query(`select column_name from information_schema.columns
      where table_name='ApplicationActivityTrackers' order by ordinal_position`);
    log(`\n  v2 "ApplicationActivityTrackers" columns: ${v2t.map(r => r.column_name).join(', ')}`);
    const { rows: v2tc } = await v2.query('select count(*)::bigint n from "ApplicationActivityTrackers"');
    log(`  rows in v2 table: ${v2tc[0].n}`);
    const hasOrg = v2t.some(r => r.column_name === 'orgId' || r.column_name === 'org_id');
    if (hasOrg) {
      const col = v2t.some(r => r.column_name === 'org_id') ? 'org_id' : 'orgId';
      const { rows: byOrg } = await v2.query(`select "${col}" org, count(*)::int n from "ApplicationActivityTrackers" group by 1 order by 2 desc limit 8`);
      log(`  by org: ${JSON.stringify(byOrg)}`);
    }
    // is there any UG data in it?
    const leadCol = v2t.map(r => r.column_name).find(c => /lead/i.test(c));
    if (leadCol) {
      const { rows: ugT } = await v2.query(`
        select count(*)::int n from "ApplicationActivityTrackers" t
        join v2_leads l on l.id = t."${leadCol}"
        where l.org_id=$1 and l.school_id=$2`, [M.ORG_V2, M.SCHOOL_V2]).catch(() => ({ rows: [{ n: 'n/a' }] }));
      log(`  rows linked to a UG v2 lead via "${leadCol}": ${ugT[0].n}`);
    }
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('ERR', e.message); console.error(e.stack); process.exit(1); });
