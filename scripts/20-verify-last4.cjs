/** Read-only: DOB, multi-select course, declaration checkboxes, SAT checkbox. */
const { connect } = require('./lib/db.cjs');
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: apps } = await v2.query(`
      select l.id lead_id, l.v1_application_id from v2_leads l join under_graduate ug on ug.lead_id=l.id
      where l.org_id=12 and l.school_id=18 and l.type='applicant' and l.v1_application_id is not null
      order by l.v1_application_id desc limit 1500`);
    const leadByAm=new Map(apps.map(r=>[r.v1_application_id,r.lead_id]));
    const amIds=apps.map(r=>r.v1_application_id);
    // use raw text for the date column to dodge JS Date timezone shifts
    const { rows: ugs } = await v2.query(`
      select lead_id, date_of_birth::text dob, your_preferred_course_at_masters_union pref,
             declaration_checkbox1 d1, declaration_checkbox2 d2, criminal_declaration crim, terms_accepted terms,
             declaration_name dname, academic_sat_checkbox sat, academic_cuet_checkbox cuet, academic_jee_checkbox jee,
             academic_act_checkbox act, academic_ipmat_jipmat_checkbox ipmat, academic_enrolment_status enrol
      from under_graduate where lead_id=any($1::int[])`,[apps.map(r=>r.lead_id)]);
    const ugBy=new Map(ugs.map(r=>[r.lead_id,r]));
    const { rows: resp } = await v1.query(`
      select "applicationManagerId" am, "sectionFieldId" sfid, value from "ApplicationResponses"
      where "applicationManagerId"=any($1::int[]) and "sectionFieldId" in (3413,4706,4570,5038,4576,5292,11268,10283,3543,4573,5290)`,[amIds]);
    const g=(sf)=>resp.filter(r=>r.sfid===sf);
    const tally=(arr)=>{const m=new Map();arr.forEach(x=>m.set(x,(m.get(x)||0)+1));return [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6)};

    console.log('=== DOB (3413/4706) -> date_of_birth ===');
    let ok=0,bad=0,samples=[];
    for (const r of [...g(3413),...g(4706)]) { const ug=ugBy.get(leadByAm.get(r.am)); if(!ug||!r.value) continue;
      if (ug.dob===r.value) ok++; else { bad++; if(samples.length<5) samples.push(`${r.value} => ${ug.dob}`); } }
    console.log(' exact match:',ok,' mismatch:',bad, JSON.stringify(samples));

    console.log('\n=== 4570/5038 preferred course (multi-row checkbox) -> your_preferred_course_at_masters_union ===');
    const byAm=new Map();
    for (const r of [...g(4570),...g(5038)]) { if(!byAm.has(r.am)) byAm.set(r.am,[]); byAm.get(r.am).push(r.value); }
    let first=0,last=0,joined=0,none=0,other=[];
    for (const [am,vals] of byAm){ const ug=ugBy.get(leadByAm.get(am)); if(!ug) continue;
      const p=ug.pref;
      if (p===null) { none++; continue; }
      if (p===vals[0]) first++; else if (p===vals[vals.length-1]) last++;
      else if (p===vals.join(', ')||p===vals.join(',')) joined++; else if(other.length<4) other.push({vals,p}); }
    console.log(' applicants with this field:',byAm.size,'| v2 == FIRST value:',first,'| == LAST:',last,'| == joined:',joined,'| v2 null:',none);
    console.log(' other shapes:', JSON.stringify(other).slice(0,600));
    console.log(' multi-row cases only:', JSON.stringify([...byAm.entries()].filter(([,v])=>v.length>1).slice(0,3).map(([am,v])=>({am,vals:v,v2:ugBy.get(leadByAm.get(am))?.pref}))).slice(0,900));

    console.log('\n=== declaration checkboxes ===');
    for (const [sf,label] of [[4576,'criminal (4576)'],[5292,'criminal (5292)'],[11268,'terms (11268)']]) {
      const list=g(sf); const st={d1:0,d2:0,crim:0,terms:0,n:0,dname:0};
      for (const r of list){ const ug=ugBy.get(leadByAm.get(r.am)); if(!ug) continue; st.n++;
        if(ug.d1===true)st.d1++; if(ug.d2===true)st.d2++; if(ug.crim===true)st.crim++; if(ug.terms===true)st.terms++; if(ug.dname)st.dname++; }
      console.log(' ',label.padEnd(18),'n=',st.n,'-> decl_cb1 true:',st.d1,' decl_cb2 true:',st.d2,' criminal true:',st.crim,' terms true:',st.terms,' declaration_name set:',st.dname);
    }
    console.log('\n=== 4573/5290 Applicant Name -> declaration_name? ===');
    let dn=0,dnAll=0;
    for (const r of [...g(4573),...g(5290)]){ const ug=ugBy.get(leadByAm.get(r.am)); if(!ug||!r.value) continue; dnAll++;
      if((ug.dname||'').trim()===r.value.trim()) dn++; }
    console.log(' matched:',dn,'/',dnAll);

    console.log('\n=== 10283/3543 "Select" checkbox -> academic_*_checkbox ===');
    for (const r of [...g(10283),...g(3543)].slice(0,40)) { const ug=ugBy.get(leadByAm.get(r.am)); if(!ug) continue;
      console.log('  value=',JSON.stringify(r.value).padEnd(28),'sat=',ug.sat,'cuet=',ug.cuet,'jee=',ug.jee,'act=',ug.act,'ipmat=',ug.ipmat); }
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
