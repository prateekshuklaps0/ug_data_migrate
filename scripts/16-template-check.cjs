const { connect } = require('./lib/db.cjs');
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: leads } = await v2.query(`
      select id, v1_lead_id from v2_leads where org_id=12 and school_id=18 and form_id in (104,105)
      and v1_lead_id is not null order by v1_lead_id desc limit 3000`);
    const m=new Map(leads.map(r=>[r.v1_lead_id,r.id]));
    const { rows: t1 } = await v1.query(`
      select "leadId","templateId","createdAt","eventType" from "UserTimelines"
      where "leadId"=any($1::int[]) and "templateId" is not null`,[leads.map(r=>r.v1_lead_id)]);
    console.log('v1 timelines WITH templateId in sample:', t1.length);
    const { rows: t2 } = await v2.query(`
      select v2_lead_id,template_id,created_at,event_type from timelines where v2_lead_id=any($1::int[])`,[leads.map(r=>r.id)]);
    const by=new Map(t2.map(r=>[`${r.v2_lead_id}|${new Date(r.created_at).getTime()}`,r]));
    const res=new Map(); let nomatch=0;
    for (const a of t1){ const lid=m.get(a.leadId); if(!lid) continue;
      const b=by.get(`${lid}|${new Date(a.createdAt).getTime()}`);
      if(!b){nomatch++;continue;}
      const k = `v1 templateId=${a.templateId} -> v2 template_id=${b.template_id}`;
      res.set(k,(res.get(k)||0)+1); }
    console.log('matched:', [...res.values()].reduce((a,b)=>a+b,0), '| unmatched:', nomatch);
    [...res.entries()].sort((a,b)=>b[1]-a[1]).slice(0,20).forEach(([k,v])=>console.log('  ',String(v).padStart(4),k));
    const nullTarget=[...res.entries()].filter(([k])=>k.endsWith('null')).reduce((a,[,v])=>a+v,0);
    const nonNull=[...res.entries()].filter(([k])=>!k.endsWith('null')).reduce((a,[,v])=>a+v,0);
    console.log(`\n=> copied rows whose v2 template_id is NULL: ${nullTarget}; non-null: ${nonNull}`);

    const { rows: fk } = await v2.query(`select conname, pg_get_constraintdef(oid) d from pg_constraint where conrelid='timelines'::regclass and contype='f'`);
    console.log('\nFKs on timelines:', JSON.stringify(fk));
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
