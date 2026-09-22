/** Read-only: characterise the 165 missing leads and 90 missing applications. */
const { connect } = require('./lib/db.cjs');
const V1_FORMS = [100, 109];

(async () => {
  const v1 = await connect('v1');
  const v2 = await connect('v2');
  try {
    const { rows: v1Leads } = await v1.query(`
      select id, "applicationFormId" form_id, "applicationManagerId" app_id, "isLeadDeleted" deleted,
             "userId" user_id, "createdAt" created_at, "registeredEmail" email,
             "registeredMobile" mobile, "registeredName" name, source, medium, campaign,
             "leadStageId" stage_id, "assignTo" assign_to
      from "manageLeads" where "applicationFormId" = any($1::int[])`, [V1_FORMS]);
    const { rows: v1Apps } = await v1.query(`
      select am.id, am."applicationFormId" form_id, am."userId" user_id,
             am."isApplicationLeadDeleted" deleted, am."createdAt" created_at,
             am."applicationStatus" status, am."applicationNum" app_num,
             am."paymentStatus" pay_status, am."applicationFormSubmitted" submitted,
             (select count(*) from "manageLeads" ml where ml."applicationManagerId" = am.id) as ml_count
      from "ApplicationManager" am where am."applicationFormId" = any($1::int[])`, [V1_FORMS]);

    const ids = v1Leads.map(r => r.id);
    const { rows: v2Any } = await v2.query(`select v1_lead_id from v2_leads where v1_lead_id = any($1::int[])`, [ids]);
    const have = new Set(v2Any.map(r => r.v1_lead_id));
    const missingLeads = v1Leads.filter(r => !have.has(r.id));

    const appIds = v1Apps.map(r => r.id);
    const { rows: v2AnyApp } = await v2.query(`select v1_application_id from v2_leads where v1_application_id = any($1::int[])`, [appIds]);
    const haveApp = new Set(v2AnyApp.map(r => r.v1_application_id));
    const missingApps = v1Apps.filter(r => !haveApp.has(r.id));

    const tally = (rows, f) => { const m = new Map(); rows.forEach(r=>{const k=f(r);m.set(k,(m.get(k)||0)+1)}); return [...m.entries()].sort((a,b)=>b[1]-a[1]); };

    console.log('\n########## 165 MISSING LEADS ##########');
    console.log('has an ApplicationManager link?', JSON.stringify(tally(missingLeads, r=>`app_id=${r.app_id!==null}`)));
    console.log('source:', JSON.stringify(tally(missingLeads, r=>r.source||'(null)')).slice(0,1200));
    console.log('medium:', JSON.stringify(tally(missingLeads, r=>r.medium||'(null)')).slice(0,800));
    console.log('assignTo set?', JSON.stringify(tally(missingLeads, r=>`assign=${r.assign_to!==null}`)));
    console.log('stage:', JSON.stringify(tally(missingLeads, r=>`stage${r.stage_id}`)));
    console.log('user_id null?', JSON.stringify(tally(missingLeads, r=>`user=${r.user_id!==null}`)));
    console.log('email null/blank?', JSON.stringify(tally(missingLeads, r=>`email=${r.email?'yes':'no'}`)));
    console.log('mobile null/blank?', JSON.stringify(tally(missingLeads, r=>`mobile=${r.mobile?'yes':'no'}`)));
    console.log('\nfirst 6 samples:');
    missingLeads.sort((a,b)=>new Date(a.created_at)-new Date(b.created_at)).slice(0,6)
      .forEach(r => console.log('  ', JSON.stringify(r)));
    console.log('\nlast 3 samples:');
    missingLeads.slice(-3).forEach(r => console.log('  ', JSON.stringify(r)));

    console.log('\n########## 90 MISSING APPLICATIONS ##########');
    console.log('manageLeads rows pointing at it:', JSON.stringify(tally(missingApps, r=>`ml_count=${r.ml_count}`)));
    console.log('deleted:', JSON.stringify(tally(missingApps, r=>`del=${r.deleted}`)));
    console.log('status:', JSON.stringify(tally(missingApps, r=>r.status||'(null)')));
    console.log('submitted:', JSON.stringify(tally(missingApps, r=>`sub=${r.submitted}`)));
    console.log('payment:', JSON.stringify(tally(missingApps, r=>r.pay_status||'(null)')));
    console.log('\nthe NON-deleted ones (the live gap):');
    missingApps.filter(r=>!r.deleted).forEach(r => console.log('  ', JSON.stringify(r)));

    // cross-check: for missing apps, is their manageLeads row present in v2 as type=lead?
    const mlForMissingApps = v1Leads.filter(r => r.app_id && missingApps.some(a=>a.id===r.app_id));
    console.log('\nmanageLeads rows that point to a MISSING application:', mlForMissingApps.length);
    const inV2 = mlForMissingApps.filter(r => have.has(r.id));
    console.log('  ...of which already in v2 (so v2 row exists but as a plain lead):', inV2.length);
    if (inV2.length) {
      const { rows } = await v2.query(`select id, v1_lead_id, v1_application_id, type, form_id, is_deleted, application_number from v2_leads where v1_lead_id = any($1::int[])`, [inV2.map(r=>r.id)]);
      console.log('  v2 state of those:', JSON.stringify(tally(rows, r=>`${r.type}|del=${r.is_deleted}|v1app=${r.v1_application_id!==null}`)));
      console.log('  samples:', JSON.stringify(rows.slice(0,5)));
    }
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
