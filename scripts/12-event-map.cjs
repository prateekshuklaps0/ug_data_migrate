/** Read-only: derive v1 UserTimelines.eventType.title -> v2 timelines.event_type mapping. */
const { connect } = require('./lib/db.cjs');
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: leads } = await v2.query(`
      select id, v1_lead_id from v2_leads
      where org_id=12 and school_id=18 and form_id in (104,105) and v1_lead_id is not null
      order by v1_lead_id desc limit 700`);
    const v2ById = new Map(leads.map(r=>[r.v1_lead_id, r.id]));
    const { rows: t1 } = await v1.query(`
      select id,"leadId","eventType",message,"leadStageId","templateId",payload,"createdAt","isDeleted"
      from "UserTimelines" where "leadId" = any($1::int[])`, [leads.map(r=>r.v1_lead_id)]);
    console.log('v1 timelines:', t1.length);
    const { rows: t2 } = await v2.query(`
      select v2_lead_id, v1_lead_id, event_type, title, description, metadata, lead_stage_id, template_id,
             created_by, v1_counsellor_id, created_at, org_id, school_id, lead_id, v1_timeline_id
      from timelines where v2_lead_id = any($1::int[])`, [leads.map(r=>r.id)]);
    console.log('v2 timelines:', t2.length);

    const key = (lead, ts) => `${lead}|${new Date(ts).getTime()}`;
    const v2By = new Map();
    for (const r of t2) { const k = key(r.v2_lead_id, r.created_at); if(!v2By.has(k)) v2By.set(k,[]); v2By.get(k).push(r); }

    const titleMap = new Map(), unmatched = new Map();
    let matched=0, miss=0;
    const mdSame = { equal:0, differ:0, v1null:0 };
    const stageMap = new Map();
    const cbMap = new Map();
    for (const a of t1) {
      const lid = v2ById.get(a.leadId); if (!lid) continue;
      const cands = v2By.get(key(lid, a.createdAt));
      const title = a.eventType?.title ?? '(null)';
      if (!cands || !cands.length) { miss++; unmatched.set(title,(unmatched.get(title)||0)+1); continue; }
      matched++;
      const m = cands[0];
      const k = `${title}  ==>  ${m.event_type}`;
      titleMap.set(k,(titleMap.get(k)||0)+1);
      // metadata
      const am = a.payload===null?null:JSON.stringify(a.payload);
      const bm = m.metadata===null?null:JSON.stringify(m.metadata);
      if (am===null) mdSame.v1null++; else if (am===bm) mdSame.equal++; else mdSame.differ++;
      if (a.leadStageId!==null || m.lead_stage_id!==null) stageMap.set(`${a.leadStageId} -> ${m.lead_stage_id}`, (stageMap.get(`${a.leadStageId} -> ${m.lead_stage_id}`)||0)+1);
      const uid = a.payload?.userId ?? null;
      cbMap.set(`${uid} -> created_by ${m.created_by} / v1_counsellor ${m.v1_counsellor_id}`, (cbMap.get(`${uid} -> created_by ${m.created_by} / v1_counsellor ${m.v1_counsellor_id}`)||0)+1);
    }
    console.log(`\nmatched by (lead, exact created_at): ${matched} | unmatched: ${miss}`);
    console.log('\n=== TITLE -> event_type ===');
    [...titleMap.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(' ', String(v).padStart(6), k));
    console.log('\n=== v1 titles with NO v2 counterpart (dropped?) ===');
    [...unmatched.entries()].sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>console.log(' ', String(v).padStart(6), k));
    console.log('\n=== metadata vs v1 payload ===', JSON.stringify(mdSame));
    console.log('\n=== leadStageId mapping ===');
    [...stageMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,25).forEach(([k,v])=>console.log(' ', String(v).padStart(6), k));
    console.log('\n=== payload.userId -> created_by (top 15) ===');
    [...cbMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([k,v])=>console.log(' ', String(v).padStart(6), k));
    console.log('\n=== v2 extras: org/school/lead_id/v1_timeline_id ===');
    const t = (f)=>{const m=new Map();t2.forEach(r=>{const k=f(r);m.set(k,(m.get(k)||0)+1)});return [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6)};
    console.log(' org_id:', JSON.stringify(t(r=>r.org_id)), '| school_id:', JSON.stringify(t(r=>r.school_id)));
    console.log(' lead_id:', JSON.stringify(t(r=>r.lead_id)), '| v1_timeline_id set:', JSON.stringify(t(r=>r.v1_timeline_id!==null)));
    console.log(' template_id:', JSON.stringify(t(r=>r.template_id)));
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
