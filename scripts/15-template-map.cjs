const { connect } = require('./lib/db.cjs');
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    // migrated timelines that DO carry a template_id: what v1 templateId did they come from?
    const { rows: leads } = await v2.query(`
      select id, v1_lead_id from v2_leads where org_id=12 and school_id=18 and form_id in (104,105)
      and v1_lead_id is not null order by v1_lead_id desc limit 600`);
    const m=new Map(leads.map(r=>[r.v1_lead_id,r.id]));
    const { rows: t1 } = await v1.query(`select "leadId","templateId","createdAt" from "UserTimelines" where "leadId"=any($1::int[]) and "templateId" is not null`,[leads.map(r=>r.v1_lead_id)]);
    const { rows: t2 } = await v2.query(`select v2_lead_id,template_id,created_at from timelines where v2_lead_id=any($1::int[]) and template_id is not null`,[leads.map(r=>r.id)]);
    const by=new Map(t2.map(r=>[`${r.v2_lead_id}|${new Date(r.created_at).getTime()}`,r]));
    const pairs=new Map();
    for (const a of t1){ const lid=m.get(a.leadId); if(!lid) continue;
      const b=by.get(`${lid}|${new Date(a.createdAt).getTime()}`); if(!b) continue;
      const k=`${a.templateId} -> ${b.template_id}`; pairs.set(k,(pairs.get(k)||0)+1); }
    console.log('v1 templateId -> v2 template_id observed:');
    [...pairs.entries()].sort((a,b)=>b[1]-a[1]).slice(0,25).forEach(([k,v])=>console.log('  ',String(v).padStart(4),k));

    const v1ids=[...new Set(t1.map(r=>r.templateId))];
    const { rows: v1t } = await v1.query(`select id,name,"templateType" from "communicationTemplates" where id=any($1::int[])`,[v1ids]).catch(async()=>{
      const c=await v1.query(`select column_name from information_schema.columns where table_name='communicationTemplates'`);
      console.log('v1 communicationTemplates cols:', c.rows.map(r=>r.column_name).join(', ')); return {rows:[]}; });
    console.log('\nv1 templates sample:', JSON.stringify(v1t.slice(0,6)));
    const v2ids=[...new Set(t2.map(r=>r.template_id))];
    const { rows: v2t } = await v2.query(`select id,name,v1_id from "communicationTemplates" where id=any($1::int[])`,[v2ids]).catch(async()=>{
      const c=await v2.query(`select column_name from information_schema.columns where table_name='communicationTemplates'`);
      console.log('v2 communicationTemplates cols:', c.rows.map(r=>r.column_name).join(', ')); return {rows:[]}; });
    console.log('v2 templates sample:', JSON.stringify(v2t.slice(0,6)));
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
