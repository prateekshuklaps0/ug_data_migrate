/** Read-only: how much timeline/note/tag data exists in v1 for the 165, and was it migrated for others? */
const { connect } = require('./lib/db.cjs');
const V1_FORMS=[100,109];
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: all } = await v1.query(`select id from "manageLeads" where "applicationFormId"=any($1::int[])`,[V1_FORMS]);
    const allIds = all.map(r=>r.id);
    const { rows: got } = await v2.query(`select v1_lead_id from v2_leads where v1_lead_id=any($1::int[])`,[allIds]);
    const have = new Set(got.map(r=>r.v1_lead_id));
    const missIds = allIds.filter(id=>!have.has(id));
    const migratedIds = allIds.filter(id=>have.has(id));
    console.log('missing:', missIds.length, '| already migrated:', migratedIds.length);

    // ---- does v2 actually hold v1-sourced satellites for migrated UG leads? ----
    console.log('\n=== v2 satellite coverage for MIGRATED UG leads ===');
    for (const [label, sql] of [
      ['timelines (v1_timeline_id not null)', `select count(*)::int n, count(distinct v1_lead_id)::int leads from timelines where v1_lead_id = any($1::int[]) and v1_timeline_id is not null`],
      ['timelines (any v1_lead_id)',          `select count(*)::int n, count(distinct v1_lead_id)::int leads from timelines where v1_lead_id = any($1::int[])`],
      ['notes (v1_note_id not null)',         `select count(*)::int n, count(distinct v1_lead_id)::int leads from notes where v1_lead_id = any($1::int[]) and v1_note_id is not null`],
      ['lead_tags (any v1_lead_id)',          `select count(*)::int n, count(distinct v1_lead_id)::int leads from lead_tags where v1_lead_id = any($1::int[])`],
    ]) {
      const { rows } = await v2.query(sql, [migratedIds.slice(0, 40000)]);
      console.log(' ', label.padEnd(38), JSON.stringify(rows[0]));
    }

    // ---- v1 satellite volume for the MISSING 165 ----
    console.log('\n=== v1 satellite rows for the 165 MISSING leads ===');
    for (const [label, sql] of [
      ['StudentTimelines', `select count(*)::int n, count(distinct "leadId")::int leads from "StudentTimelines" where "leadId" = any($1::int[])`],
      ['UserTimelines',    `select count(*)::int n, count(distinct "leadId")::int leads from "UserTimelines" where "leadId" = any($1::int[])`],
      ['Notes',            `select count(*)::int n, count(distinct "leadId")::int leads from "Notes" where "leadId" = any($1::int[])`],
      ['councellorCalls',  `select count(*)::int n, count(distinct "leadId")::int leads from "councellorCalls" where "leadId" = any($1::int[])`],
    ]) {
      try { const { rows } = await v1.query(sql, [missIds]); console.log(' ', label.padEnd(20), JSON.stringify(rows[0])); }
      catch(e){ console.log(' ', label.padEnd(20), 'ERR', e.message.slice(0,90)); }
    }

    // ---- which v1 timeline table did v2 timelines come from? sample a migrated lead ----
    console.log('\n=== provenance check: sample a migrated UG lead with timelines ===');
    const { rows: s } = await v2.query(`
      select v1_lead_id, v1_timeline_id, event_type, title, created_by, v1_counsellor_id, lead_stage_id, created_at
      from timelines where v1_lead_id = any($1::int[]) and v1_timeline_id is not null
      order by v1_lead_id desc limit 8`, [migratedIds.slice(0,40000)]);
    console.log(JSON.stringify(s, null, 1).slice(0, 1800));
    if (s.length) {
      const tid = s[0].v1_timeline_id, lid = s[0].v1_lead_id;
      for (const t of ['StudentTimelines','UserTimelines']) {
        const { rows } = await v1.query(`select id, "leadId", "eventType", message, "leadStageId" from "${t}" where id=$1`, [tid])
          .catch(()=>({rows:[]}));
        console.log(` v1 ${t} id=${tid}:`, JSON.stringify(rows).slice(0,400));
      }
      const { rows: ut } = await v1.query(`select id,"eventType",message,"leadStageId","createdAt" from "UserTimelines" where "leadId"=$1 order by id limit 5`,[lid]);
      console.log(` v1 UserTimelines for lead ${lid}:`, JSON.stringify(ut).slice(0,700));
    }

    // ---- latest migrated timeline: when did timeline copying stop? ----
    const { rows: mx } = await v2.query(`
      select max(v1_timeline_id) max_v1_tl, max(created_at) max_created
      from timelines where v1_lead_id = any($1::int[]) and v1_timeline_id is not null`, [migratedIds.slice(0,40000)]);
    console.log('\nmax v1_timeline_id copied:', JSON.stringify(mx[0]));
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
