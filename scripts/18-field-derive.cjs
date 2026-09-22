/** Read-only: derive v1 sectionFieldId -> under_graduate column, from migrated applicants. */
const { connect } = require('./lib/db.cjs');
const norm = v => { if (v===null||v===undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0,10);
  if (typeof v==='boolean') return v?'true':'false';
  return String(v).trim(); };
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: apps } = await v2.query(`
      select l.id lead_id, l.v1_application_id, l.v1_lead_id
      from v2_leads l join under_graduate ug on ug.lead_id=l.id
      where l.org_id=12 and l.school_id=18 and l.form_id in (104,105)
        and l.type='applicant' and l.v1_application_id is not null
      order by l.v1_application_id desc limit 500`);
    console.log('migrated applicants with an under_graduate row:', apps.length);
    const amIds = apps.map(r=>r.v1_application_id);
    const { rows: resp } = await v1.query(`
      select ar."applicationManagerId" am, ar."sectionFieldId" sfid, sf.label, sf.type, ar.value, ar."fileName"
      from "ApplicationResponses" ar left join sectionfields sf on sf.id=ar."sectionFieldId"
      where ar."applicationManagerId" = any($1::int[])`, [amIds]);
    console.log('v1 responses:', resp.length);
    const { rows: ugs } = await v2.query(`select * from under_graduate where lead_id = any($1::int[])`, [apps.map(r=>r.lead_id)]);
    const ugBy = new Map(ugs.map(r=>[r.lead_id,r]));
    const leadByAm = new Map(apps.map(r=>[r.v1_application_id, r.lead_id]));

    // group responses by sfid
    const bySf = new Map();
    for (const r of resp) { if(!bySf.has(r.sfid)) bySf.set(r.sfid,[]); bySf.get(r.sfid).push(r); }

    const ugCols = ugs.length ? Object.keys(ugs[0]).filter(c=>!['id','org_id','lead_id','created_at','updated_at','v1_lead_id'].includes(c)) : [];
    const out = [];
    for (const [sfid, list] of [...bySf.entries()].sort((a,b)=>a[0]-b[0])) {
      const label = list[0].label, type = list[0].type;
      const scores = new Map();
      let comparable = 0;
      for (const r of list) {
        const lid = leadByAm.get(r.am); const ug = lid && ugBy.get(lid); if (!ug) continue;
        const want = norm(r.value); if (want===null||want==='') continue;
        comparable++;
        for (const c of ugCols) { if (norm(ug[c])===want) scores.set(c,(scores.get(c)||0)+1); }
      }
      const best = [...scores.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3);
      out.push({ sfid, label, type, n:list.length, comparable, best });
    }
    console.log('\nsfid | label | type | n | matched column(s)');
    for (const r of out) {
      const top = r.best.length ? r.best.map(([c,n])=>`${c}(${n}/${r.comparable})`).join(' , ') : '(no column matched)';
      console.log(String(r.sfid).padStart(5), '|', String(r.label||'').slice(0,42).padEnd(42), '|', String(r.type||'').padEnd(10), '|', String(r.n).padStart(4), '|', top);
    }
    // file fields
    console.log('\n--- responses carrying fileName (file uploads) ---');
    const files = resp.filter(r=>r.fileName);
    const fm = new Map(); files.forEach(r=>fm.set(`${r.sfid}|${r.label}`,(fm.get(`${r.sfid}|${r.label}`)||0)+1));
    console.log(JSON.stringify([...fm.entries()].slice(0,20)));
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
