const B='C:/Users/Prateek/Desktop/Repos/new_crm_backend';
const fs=require('fs'); const dotenv=require(B+'/node_modules/dotenv'); const {Client}=require(B+'/node_modules/pg');
const e1=dotenv.parse(fs.readFileSync('C:/Users/Prateek/Desktop/Repos/old_crm_backend/.env'));
const e2=dotenv.parse(fs.readFileSync(B+'/.env'));
const conn=(e,host)=>new Client({host:host.trim(),port:5432,user:e.DB_USER.trim(),database:e.DB_NAME.trim(),password:e.DB_PASSWORD,ssl:{rejectUnauthorized:false}});
(async()=>{
  const c1=conn(e1,e1.DB_READ_HOST||e1.DB_HOST), c2=conn(e2,e2.DB_HOST);
  await c1.connect(); await c2.connect();
  for (const c of [c1,c2]) { await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY'); await c.query("SET statement_timeout='300s'"); }
  const v1=(await c1.query(`
    SELECT am.id am_id, am."applicationFormId" form, am."userId", am."isApplicationLeadDeleted" am_del,
           am."applicationFormInitiated" init, am."applicationFormSubmitted" sub, am."applicationStatus" st, am."createdAt" created,
           right(regexp_replace(u."mobileNumber",'\D','','g'),10) user_mob, u."isDeleted" user_del,
           (SELECT count(*) FROM "manageLeads" l WHERE l."applicationManagerId"=am.id) leads,
           (SELECT min(l.id) FROM "manageLeads" l WHERE l."applicationManagerId"=am.id) lead_id
      FROM "ApplicationManager" am LEFT JOIN users u ON u.id=am."userId"
     WHERE am."applicationFormId" IN (100,109)`)).rows;
  const v2=(await c2.query(`
    SELECT v1_application_id am_id, id, is_deleted, program_id, type, v1_lead_id FROM v2_leads WHERE v1_application_id IS NOT NULL`)).rows;
  await c1.end(); await c2.end();
  const inV2=new Map(v2.map(r=>[r.am_id,r]));
  const missing=v1.filter(r=>!inV2.has(r.am_id));
  const tally=(rows,f)=>{const t={};for(const r of rows){const k=f(r);t[k]=(t[k]||0)+1;}return t;};
  console.log('v1 AMs (forms 100/109):',v1.length,'| present in v2:',v1.length-missing.length,'| MISSING:',missing.length);
  console.table(tally(missing,r=>`form ${r.form} | v1_deleted=${r.am_del} | init=${r.init} sub=${r.sub} | leads=${r.leads}`));
  console.table(tally(missing.filter(r=>!r.am_del),r=>`form ${r.form} | status=${r.st} | created=${String(r.created).slice(0,7)}`));
  fs.writeFileSync('missing_ams.json',JSON.stringify(missing,null,1));
  console.log('sample live-missing:',JSON.stringify(missing.filter(r=>!r.am_del).slice(0,5),null,1));
})().catch(e=>{console.error(e.message);process.exit(1);});
