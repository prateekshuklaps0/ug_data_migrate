/** Read-only: for the 165 missing leads, check every mapping input resolves. */
const { connect } = require('./lib/db.cjs');
const V1_FORMS=[100,109];
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: all } = await v1.query(`select id from "manageLeads" where "applicationFormId"=any($1::int[])`, [V1_FORMS]);
    const { rows: got } = await v2.query(`select v1_lead_id from v2_leads where v1_lead_id=any($1::int[])`, [all.map(r=>r.id)]);
    const have = new Set(got.map(r=>r.v1_lead_id));
    const missIds = all.map(r=>r.id).filter(id=>!have.has(id));
    console.log('missing lead ids:', missIds.length);

    const { rows: miss } = await v1.query(`select * from "manageLeads" where id = any($1::int[]) order by "createdAt"`, [missIds]);

    const tally = (f) => { const m=new Map(); miss.forEach(r=>{const k=f(r); m.set(k,(m.get(k)||0)+1)}); return [...m.entries()].sort((a,b)=>b[1]-a[1]); };

    console.log('\n-- distinct assignTo uuids among the missing --');
    const uuids = [...new Set(miss.map(r=>r.assignTo).filter(Boolean))];
    console.log('count:', uuids.length);
    // observed map from already-migrated UG rows
    const { rows: obsV2 } = await v2.query(`
      select v1_lead_id, counsellor_id from v2_leads
      where org_id=12 and school_id=18 and form_id in (104,105) and v1_lead_id is not null and counsellor_id is not null`);
    const { rows: obsV1 } = await v1.query(`select id,"assignTo" from "manageLeads" where id=any($1::int[])`, [obsV2.map(r=>r.v1_lead_id)]);
    const a2u = new Map(obsV1.map(r=>[r.id, r.assignTo]));
    const obs = new Map();
    for (const r of obsV2) { const u=a2u.get(r.v1_lead_id); if(!u) continue;
      if(!obs.has(u)) obs.set(u,new Map()); const m=obs.get(u); m.set(r.counsellor_id,(m.get(r.counsellor_id)||0)+1); }
    const { rows: v1u } = await v1.query(`select id, uuid, email, name from users where uuid=any($1::uuid[])`,[uuids]);
    const v1uBy = new Map(v1u.map(u=>[u.uuid,u]));
    let unmapped=0;
    for (const u of uuids) {
      const n = miss.filter(r=>r.assignTo===u).length;
      const c = obs.get(u);
      const top = c ? [...c.entries()].sort((a,b)=>b[1]-a[1]) : null;
      const who = v1uBy.get(u);
      if (!top) unmapped++;
      console.log(' ', `n=${String(n).padStart(3)}`, u, '|', (who?who.email:'(?)').padEnd(40),
        '->', top ? `v2 user ${top[0][0]} (seen ${top[0][1]}x${top.length>1?', alts '+JSON.stringify(top.slice(1,3)):''})` : '*** NO OBSERVED MAPPING ***');
    }
    console.log('uuids with no observed mapping:', unmapped);

    console.log('\n-- other inputs --');
    for (const [label, f] of [
      ['form',       r=>r.applicationFormId],
      ['programId',  r=>r.programId],
      ['roundId',    r=>r.roundId],
      ['cohortId',   r=>r.cohortId],
      ['leadStageId',r=>r.leadStageId],
      ['leadSubStageId', r=>r.leadSubStageId],
      ['userType',   r=>r.userType],
      ['leadType',   r=>r.leadType],
      ['isLeadDeleted', r=>r.isLeadDeleted],
      ['countryCode',r=>JSON.stringify(r.countryCode)],
      ['paymentStatus', r=>r.paymentStatus],
      ['userId null',r=>r.userId===null],
      ['applicationManagerId', r=>r.applicationManagerId===null?'null':'SET '+r.applicationManagerId],
      ['isChatbotLead', r=>r.isChatbotLead],
      ['humanHandoff',  r=>r.humanHandoff],
      ['isMobileVerified', r=>r.isMobileVerified],
      ['isEmailVerified',  r=>r.isEmailVerified],
      ['leadScore', r=>r.leadScore],
      ['city set',  r=>r.city!==null],
      ['state set', r=>r.state!==null],
      ['registeredOn null', r=>r.registeredOn===null],
      ['leadPayload null',  r=>r.leadPayload===null],
      ['sourceUrl null',    r=>r.sourceUrl===null],
      ['previousLeadStage', r=>r.previousLeadStage],
      ['reassignedBy',      r=>r.reassignedBy],
      ['widgetId',          r=>r.widgetId],
      ['grade',             r=>JSON.stringify(r.grade)],
      ['grades',            r=>JSON.stringify(r.grades)],
      ['programEligible',   r=>JSON.stringify(r.programEligible)],
      ['leadOrigin',        r=>JSON.stringify(r.leadOrigin)],
      ['leadDevice',        r=>JSON.stringify(r.leadDevice)],
      ['isoCode',           r=>JSON.stringify(r.isoCode)],
      ['leadCountry',       r=>JSON.stringify(r.leadCountry)],
      ['tags',              r=>JSON.stringify(r.tags)],
      ['isInboundLead',     r=>r.isInboundLead],
      ['concatSMC null',    r=>r.concatSMC===null],
    ]) console.log('  ', label.padEnd(22), JSON.stringify(tally(f)).slice(0,300));

    // duplicate risk: do email/mobile of these already exist in v2 UG?
    const emails = [...new Set(miss.map(r=>(r.registeredEmail||'').toLowerCase()).filter(e=>e&&e!=='na'))];
    const mobiles = [...new Set(miss.map(r=>r.registeredMobile).filter(m=>m&&m!=='NA'))];
    const { rows: dupE } = await v2.query(`
      select lower(registered_email) e, form_id, count(*) from v2_leads
      where org_id=12 and school_id=18 and lower(registered_email)=any($1::text[]) group by 1,2`, [emails]);
    const { rows: dupM } = await v2.query(`
      select registered_mobile m, form_id, count(*) from v2_leads
      where org_id=12 and school_id=18 and registered_mobile=any($1::text[]) group by 1,2`, [mobiles]);
    console.log('\n-- duplicate risk against existing v2 UG rows --');
    console.log('  distinct emails in batch:', emails.length, '| already present in v2 UG (email,form) pairs:', dupE.length);
    console.log('  distinct mobiles in batch:', mobiles.length, '| already present in v2 UG (mobile,form) pairs:', dupM.length);

    // same-form collisions specifically
    const missKey = new Set(miss.map(r=>`${(r.registeredEmail||'').toLowerCase()}|${r.applicationFormId===100?104:105}`));
    const collide = dupE.filter(d=>missKey.has(`${d.e}|${d.form_id}`));
    console.log('  SAME email+form already in v2:', collide.length, JSON.stringify(collide.slice(0,15)));
    const missKeyM = new Set(miss.map(r=>`${r.registeredMobile}|${r.applicationFormId===100?104:105}`));
    const collideM = dupM.filter(d=>missKeyM.has(`${d.m}|${d.form_id}`));
    console.log('  SAME mobile+form already in v2:', collideM.length, JSON.stringify(collideM.slice(0,15)));
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
