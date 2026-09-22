/** READ-ONLY. How does v1 applicationActivityTracker map into v2 ApplicationActivityTrackers? */
const { connect } = require('./lib/db.cjs');
const M = require('./lib/maps.cjs');
const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(80) + '\n' + t + '\n' + '='.repeat(80));
const norm = v => v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    hr('A. coverage - is a tracker row created per LEAD or per APPLICATION?');
    const { rows: cov } = await v2.query(`
      select l.type, count(*)::int leads, count(t.id)::int with_tracker
      from v2_leads l left join "ApplicationActivityTrackers" t on t."leadId" = l.id
      where l.org_id=$1 and l.school_id=$2 and l.form_id in (104,105)
      group by 1 order by 1`, [M.ORG_V2, M.SCHOOL_V2]);
    console.table ? console.table(cov) : log(JSON.stringify(cov, null, 1));
    const { rows: prov } = await v2.query(`
      select (t."v1_leadId" is not null) from_v1_lead, (t."v1_applicationId" is not null) from_v1_app,
             count(*)::int n
      from "ApplicationActivityTrackers" t join v2_leads l on l.id = t."leadId"
      where l.org_id=$1 and l.school_id=$2 group by 1,2 order by 3 desc`, [M.ORG_V2, M.SCHOOL_V2]);
    log('provenance of UG tracker rows:', JSON.stringify(prov));

    hr('B. v1 side - how many v1 rows exist for UG?');
    const { rows: v1cnt } = await v1.query(`
      select count(*)::int n,
             count(distinct "leadId")::int leads,
             count(distinct "applicationId")::int apps,
             count(*) filter (where "applicationId" is null)::int no_app
      from "applicationActivityTracker"
      where "leadId" in (select id from "manageLeads" where "applicationFormId" = any($1::int[]))`, [M.V1_FORMS]);
    log('v1 applicationActivityTracker rows for UG leads:', JSON.stringify(v1cnt[0]));

    hr('C. field mapping, derived from already-migrated rows');
    const { rows: pairs } = await v2.query(`
      select t.*, l.v1_lead_id, l.v1_application_id
      from "ApplicationActivityTrackers" t join v2_leads l on l.id = t."leadId"
      where l.org_id=$1 and l.school_id=$2 and t."v1_leadId" is not null
      order by t.id desc limit 400`, [M.ORG_V2, M.SCHOOL_V2]);
    log('sampled migrated tracker rows:', pairs.length);
    if (!pairs.length) { log('none carry v1 provenance - checking without that filter'); }
    const { rows: pairs2 } = pairs.length ? { rows: pairs } : await v2.query(`
      select t.*, l.v1_lead_id, l.v1_application_id
      from "ApplicationActivityTrackers" t join v2_leads l on l.id = t."leadId"
      where l.org_id=$1 and l.school_id=$2 and l.v1_lead_id is not null
      order by t.id desc limit 400`, [M.ORG_V2, M.SCHOOL_V2]);
    log('working sample:', pairs2.length);
    if (pairs2.length) {
      const src = await v1.query(
        `select * from "applicationActivityTracker" where "leadId" = any($1::int[])`,
        [pairs2.map(r => r.v1_lead_id)]);
      const by = new Map(src.rows.map(r => [r.leadId, r]));
      log('v1 rows matched:', by.size, 'of', pairs2.length);
      const cols = Object.keys(pairs2[0]).filter(c => !['id', 'leadId', 'v1_lead_id', 'v1_application_id'].includes(c));
      log(`\n  ${'v2 column'.padEnd(34)} ${'set'.padStart(9)}   maps from v1`);
      log('  ' + '-'.repeat(76));
      for (const c of cols) {
        const setN = pairs2.filter(r => r[c] !== null).length;
        const v1cols = src.rows.length ? Object.keys(src.rows[0]) : [];
        const hits = [];
        for (const c1 of v1cols) {
          let ok = true, n = 0;
          for (const r of pairs2) {
            const a = by.get(r.v1_lead_id); if (!a) continue;
            if (norm(a[c1]) !== norm(r[c])) { ok = false; break; }
            if (a[c1] !== null) n++;
          }
          if (ok && n > 0) hits.push(`${c1}(${n})`);
        }
        log(`  ${c.padEnd(34)} ${String(setN + '/' + pairs2.length).padStart(9)}   ${hits.length ? hits.join(', ') : (setN === 0 ? '(always null)' : '(no exact v1 match)')}`);
      }
      log('\n  sample v2 row:', JSON.stringify(pairs2[0]).slice(0, 700));
      const s0 = by.get(pairs2[0].v1_lead_id);
      log('  its v1 row   :', JSON.stringify(s0).slice(0, 700));
    }

    hr('D. the rows that would be in scope now');
    const { rows: all } = await v1.query('select id, "applicationManagerId" from "manageLeads" where "applicationFormId" = any($1::int[])', [M.V1_FORMS]);
    const ids = all.map(r => r.id);
    const present = new Set();
    for (let i = 0; i < ids.length; i += 20000) {
      const { rows } = await v2.query('select v1_lead_id from v2_leads where v1_lead_id = any($1::int[])', [ids.slice(i, i + 20000)]);
      rows.forEach(r => present.add(r.v1_lead_id));
    }
    const miss = ids.filter(i => !present.has(i));
    const { rows: mine } = await v1.query(
      'select * from "applicationActivityTracker" where "leadId" = any($1::int[])', [miss]);
    log(`v1 applicationActivityTracker rows for the ${miss.length} in-scope leads: ${mine.length}`);
    mine.forEach(r => log('  ' + JSON.stringify(r)));

    // the promoted lead too
    const { rows: promo } = await v1.query(
      `select * from "applicationActivityTracker" where "applicationId" = 730635 or "leadId" = 2417827`);
    log(`\nrows for the promoted lead (v1 lead 2417827 / app 730635): ${promo.length}`);
    promo.forEach(r => log('  ' + JSON.stringify(r)));
    const { rows: promoV2 } = await v2.query(
      `select * from "ApplicationActivityTrackers" where "leadId" = 700791`);
    log(`existing v2 tracker rows for v2 lead 700791: ${promoV2.length}`);
    promoV2.forEach(r => log('  ' + JSON.stringify(r)));
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('ERR', e.message); console.error(e.stack); process.exit(1); });
