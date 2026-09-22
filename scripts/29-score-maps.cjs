/** READ-ONLY: derive v1 leadScoreCriteria/leadScoreMapping -> v2 equivalents. */
const { connect } = require('./lib/db.cjs');
const M = require('./lib/maps.cjs');
const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(80) + '\n' + t + '\n' + '='.repeat(80));

(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    hr('table shapes');
    for (const [db, t] of [[v1, 'leadScoreCriteria'], [v1, 'leadScoreMapping'], [v2, 'lead_score_criteria'], [v2, 'lead_score_mapping']]) {
      const { rows } = await db.query(
        `select column_name, data_type from information_schema.columns where table_name='${t}' order by ordinal_position`);
      log(`  ${t}: ${rows.map(r => r.column_name).join(', ')}`);
    }

    hr('derive the maps from already-migrated v1_history rows');
    // pair v2 leadScoreHistory(source=v1_history) to its v1 row via dedupeKey
    const { rows: v2h } = await v2.query(`
      select "leadId", "criteriaId", "mappingId", "dedupeKey", "mappingValue", delta, "scoreBefore", "leadScore", "createdAt", "occurredAt", "schoolId", "createdBy", channel, "activityKey", "eventId", "sourceRefId", "rankGroup", "ladderRank", metadata
      from "leadScoreHistory" where "schoolId"=$1 and source='v1_history' and "dedupeKey" is not null
      order by id desc limit 6000`, [M.SCHOOL_V2]);
    log('  sampled v2 rows:', v2h.length);
    const v1Ids = v2h.map(r => Number(String(r.dedupeKey).split(':')[1])).filter(Boolean);
    const { rows: v1h } = await v1.query(
      'select * from "LeadScoreHistories" where id = any($1::int[])', [v1Ids]);
    const by = new Map(v1h.map(r => [r.id, r]));
    log('  matched v1 rows :', by.size);

    const critPairs = new Map(), mapPairs = new Map();
    let valOk = 0, valBad = 0;
    for (const r of v2h) {
      const src = by.get(Number(String(r.dedupeKey).split(':')[1]));
      if (!src) continue;
      critPairs.set(`${src.criteriaId} -> ${r.criteriaId}`, (critPairs.get(`${src.criteriaId} -> ${r.criteriaId}`) || 0) + 1);
      mapPairs.set(`${src.mappingId} -> ${r.mappingId}`, (mapPairs.get(`${src.mappingId} -> ${r.mappingId}`) || 0) + 1);
      if (Number(src.score) === Number(r.mappingValue) && Number(src.score) === Number(r.delta)) valOk++; else valBad++;
    }
    log(`\n  score -> mappingValue AND delta identical on ${valOk} rows, differing on ${valBad}`);

    log('\n  criteriaId map (v1 -> v2):');
    [...critPairs.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, n]) => log(`    ${String(n).padStart(6)}  ${k}`));
    const critAmbig = new Map();
    for (const k of critPairs.keys()) { const [a] = k.split(' -> '); critAmbig.set(a, (critAmbig.get(a) || 0) + 1); }
    const ambC = [...critAmbig.entries()].filter(([, n]) => n > 1);
    log('  v1 criteria mapping to MORE THAN ONE v2 criteria:', JSON.stringify(ambC));

    log('\n  mappingId map (v1 -> v2):');
    [...mapPairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).forEach(([k, n]) => log(`    ${String(n).padStart(6)}  ${k}`));
    const mapAmbig = new Map();
    for (const k of mapPairs.keys()) { const [a] = k.split(' -> '); mapAmbig.set(a, (mapAmbig.get(a) || 0) + 1); }
    const ambM = [...mapAmbig.entries()].filter(([, n]) => n > 1);
    log('  v1 mapping ids mapping to MORE THAN ONE v2 mapping:', JSON.stringify(ambM));

    hr('constant / derived columns on the migrated rows');
    const t = f => { const m = new Map(); v2h.forEach(r => { const k = f(r); m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5); };
    for (const c of ['createdBy', 'channel', 'activityKey', 'eventId', 'sourceRefId', 'rankGroup', 'ladderRank', 'metadata', 'schoolId'])
      log(`  ${c.padEnd(14)} ${JSON.stringify(t(r => r[c] === null ? null : String(r[c]).slice(0, 30)))}`);
    log('  createdAt == occurredAt on:', v2h.filter(r => String(r.createdAt) === String(r.occurredAt)).length, 'of', v2h.length);
    const cmp = v2h.filter(r => { const s = by.get(Number(String(r.dedupeKey).split(':')[1])); return s && new Date(s.createdAt).getTime() === new Date(r.createdAt).getTime(); });
    log('  v2.createdAt == v1.createdAt on:', cmp.length, 'of', by.size);

    hr('idempotency: is dedupeKey unique?');
    const { rows: idx } = await v2.query(`
      select i.relname idx, ix.indisunique, ix.indisvalid, pg_get_indexdef(ix.indexrelid) def
      from pg_index ix join pg_class i on i.oid=ix.indexrelid join pg_class tb on tb.oid=ix.indrelid
      where tb.relname='leadScoreHistory'`);
    idx.forEach(r => log(`  ${r.indisunique ? 'UNIQUE' : '      '} ${r.indisvalid ? 'valid' : 'INVALID'} ${r.idx} :: ${r.def.replace(/.*USING btree /, '')}`));

    hr('running-total check on a single lead');
    const { rows: one } = await v2.query(`
      select "leadId", "dedupeKey", "mappingValue", delta, "scoreBefore", "leadScore", "createdAt"
      from "leadScoreHistory" where "schoolId"=$1 and source='v1_history' and "leadId" = $2 order by "createdAt"`,
      [M.SCHOOL_V2, v2h[0] && v2h[0].leadId]);
    one.forEach(r => log(`  ${r.createdAt.toISOString()}  value=${r.mappingValue} delta=${r.delta} before=${r.scoreBefore} after=${r.leadScore}`));
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('ERR', e.message); console.error(e.stack); process.exit(1); });
