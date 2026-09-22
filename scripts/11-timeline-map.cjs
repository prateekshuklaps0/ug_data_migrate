/** Read-only: how v1 UserTimelines map into v2 timelines. */
const { connect } = require('./lib/db.cjs');
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const lid = 2494072;
    const { rows: [lead] } = await v2.query(`select id from v2_leads where v1_lead_id=$1`,[lid]);
    const { rows: t1 } = await v1.query(`select id,"eventType",message,"leadStageId","createdAt","templateId","isDeleted" from "UserTimelines" where "leadId"=$1 order by "createdAt"`,[lid]);
    const { rows: t2 } = await v2.query(`select id,event_type,title,description,metadata,lead_stage_id,template_id,created_by,v1_counsellor_id,v1_lead_id,v1_timeline_id,created_at,org_id,school_id from timelines where v2_lead_id=$1 order by created_at`,[lead.id]);
    console.log('v1 UserTimelines:', t1.length, '| v2 timelines:', t2.length);
    console.log('\n--- v1 (first 8) ---');
    t1.slice(0,8).forEach(r=>console.log(' ', r.createdAt.toISOString(), '|', JSON.stringify(r.eventType), '|', (r.message||'').slice(0,90)));
    console.log('\n--- v2 (first 12, full) ---');
    console.log(JSON.stringify(t2.slice(0,12), null, 1).slice(0,3500));

    // match by created_at
    const byTs = new Map(t2.map(r=>[new Date(r.created_at).getTime(), r]));
    let matched=0; const evMap=new Map();
    for (const a of t1) {
      const m = byTs.get(new Date(a.createdAt).getTime());
      if (m) { matched++; const k=`${a.eventType?.title} => ${m.event_type} / ${m.title}`; evMap.set(k,(evMap.get(k)||0)+1); }
    }
    console.log(`\nv1 rows matched to a v2 row by exact created_at: ${matched}/${t1.length}`);
    console.log('event mapping observed:', JSON.stringify([...evMap.entries()],null,1).slice(0,2000));
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
