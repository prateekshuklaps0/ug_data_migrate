/** Read-only: satellite coverage keyed on v2 lead ids (avoids NULL org_id/school_id blind spot). */
const { connect } = require('./lib/db.cjs');
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: ug } = await v2.query(`
      select id, v1_lead_id from v2_leads
      where org_id=12 and school_id=18 and form_id in (104,105) and v1_lead_id is not null`);
    console.log('migrated UG v2 leads:', ug.length);
    const v2ids = ug.map(r=>r.id), v1ids = ug.map(r=>r.v1_lead_id);

    const { rows: n } = await v2.query(`
      select count(*)::int total, count(*) filter (where v1_note_id is not null)::int from_v1,
             count(distinct v2_lead_id)::int leads
      from notes where v2_lead_id = any($1::int[])`, [v2ids]);
    console.log('v2 notes on migrated UG leads      :', JSON.stringify(n[0]));

    const { rows: t } = await v2.query(`
      select count(*)::int total, count(*) filter (where v1_lead_id is not null)::int from_v1,
             count(distinct v2_lead_id)::int leads
      from lead_tags where v2_lead_id = any($1::int[])`, [v2ids]);
    console.log('v2 lead_tags on migrated UG leads  :', JSON.stringify(t[0]));

    // v1 side volumes for the SAME leads
    const { rows: n1 } = await v1.query(`select count(*)::int total, count(distinct "leadId")::int leads from "Notes" where "leadId" = any($1::int[])`, [v1ids]);
    console.log('v1 Notes for those same leads      :', JSON.stringify(n1[0]));
    const { rows: st } = await v1.query(`select count(*)::int total, count(distinct "leadId")::int leads from "StudentTimelines" where "leadId" = any($1::int[])`, [v1ids]);
    console.log('v1 StudentTimelines for those leads:', JSON.stringify(st[0]));
    const { rows: ut } = await v1.query(`select count(*)::int total, count(distinct "leadId")::int leads from "UserTimelines" where "leadId" = any($1::int[])`, [v1ids]);
    console.log('v1 UserTimelines for those leads   :', JSON.stringify(ut[0]));

    // ---- now the 165 ----
    const { rows: all } = await v1.query(`select id from "manageLeads" where "applicationFormId" in (100,109)`);
    const have = new Set(v1ids);
    const miss = all.map(r=>r.id).filter(i=>!have.has(i));
    console.log('\n--- v1 satellite volume for the', miss.length, 'MISSING leads ---');
    for (const [label, sql] of [
      ['Notes',            `select count(*)::int total, count(distinct "leadId")::int leads from "Notes" where "leadId"=any($1::int[])`],
      ['StudentTimelines', `select count(*)::int total, count(distinct "leadId")::int leads from "StudentTimelines" where "leadId"=any($1::int[])`],
      ['UserTimelines',    `select count(*)::int total, count(distinct "leadId")::int leads from "UserTimelines" where "leadId"=any($1::int[])`],
      ['councellorCalls',  `select count(*)::int total, count(distinct "leadId")::int leads from "councellorCalls" where "leadId"=any($1::int[])`],
      ['leadCallLogs',     `select count(*)::int total, count(distinct "leadId")::int leads from "leadCallLogs" where "leadId"=any($1::int[])`],
    ]) {
      try { const { rows } = await v1.query(sql,[miss]); console.log(' ', label.padEnd(18), JSON.stringify(rows[0])); }
      catch(e){ console.log(' ', label.padEnd(18), 'n/a:', e.message.slice(0,70)); }
    }

    // v1 tags for the missing (manageLeads.tags is a text[])
    const { rows: tg } = await v1.query(`select id, tags from "manageLeads" where id=any($1::int[]) and tags is not null and array_length(tags,1)>0`, [miss]);
    console.log('  manageLeads.tags non-empty:', tg.length, JSON.stringify(tg.slice(0,5)));

    // how does lead_tags resolve tag names? show the tags table
    const { rows: tags } = await v2.query(`select id, name, org_id from tags where org_id=12 order by id limit 40`);
    console.log('\nv2 tags (org 12):', JSON.stringify(tags.map(r=>`${r.id}:${r.name}`)));
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
