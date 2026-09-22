const { connect } = require('./lib/db.cjs');
const sortK = o => { if (o===null||typeof o!=='object') return o;
  if (Array.isArray(o)) return o.map(sortK);
  return Object.keys(o).sort().reduce((a,k)=>{a[k]=sortK(o[k]);return a;},{}); };
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: leads } = await v2.query(`
      select id, v1_lead_id from v2_leads where org_id=12 and school_id=18 and form_id in (104,105)
      and v1_lead_id is not null order by v1_lead_id desc limit 400`);
    const m = new Map(leads.map(r=>[r.v1_lead_id,r.id]));
    const { rows: t1 } = await v1.query(`select "leadId",payload,"createdAt" from "UserTimelines" where "leadId"=any($1::int[])`,[leads.map(r=>r.v1_lead_id)]);
    const { rows: t2 } = await v2.query(`select v2_lead_id,metadata,created_at from timelines where v2_lead_id=any($1::int[])`,[leads.map(r=>r.id)]);
    const by = new Map(t2.map(r=>[`${r.v2_lead_id}|${new Date(r.created_at).getTime()}`,r]));
    let eq=0,ne=0,nul=0; const samples=[];
    for (const a of t1) { const lid=m.get(a.leadId); if(!lid) continue;
      const b=by.get(`${lid}|${new Date(a.createdAt).getTime()}`); if(!b) continue;
      if (a.payload===null){nul++;continue;}
      if (JSON.stringify(sortK(a.payload))===JSON.stringify(sortK(b.metadata))) eq++;
      else { ne++; if(samples.length<3) samples.push({v1:a.payload,v2:b.metadata}); } }
    console.log('metadata deep-equal (key-order-insensitive): equal=',eq,' differ=',ne,' v1null=',nul);
    if (samples.length) console.log('diff samples:', JSON.stringify(samples,null,1).slice(0,1500));

    // what does v2 store when v1 payload is null?
    const nullOnes = [];
    for (const a of t1) { const lid=m.get(a.leadId); if(!lid||a.payload!==null) continue;
      const b=by.get(`${lid}|${new Date(a.createdAt).getTime()}`); if(b) nullOnes.push(b.metadata); }
    const cnt = new Map(); nullOnes.forEach(x=>{const k=JSON.stringify(x);cnt.set(k,(cnt.get(k)||0)+1)});
    console.log('\nv2 metadata where v1 payload IS NULL:', JSON.stringify([...cnt.entries()].slice(0,5)));
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
