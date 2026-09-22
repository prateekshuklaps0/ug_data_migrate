const { connect } = require('./lib/db.cjs');
const M = require('./lib/maps.cjs');
const n = v => v===null||v===undefined?null:(v instanceof Date? v.toISOString(): String(v));
(async()=>{
  const v1=await connect('v1'), v2=await connect('v2');
  try{
    // rows untouched since migration: v2.updatedAt == v1.updatedAt
    const { rows: t2 } = await v2.query(`
      select t.*, l.v1_lead_id from "ApplicationActivityTrackers" t join v2_leads l on l.id=t."leadId"
      where l.org_id=$1 and l.school_id=$2 and t."v1_leadId" is not null order by t.id desc limit 3000`,[M.ORG_V2,M.SCHOOL_V2]);
    const { rows: t1 } = await v1.query(`select * from "applicationActivityTracker" where "leadId"=any($1::int[])`,[t2.map(r=>r.v1_lead_id)]);
    const by=new Map(t1.map(r=>[r.leadId,r]));
    const untouched=t2.filter(r=>{const a=by.get(r.v1_lead_id);return a && n(a.updatedAt)===n(r.updatedAt)});
    console.log(`sampled ${t2.length}; untouched since migration: ${untouched.length}`);
    const cols=['applicationForm_start_date','payment_Initiated_date','payment_last_Initiated_date',
      'counsellor_first_activity_date','counsellor_last_activity_date','application_fee_paidOn',
      'application_last_activity_date','lastLeadStageUpdated','firstLeadStageUpdated',
      'applicationFormSubmittedOn','createdAt','updatedAt'];
    console.log('\nfidelity on rows untouched since migration:');
    for(const c of cols){
      let eq=0,ne=0,both=0;
      for(const r of untouched){const a=by.get(r.v1_lead_id);
        if(a[c]===undefined){console.log('  ',c,'-> not present in v1'); break;}
        if(a[c]!==null||r[c]!==null) both++;
        if(n(a[c])===n(r[c])) eq++; else ne++;}
      console.log(`  ${c.padEnd(34)} identical ${String(eq).padStart(5)}  differ ${String(ne).padStart(4)}  (non-null on either side: ${both})`);
    }
    console.log('\nv1 columns with NO v2 destination (dropped):');
    const v2cols=new Set(Object.keys(t2[0]||{}));
    console.log('  ', Object.keys(t1[0]||{}).filter(c=>!v2cols.has(c)&&!['id','leadId','applicationId'].includes(c)).join(', '));
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
