const B='C:/Users/Prateek/Desktop/Repos/new_crm_backend';
const fs=require('fs'); const dotenv=require(B+'/node_modules/dotenv'); const {Client}=require(B+'/node_modules/pg');
const e1=dotenv.parse(fs.readFileSync('C:/Users/Prateek/Desktop/Repos/old_crm_backend/.env'));
const e2=dotenv.parse(fs.readFileSync(B+'/.env'));
const MOBS=fs.readFileSync('mobiles.txt','utf8').trim().split(',');
const conn=(e,host)=>new Client({host:host.trim(),port:5432,user:e.DB_USER.trim(),database:e.DB_NAME.trim(),password:e.DB_PASSWORD,ssl:{rejectUnauthorized:false}});
(async()=>{
  const c1=conn(e1,e1.DB_READ_HOST||e1.DB_HOST), c2=conn(e2,e2.DB_HOST);
  await c1.connect(); await c2.connect();
  for (const c of [c1,c2]) { await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY'); await c.query("SET statement_timeout='300s'"); }
  const v1=(await c1.query(`
    SELECT right(regexp_replace(u."mobileNumber",'\D','','g'),10) reported_mobile, u.id v1_user_id, u.name user_name, u.email user_email,
           am.id v1_am_id, am."applicationFormId" v1_form, am."isApplicationLeadDeleted" v1_app_deleted,
           am."applicationFormSubmitted" v1_submitted, am."applicationStatus" v1_status, am."createdAt" v1_created,
           l.id v1_lead_id, right(regexp_replace(l."registeredMobile",'\D','','g'),10) v1_lead_mobile, l."isLeadDeleted" v1_lead_deleted
      FROM users u
      JOIN "ApplicationManager" am ON am."userId"=u.id AND am."applicationFormId" IN (100,109)
      LEFT JOIN "manageLeads" l ON l."applicationManagerId"=am.id
     WHERE right(regexp_replace(u."mobileNumber",'\D','','g'),10) = ANY($1::text[]) ORDER BY 1, am.id`,[MOBS])).rows;
  const v2=(await c2.query(`
    SELECT l.v1_application_id am_id, l.id v2_lead_id, l.is_deleted v2_deleted, l.type v2_type, l.program_id, l.form_id,
           l.application_number, l.registered_name, l.registered_email,
           right(regexp_replace(l.registered_mobile,'\D','','g'),10) v2_registered_mobile,
           right(regexp_replace(u.phone,'\D','','g'),10) v2_user_phone, u.id v2_user_id,
           (SELECT to_char(max(t.created_at) AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI') FROM timelines t WHERE t.v2_lead_id=l.id AND t.event_type='soft_deleted') deleted_at_ist,
           (SELECT coalesce(uu.email,'') FROM timelines t LEFT JOIN users uu ON uu.id=t.created_by WHERE t.v2_lead_id=l.id AND t.event_type='soft_deleted' ORDER BY t.created_at DESC LIMIT 1) deleted_by
      FROM v2_leads l LEFT JOIN users u ON u.id=l.user_id WHERE l.v1_application_id = ANY($1::int[])`,[v1.map(r=>r.v1_am_id)])).rows;
  await c1.end(); await c2.end();
  const byAm=new Map(v2.map(r=>[r.am_id,r]));
  const rows=v1.map(r=>{
    const m=byAm.get(r.v1_am_id)||{};
    let status, fix;
    if(!m.v2_lead_id){ status='MISSING_IN_V2'; fix='re-migrate this application'; }
    else if(m.v2_deleted && !r.v1_app_deleted){ status='DELETED_IN_V2_ONLY'; fix=`restore v2 lead ${m.v2_lead_id} (set is_deleted=false)`; }
    else if(m.v2_deleted && r.v1_app_deleted){ status='DELETED_IN_BOTH'; fix='none - deleted in v1 too'; }
    else if(m.v2_registered_mobile!==r.reported_mobile){ status='PRESENT_BUT_MOBILE_MISMATCH'; fix=`v2 searchable mobile is ${m.v2_registered_mobile} (v1 lead number); reported number ${r.reported_mobile} is only on the linked user`; }
    else { status='PRESENT_OK'; fix='none'; }
    return {reported_mobile:r.reported_mobile, status, fix, v2_lead_id:m.v2_lead_id??'', v2_deleted:m.v2_deleted??'', v2_application_number:m.application_number??'',
      student_name:m.registered_name||r.user_name, student_email:m.registered_email||r.user_email,
      v2_registered_mobile:m.v2_registered_mobile??'', v2_user_phone:m.v2_user_phone??'', v2_program:m.program_id??'', v2_form:m.form_id??'',
      v2_deleted_at_ist:m.deleted_at_ist??'', v2_deleted_by:m.deleted_by??'',
      v1_am_id:r.v1_am_id, v1_form:r.v1_form, v1_lead_id:r.v1_lead_id??'', v1_lead_mobile:r.v1_lead_mobile??'', v1_app_deleted:r.v1_app_deleted,
      v1_submitted:r.v1_submitted, v1_status:r.v1_status, v1_created:String(r.v1_created).slice(0,10), v1_user_id:r.v1_user_id};
  });
  const order={MISSING_IN_V2:0,DELETED_IN_V2_ONLY:1,PRESENT_BUT_MOBILE_MISMATCH:2,DELETED_IN_BOTH:3,PRESENT_OK:4};
  rows.sort((a,b)=>order[a.status]-order[b.status]||a.reported_mobile.localeCompare(b.reported_mobile));
  const cols=Object.keys(rows[0]);
  const esc=v=>{const s=v==null?'':String(v);return /[",\n\r]/.test(s)?`"${s.replace(/"/g,'""')}"`:s;};
  fs.writeFileSync(process.argv[2],'\uFEFF'+[cols.join(','),...rows.map(r=>cols.map(k=>esc(r[k])).join(','))].join('\r\n')+'\r\n');
  const t={}; for(const r of rows){t[r.status]=(t[r.status]||0)+1;} console.table(t);
  console.log('rows:',rows.length,'distinct reported mobiles:',new Set(rows.map(r=>r.reported_mobile)).size,'->',process.argv[2]);
  console.table(rows.filter(r=>r.status!=='PRESENT_BUT_MOBILE_MISMATCH').map(r=>({mob:r.reported_mobile,status:r.status,v2:r.v2_lead_id,v1_am:r.v1_am_id,del_v1:r.v1_app_deleted,del_at:r.v2_deleted_at_ist})));
})().catch(e=>{console.error(e.message);process.exit(1);});
