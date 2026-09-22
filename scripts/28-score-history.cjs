/** READ-ONLY: was v1 LeadScoreHistories migrated into v2 leadScoreHistory? */
const { connect } = require('./lib/db.cjs');
const M = require('./lib/maps.cjs');
const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(80) + '\n' + t + '\n' + '='.repeat(80));
const n = v => v === null || v === undefined ? null : (v instanceof Date ? v.toISOString() : String(v));

(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    hr('A. v1 LeadScoreHistories shape');
    const { rows: c1 } = await v1.query(
      `select column_name, data_type from information_schema.columns where table_name='LeadScoreHistories' order by ordinal_position`);
    log('  ' + c1.map(r => `${r.column_name}:${r.data_type}`).join(', '));
    const { rows: n1 } = await v1.query('select count(*)::bigint n from "LeadScoreHistories"');
    log('  total rows in v1:', n1[0].n);

    hr('B. v2 leadScoreHistory for UG, by source');
    const { rows: bySrc } = await v2.query(
      `select source, count(*)::int n, min("createdAt") mn, max("createdAt") mx
       from "leadScoreHistory" where "schoolId"=$1 group by 1 order by 2 desc`, [M.SCHOOL_V2]);
    bySrc.forEach(r => log(`  ${String(r.source).padEnd(14)} ${String(r.n).padStart(8)}   ${n(r.mn)} .. ${n(r.mx)}`));

    hr('C. how does a v1_history row correspond to a v1 LeadScoreHistories row?');
    const { rows: sample } = await v2.query(
      `select * from "leadScoreHistory" where "schoolId"=$1 and source='v1_history' order by id desc limit 5`, [M.SCHOOL_V2]);
    log('  sample v2 rows:');
    sample.forEach(r => log('   ', JSON.stringify(r).slice(0, 420)));
    if (sample.length) {
      const leadIds = sample.map(r => r.leadId);
      const { rows: leadRows } = await v2.query(
        'select id, v1_lead_id, registered_name from v2_leads where id = any($1::int[])', [leadIds]);
      log('\n  their v2 leads:', JSON.stringify(leadRows));
      const v1Leads = leadRows.map(r => r.v1_lead_id).filter(Boolean);
      if (v1Leads.length) {
        const { rows: src } = await v1.query(
          'select * from "LeadScoreHistories" where "leadId" = any($1::int[]) order by id desc limit 8', [v1Leads]);
        log('\n  matching v1 LeadScoreHistories:');
        src.forEach(r => log('   ', JSON.stringify(r).slice(0, 420)));
      }
    }

    hr('D. does EVERY migrated UG lead with v1 score history have it in v2?');
    const { rows: ugLeads } = await v2.query(
      `select id, v1_lead_id from v2_leads where org_id=$1 and school_id=$2 and v1_lead_id is not null limit 4000`,
      [M.ORG_V2, M.SCHOOL_V2]);
    const v1ids = ugLeads.map(r => r.v1_lead_id);
    const { rows: v1h } = await v1.query(
      'select "leadId", count(*)::int n from "LeadScoreHistories" where "leadId" = any($1::int[]) group by 1', [v1ids]);
    const { rows: v2h } = await v2.query(
      `select "leadId", count(*)::int n from "leadScoreHistory" where "leadId" = any($1::int[]) and source='v1_history' group by 1`,
      [ugLeads.map(r => r.id)]);
    const byV2 = new Map(v2h.map(r => [r.leadId, r.n]));
    const idByV1 = new Map(ugLeads.map(r => [r.v1_lead_id, r.id]));
    let both = 0, onlyV1 = 0, countMatch = 0, countDiff = 0;
    for (const r of v1h) {
      const v2id = idByV1.get(r.leadId);
      const got = byV2.get(v2id) || 0;
      if (got > 0) { both++; if (got === r.n) countMatch++; else countDiff++; } else onlyV1++;
    }
    log(`  sampled ${ugLeads.length} migrated UG leads`);
    log(`  have v1 score history          : ${v1h.length}`);
    log(`  ...also have it in v2          : ${both}   (exact count match: ${countMatch}, differing count: ${countDiff})`);
    log(`  ...MISSING from v2             : ${onlyV1}`);

    hr('E. the rows that would be in scope for THIS migration');
    const { rows: all } = await v1.query('select id from "manageLeads" where "applicationFormId" = any($1::int[])', [M.V1_FORMS]);
    const allIds = all.map(r => r.id);
    const present = new Set();
    for (let i = 0; i < allIds.length; i += 20000) {
      const { rows } = await v2.query('select v1_lead_id from v2_leads where v1_lead_id = any($1::int[])', [allIds.slice(i, i + 20000)]);
      rows.forEach(r => present.add(r.v1_lead_id));
    }
    const miss = allIds.filter(i => !present.has(i));
    const { rows: mine } = await v1.query(
      'select * from "LeadScoreHistories" where "leadId" = any($1::int[]) order by "leadId", id', [miss]);
    log(`  v1 LeadScoreHistories rows for the ${miss.length} in-scope leads: ${mine.length}`);
    mine.forEach(r => log('   ', JSON.stringify(r)));
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('ERR', e.message); console.error(e.stack); process.exit(1); });
