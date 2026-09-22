/** Read-only: how did the prior migration build an APPLICANT (v2_leads + under_graduate) from v1? */
const { connect } = require('./lib/db.cjs');
const norm = v => v===null||v===undefined ? null : v instanceof Date ? v.toISOString() : typeof v==='object' ? JSON.stringify(v) : typeof v==='boolean' ? String(v) : String(v);
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: apps } = await v2.query(`
      select * from v2_leads where org_id=12 and school_id=18 and form_id in (104,105)
        and type='applicant' and v1_application_id is not null
      order by v1_application_id desc limit 400`);
    console.log('migrated applicants sampled:', apps.length);
    const amIds = apps.map(r=>r.v1_application_id);
    const { rows: am } = await v1.query(`select * from "ApplicationManager" where id=any($1::int[])`,[amIds]);
    const amBy = new Map(am.map(r=>[r.id,r]));
    const { rows: ml } = await v1.query(`select * from "manageLeads" where id=any($1::int[])`,[apps.map(r=>r.v1_lead_id).filter(Boolean)]);
    const mlBy = new Map(ml.map(r=>[r.id,r]));

    // which v2_leads columns differ from the plain-lead mapping? show applicant-specific ones
    console.log('\n=== applicant-specific v2_leads columns ===');
    const t=(f)=>{const m=new Map();apps.forEach(r=>{const k=f(r);m.set(k,(m.get(k)||0)+1)});return [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6)};
    for (const c of ['type','user_id','v1_user_id','application_number','application_stage_id','application_sub_stage_id',
                     'application_form_initiated','application_form_submitted','form_completion_date','form_percentage_filled',
                     'is_payment_done','payment_status','total_amount','payment_completed_at','payment_mode','payment_method',
                     'applicant_name','application_registered_on','last_interacted_section','status','applicant_status','lead_type'])
      console.log('  ', c.padEnd(30), JSON.stringify(t(r=>norm(r[c]))).slice(0,220));

    // map application fields
    console.log('\n=== ApplicationManager -> v2_leads ===');
    const pairs = apps.filter(r=>amBy.has(r.v1_application_id));
    const chk = (label, f1, f2) => {
      const m=new Map(); pairs.forEach(r=>{const a=amBy.get(r.v1_application_id); const k=`${norm(f1(a))} -> ${norm(f2(r))}`; m.set(k,(m.get(k)||0)+1)});
      console.log('  ', label.padEnd(34), JSON.stringify([...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5)).slice(0,260));
    };
    chk('applicationNum->application_number', a=>a.applicationNum, r=>r.application_number);
    chk('userId->v1_user_id',        a=>a.userId, r=>r.v1_user_id);
    chk('formStatus/sub->app_submitted', a=>a.applicationFormSubmitted, r=>r.application_form_submitted);
    chk('applicationFormInitiated',  a=>a.applicationFormInitiated, r=>r.application_form_initiated);
    chk('formCompletionDate',        a=>a.formCompletionDate, r=>r.form_completion_date);
    chk('applicationStatus->form_pct',a=>a.applicationStatus, r=>r.form_percentage_filled);
    chk('paymentStatus',             a=>a.paymentStatus, r=>r.payment_status);
    chk('lastInteractedSection',     a=>a.lastInteractedSection, r=>r.last_interacted_section);
    chk('registeredOn->app_reg_on',  a=>a.registeredOn, r=>r.application_registered_on);
    chk('applicationStageId',        a=>a.applicationStageId, r=>r.application_stage_id);
    chk('applicantStatus',           a=>a.applicantStatus, r=>r.applicant_status);
    chk('paymentInitiated',          a=>a.paymentInitiated, r=>r.payment_initiated);
    chk('paymentMethod',             a=>a.paymentMethod, r=>r.payment_method);

    // under_graduate population for applicants
    const { rows: ug } = await v2.query(`select * from under_graduate where lead_id=any($1::int[])`,[apps.map(r=>r.id)]);
    console.log('\nunder_graduate rows for these applicants:', ug.length,'/',apps.length);
    if (ug.length){ const cols=Object.keys(ug[0]);
      const pop = cols.map(c=>[c, ug.filter(r=>r[c]!==null).length]).filter(([,n])=>n>0).sort((a,b)=>b[1]-a[1]);
      console.log('populated columns (', pop.length, 'of', cols.length, '):');
      console.log(pop.map(([c,n])=>`${c}=${n}`).join(', ')); }

    // v2 user rows for applicants: how were students created?
    const uids=[...new Set(apps.map(r=>r.user_id).filter(Boolean))].slice(0,5);
    if (uids.length){ const { rows: u } = await v2.query(`select id,email,name,role,user_type,v1_id,organization_id,school_id,status from users where id=any($1::int[])`,[uids]);
      console.log('\nsample v2 student users:', JSON.stringify(u,null,1).slice(0,1200)); }
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
