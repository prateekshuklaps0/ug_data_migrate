const fs=require('fs');
const { connect } = require('./lib/db.cjs');
(async()=>{
  const dir='C:/Users/Prateek/Desktop/Repos/data/export/2026-09-22T07-40-52-137Z';
  const ug=fs.readFileSync(dir+'/under_graduate_lead.ndjson','utf8').split('\n').filter(Boolean).map(l=>JSON.parse(l));
  const ids=ug.map(r=>r.v1_lead_id);
  const v2=await connect('v2'); const v1=await connect('v1');
  try{
    const { rows } = await v2.query(`
      select ug.id, ug.lead_id, ug.v1_lead_id, ug.org_id, ug.city, ug.state, ug.grade, ug.created_at, ug.updated_at,
             (select count(*)::int from v2_leads l where l.id = ug.lead_id) lead_row_exists,
             (select count(*)::int from v2_leads l where l.v1_lead_id = ug.v1_lead_id) v1lead_in_v2
      from under_graduate ug where ug.v1_lead_id = any($1::int[])`,[ids]);
    console.log('pre-existing under_graduate rows for exported leads:', rows.length);
    console.log(JSON.stringify(rows,null,1));
    for (const r of rows) {
      const { rows: s } = await v1.query(`select id,"registeredName","registeredEmail","applicationFormId",city,state,"createdAt","isLeadDeleted" from "manageLeads" where id=$1`,[r.v1_lead_id]);
      console.log('\n v1 source:', JSON.stringify(s[0]));
      if (r.lead_id) {
        const { rows: l } = await v2.query(`select id, v1_lead_id, org_id, school_id, form_id, type, registered_name, registered_email, is_deleted, created_at from v2_leads where id=$1`,[r.lead_id]);
        console.log(' v2 lead it points at:', JSON.stringify(l[0] || null));
      }
    }
    // how common is this overall?
    const { rows: tot } = await v2.query(`
      select count(*)::int total,
             count(*) filter (where lead_id is null)::int no_lead_id,
             count(*) filter (where lead_id is not null and not exists (select 1 from v2_leads l where l.id = ug.lead_id))::int dangling
      from under_graduate ug where org_id=12`);
    console.log('\nunder_graduate health (org 12):', JSON.stringify(tot[0]));
  } finally { await v2.end(); await v1.end(); }
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
