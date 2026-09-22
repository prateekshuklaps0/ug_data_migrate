/** Read-only: resolve the ambiguous mappings precisely. */
const { connect } = require('./lib/db.cjs');
const SOURCES = ['Collegewollege','Dekhocampus','collegedekho','Getmyuni','Shiksha','Kollegeapply','Zollege','whatsapp'];

(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: v2Rows } = await v2.query(`
      select id, v1_lead_id, form_id, program_id, batch_id, round_id, registered_email, city, state,
             country_code, lead_score, lead_stage_id, lead_sub_stage_id, counsellor_id, type, lead_type,
             status, updated_at, created_at, is_deleted, is_mobile_verified, is_email_verified,
             payment_status, is_chatbot_lead, human_handoff, registered_on, previous_lead_stage, reassigned_by
      from v2_leads
      where org_id=12 and school_id=18 and form_id in (104,105)
        and v1_lead_id is not null and type='lead' and v1_application_id is null
        and source = any($1::text[]) order by v1_lead_id desc limit 4000`, [SOURCES]);
    const ids = v2Rows.map(r => r.v1_lead_id);
    const { rows: v1Rows } = await v1.query(`
      select id, "applicationFormId", "programId", "roundId", "cohortId", "registeredEmail", city, state, school,
             "countryCode", "leadScore", "leadStageId", "leadSubStageId", "assignTo", "userType", "leadType",
             "updatedAt", "createdAt", "isLeadDeleted", "isMobileVerified", "isEmailVerified", "paymentStatus",
             "isChatbotLead", "humanHandoff", "registeredOn", "previousLeadStage", "reassignedBy", grade, grades
      from "manageLeads" where id = any($1::int[])`, [ids]);
    const by = new Map(v1Rows.map(r => [r.id, r]));

    const tally = (rows, f) => { const m=new Map(); rows.forEach(r=>{const k=f(r); m.set(k,(m.get(k)||0)+1)}); return [...m.entries()].sort((a,b)=>b[1]-a[1]); };
    const pair = (f) => tally(v2Rows.filter(r=>by.has(r.v1_lead_id)), r => f(by.get(r.v1_lead_id), r));

    console.log('== form -> program/batch/round ==');
    console.log(JSON.stringify(pair((a,b)=>`v1form${a.applicationFormId} v1prog${a.programId} v1round${a.roundId} v1cohort${a.cohortId} => v2form${b.form_id} prog${b.program_id} batch${b.batch_id} round${b.round_id}`)));

    console.log('\n== registered_email transform ==');
    console.log(JSON.stringify(pair((a,b)=> a.registeredEmail===b.registered_email ? 'EXACT'
      : (a.registeredEmail||'').toLowerCase().trim()===(b.registered_email||'') ? 'lower+trim'
      : (a.registeredEmail||'').trim()===(b.registered_email||'') ? 'trim'
      : (a.registeredEmail||'').toLowerCase()===(b.registered_email||'') ? 'lower' : 'OTHER')));
    const odd = v2Rows.filter(r=>{const a=by.get(r.v1_lead_id); return a && a.registeredEmail!==r.registered_email && (a.registeredEmail||'').toLowerCase().trim()!==(r.registered_email||'')});
    console.log('non-conforming samples:', JSON.stringify(odd.slice(0,5).map(r=>({v1:by.get(r.v1_lead_id).registeredEmail, v2:r.registered_email}))));

    console.log('\n== country_code ==');
    console.log(JSON.stringify(pair((a,b)=>`v1=${JSON.stringify(a.countryCode)} => v2=${JSON.stringify(b.country_code)}`)).slice(0,600));

    console.log('\n== lead_score ==');
    console.log(JSON.stringify(pair((a,b)=> a.leadScore===b.lead_score ? 'EXACT' : `v1=${a.leadScore} v2=${b.lead_score}`)).slice(0,600));

    console.log('\n== lead STAGE map (v1 -> v2) ==');
    console.log(JSON.stringify(pair((a,b)=>`${a.leadStageId} -> ${b.lead_stage_id}`)));
    console.log('\n== lead SUB-STAGE map (v1 -> v2) ==');
    console.log(JSON.stringify(pair((a,b)=>`${a.leadSubStageId} -> ${b.lead_sub_stage_id}`)));
    console.log('\n== previous_lead_stage map ==');
    console.log(JSON.stringify(pair((a,b)=>`${a.previousLeadStage} -> ${b.previous_lead_stage}`)).slice(0,800));

    console.log('\n== type / lead_type / status ==');
    console.log('userType->type  :', JSON.stringify(pair((a,b)=>`${a.userType} -> ${b.type}`)));
    console.log('leadType->ltype :', JSON.stringify(pair((a,b)=>`${a.leadType} -> ${b.lead_type}`)));
    console.log('status          :', JSON.stringify(tally(v2Rows, r=>r.status)));

    console.log('\n== city / state ==');
    console.log('city :', JSON.stringify(pair((a,b)=> (a.city||null)===(b.city||null) ? 'EXACT' : `v1city=${JSON.stringify(a.city)} v1school=${JSON.stringify(a.school)} v2city=${JSON.stringify(b.city)}`)).slice(0,700));
    console.log('state:', JSON.stringify(pair((a,b)=> (a.state||null)===(b.state||null) ? 'EXACT' : `v1=${JSON.stringify(a.state)} v2=${JSON.stringify(b.state)}`)).slice(0,500));

    console.log('\n== updated_at ==');
    console.log(JSON.stringify(pair((a,b)=> {
      const au=a.updatedAt?.toISOString(), bu=b.updated_at?.toISOString(), ac=a.createdAt?.toISOString();
      return au===bu?'== v1.updatedAt' : ac===bu?'== v1.createdAt' : bu>au?'v2 LATER (touched in v2)':'v2 earlier';
    })));

    console.log('\n== booleans / misc ==');
    for (const [k, f] of [
      ['is_mobile_verified', (a,b)=>`${a.isMobileVerified}->${b.is_mobile_verified}`],
      ['is_email_verified',  (a,b)=>`${a.isEmailVerified}->${b.is_email_verified}`],
      ['is_deleted',         (a,b)=>`${a.isLeadDeleted}->${b.is_deleted}`],
      ['payment_status',     (a,b)=>`${a.paymentStatus}->${b.payment_status}`],
      ['is_chatbot_lead',    (a,b)=>`${a.isChatbotLead}->${b.is_chatbot_lead}`],
      ['human_handoff',      (a,b)=>`${JSON.stringify(a.humanHandoff)}->${JSON.stringify(b.human_handoff)}`],
      ['registered_on',      (a,b)=> (a.registeredOn?.toISOString()||null)===(b.registered_on?.toISOString()||null)?'EXACT':`v1=${a.registeredOn} v2=${b.registered_on}`],
      ['reassigned_by',      (a,b)=>`${a.reassignedBy}->${b.reassigned_by}`],
    ]) console.log(k.padEnd(20), JSON.stringify(pair(f)).slice(0,420));

    console.log('\n== counsellor: v1 assignTo(uuid) -> v2 counsellor_id ==');
    const uuidToCid = new Map();
    for (const r of v2Rows) { const a = by.get(r.v1_lead_id); if (!a) continue;
      const k = a.assignTo; if (!uuidToCid.has(k)) uuidToCid.set(k, new Set()); uuidToCid.get(k).add(r.counsellor_id); }
    const multi = [...uuidToCid.entries()].filter(([,s])=>s.size>1);
    console.log('distinct v1 assignTo uuids in sample:', uuidToCid.size, '| uuids mapping to >1 v2 counsellor_id:', multi.length);
    console.log('sample map:', JSON.stringify([...uuidToCid.entries()].slice(0,6).map(([k,s])=>[k,[...s]])));
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
