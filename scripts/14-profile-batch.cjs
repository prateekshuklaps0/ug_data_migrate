/** Read-only: full profile of everything that would move for the 165 leads. */
const { connect } = require('./lib/db.cjs');
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: all } = await v1.query(`select id from "manageLeads" where "applicationFormId" in (100,109)`);
    const { rows: got } = await v2.query(`select v1_lead_id from v2_leads where v1_lead_id=any($1::int[])`,[all.map(r=>r.id)]);
    const have = new Set(got.map(r=>r.v1_lead_id));
    const miss = all.map(r=>r.id).filter(i=>!have.has(i));
    console.log('MISSING LEADS:', miss.length);

    const { rows: tl } = await v1.query(`
      select id,"leadId","eventType",message,"leadStageId","templateId",payload,"createdAt","isDeleted"
      from "UserTimelines" where "leadId"=any($1::int[]) order by "leadId","createdAt"`,[miss]);
    console.log('UserTimelines to migrate:', tl.length);
    const t=(rows,f)=>{const m=new Map();rows.forEach(r=>{const k=f(r);m.set(k,(m.get(k)||0)+1)});return [...m.entries()].sort((a,b)=>b[1]-a[1])};
    console.log('  by eventType.title :', JSON.stringify(t(tl,r=>r.eventType?.title??'(null)')));
    console.log('  payload null       :', JSON.stringify(t(tl,r=>r.payload===null)));
    console.log('  leadStageId        :', JSON.stringify(t(tl,r=>r.leadStageId)));
    console.log('  templateId         :', JSON.stringify(t(tl,r=>r.templateId)));
    console.log('  isDeleted          :', JSON.stringify(t(tl,r=>r.isDeleted)));
    console.log('  payload.userId     :', JSON.stringify(t(tl,r=>r.payload?.userId ?? null)));

    // do those v1 user ids resolve to v2 users?
    const uids=[...new Set(tl.map(r=>r.payload?.userId).filter(x=>x!=null))];
    const { rows: vu } = await v2.query(`select id, v1_id, email, name from users where v1_id = any($1::int[])`,[uids]);
    console.log('  distinct payload.userId:', uids.length, '| resolved in v2 via users.v1_id:', vu.length);
    const resolved=new Set(vu.map(r=>r.v1_id));
    console.log('  UNRESOLVED v1 user ids :', uids.filter(u=>!resolved.has(u)));
    console.log('  map:', JSON.stringify(vu.map(r=>`${r.v1_id}->${r.id} ${r.email}`)));

    // template ids used
    const tids=[...new Set(tl.map(r=>r.templateId).filter(x=>x!=null))];
    if (tids.length) {
      const { rows: tmpl } = await v2.query(`select id from "communicationTemplates" where id = any($1::int[])`,[tids]).catch(()=>({rows:[]}));
      console.log('  templateIds used:', JSON.stringify(tids), '| existing in v2 communicationTemplates:', JSON.stringify(tmpl.map(r=>r.id)));
    }

    // notes
    const { rows: nt } = await v1.query(`select id,"leadId","userId",message,"createdAt" from "Notes" where "leadId"=any($1::int[])`,[miss]);
    console.log('\nNotes to migrate:', nt.length, JSON.stringify(nt));
    if (nt.length){ const nu=[...new Set(nt.map(r=>r.userId).filter(Boolean))];
      const { rows: nvu } = await v2.query(`select id,v1_id,email from users where v1_id=any($1::int[])`,[nu]);
      console.log('  note author resolves:', JSON.stringify(nvu)); }

    // tags
    const { rows: tg } = await v1.query(`select id,tags from "manageLeads" where id=any($1::int[]) and tags is not null and array_length(tags,1)>0`,[miss]);
    console.log('\nLeads with tags:', tg.length, JSON.stringify(tg));
    if (tg.length){ const names=[...new Set(tg.flatMap(r=>r.tags))];
      const { rows: vt } = await v2.query(`select id,name,org_id from tags where name = any($1::text[])`,[names]);
      console.log('  v2 tags matching by name:', JSON.stringify(vt));
      const { rows: v1t } = await v1.query(`select id,"tagName",slug,"organizationId" from "LeadTags" where "tagName"=any($1::text[])`,[names]);
      console.log('  v1 LeadTags:', JSON.stringify(v1t)); }

    // how did the prior migration link lead_tags? sample
    const { rows: lt } = await v2.query(`
      select lt.*, tg.name from lead_tags lt join tags tg on tg.id=lt.tag_id
      where lt.org_id=12 and lt.school_id=18 and lt.v1_lead_id is not null limit 5`);
    console.log('\nsample migrated lead_tags rows:', JSON.stringify(lt,null,1).slice(0,1200));

    // under_graduate payload for these leads: what v1 fields feed it?
    const { rows: ml } = await v1.query(`select id, city, state, grade, "leadCountry", "programEligible", school from "manageLeads" where id=any($1::int[])`,[miss]);
    console.log('\nunder_graduate inputs across the 165:');
    for (const k of ['city','state','grade','leadCountry','programEligible','school'])
      console.log('  ', k.padEnd(16), JSON.stringify(t(ml,r=>r[k]===null?'(null)':'SET')));
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
