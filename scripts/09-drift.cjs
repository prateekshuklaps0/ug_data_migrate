/** Read-only: v1 UG leads already in v2 whose v1 row changed after the v2 snapshot. */
const { connect } = require('./lib/db.cjs');
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: v2Rows } = await v2.query(`
      select id, v1_lead_id, v1_application_id, type, updated_at, lead_stage_id, lead_sub_stage_id,
             counsellor_id, is_deleted, registered_mobile, registered_email, lead_type, source, medium, campaign
      from v2_leads where org_id=12 and school_id=18 and form_id in (104,105) and v1_lead_id is not null`);
    const ids = v2Rows.map(r=>r.v1_lead_id);
    const { rows: v1Rows } = await v1.query(`
      select id, "updatedAt", "leadStageId", "leadSubStageId", "assignTo", "isLeadDeleted",
             "registeredMobile", "registeredEmail", "leadType", source, medium, campaign,
             "applicationManagerId"
      from "manageLeads" where id = any($1::int[])`, [ids]);
    const by = new Map(v1Rows.map(r=>[r.id,r]));

    let drift=0, newerInV1=0;
    const reasons = new Map();
    const bump = k => reasons.set(k,(reasons.get(k)||0)+1);
    const convertedToApplicant = [];
    for (const r of v2Rows) {
      const a = by.get(r.v1_lead_id); if (!a) continue;
      const v1u = new Date(a.updatedAt), v2u = new Date(r.updated_at);
      if (v1u > v2u) { newerInV1++;
        let any=false;
        if (String(a.isLeadDeleted) !== String(r.is_deleted)) { bump('is_deleted differs'); any=true; }
        if ((a.registeredMobile||null) !== (r.registered_mobile||null)) { bump('mobile differs'); any=true; }
        if ((a.registeredEmail||null) !== (r.registered_email||null)) { bump('email differs'); any=true; }
        if ((a.leadType||null) !== (r.lead_type||null)) { bump('lead_type differs'); any=true; }
        if ((a.source||null) !== (r.source||null)) { bump('source differs'); any=true; }
        if (a.applicationManagerId && !r.v1_application_id) { bump('became APPLICANT in v1, still lead in v2'); any=true;
          convertedToApplicant.push({ v2_id:r.id, v1_lead_id:r.v1_lead_id, v1_app:a.applicationManagerId }); }
        if (any) drift++;
      }
    }
    console.log('migrated UG leads examined     :', v2Rows.length);
    console.log('v1 row updated AFTER v2 snapshot:', newerInV1);
    console.log('  ...with a visible field diff  :', drift);
    console.log('  breakdown:', JSON.stringify([...reasons.entries()].sort((a,b)=>b[1]-a[1])));
    console.log('\nleads that became APPLICANTS in v1 but are still plain leads in v2:', convertedToApplicant.length);
    console.log(JSON.stringify(convertedToApplicant.slice(0,20), null, 1));

    // Which v1 applications are these? are any submitted/paid?
    if (convertedToApplicant.length) {
      const { rows: apps } = await v1.query(`
        select id, "applicationFormId" form, "applicationStatus" st, "applicationFormSubmitted" sub,
               "paymentStatus" pay, "applicationNum" num, "createdAt", "formCompletionDate"
        from "ApplicationManager" where id = any($1::int[])`, [convertedToApplicant.map(r=>r.v1_app)]);
      console.log('\ntheir v1 applications:');
      apps.forEach(a=>console.log('  ', JSON.stringify(a)));
    }
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
