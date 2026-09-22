/** Read-only: verify the specific sectionFields used by apps 730633/730634/730635. */
const { connect } = require('./lib/db.cjs');
const SF = [3405,3406,3407,3413,3414,3415,3417,3421,3423,3504,3505,3506,3508,3509,3511,3512,3514,3516,
            4562,4564,4565,4570,4573,4575,4576,4701,4702,4704,4706,4707,4708,4709,4713,4715,4878,4879,
            4880,4881,4882,4884,4885,4887,4888,4890,4891,5033,5035,5279,5280,5291,5295,6396,6397,7690,
            10256,10283,11252,11268];
const COLS = ['date_of_birth','gender','country_of_birth','alternate_phone_number','parent_name','parent_number',
  'parent_email_address','select_country','select_state','select_city','address_line_1','pincode','state','city',
  'is_the_above_address_same_as_your_permanent_address','are_your_grade_12th_results_out',
  'has_foreign_university_admit_or_studying_abroad','do_you_have_any_physical_disabilities',
  'where_did_you_hear_about_masters_union','discover_us_specific_channel_or_person','declaration_date',
  'declaration_name','declaration_checkbox1','declaration_checkbox2','criminal_declaration','terms_accepted',
  'school_name','please_specify_your_school','school_branch','grade','professional_qualification','top_5_things',
  'your_preferred_course_at_masters_union','class_10th_board','class_10th_school_name',
  'class_10th_month_and_year_of_passing','class_10th_marking_scheme','class_10th_percentage_cgpa_grades',
  'upload_your_class_10th_marksheet','upload_your_class_10th_marksheet_name','academic_sat_checkbox',
  'academic_cuet_checkbox','academic_jee_checkbox','academic_act_checkbox','academic_ipmat_jipmat_checkbox',
  'academic_enrolment_status','district','address_line_2','head_about_mu_other','type_of_disability'];

(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: apps } = await v2.query(`
      select l.id lead_id, l.v1_application_id from v2_leads l join under_graduate ug on ug.lead_id=l.id
      where l.org_id=12 and l.school_id=18 and l.type='applicant' and l.v1_application_id is not null
      order by l.v1_application_id desc limit 1200`);
    const amIds = apps.map(r=>r.v1_application_id);
    const leadByAm = new Map(apps.map(r=>[r.v1_application_id,r.lead_id]));
    const { rows: ugs } = await v2.query(`select * from under_graduate where lead_id=any($1::int[])`,[apps.map(r=>r.lead_id)]);
    const ugBy = new Map(ugs.map(r=>[r.lead_id,r]));
    const { rows: resp } = await v1.query(`
      select ar."applicationManagerId" am, ar."sectionFieldId" sfid, sf.label, sf.type, ar.value, ar."fileName", ar."dynamicTableData" dt
      from "ApplicationResponses" ar left join sectionfields sf on sf.id=ar."sectionFieldId"
      where ar."applicationManagerId"=any($1::int[]) and ar."sectionFieldId"=any($2::int[])`,[amIds, SF]);

    const bySf = new Map();
    for (const r of resp){ if(!bySf.has(r.sfid)) bySf.set(r.sfid,[]); bySf.get(r.sfid).push(r); }

    console.log('sfid | label | type -> best matching column(s), with the value pairing');
    for (const sfid of SF) {
      const list = bySf.get(sfid); if(!list||!list.length){ console.log(String(sfid).padStart(6),'(no data in sample)'); continue; }
      const label=list[0].label, type=list[0].type;
      const score=new Map(); const examples=new Map(); let cmp=0;
      for (const r of list) {
        const ug = ugBy.get(leadByAm.get(r.am)); if(!ug) continue;
        const raw = r.value; if (raw===null && !r.fileName && !r.dt) continue;
        cmp++;
        for (const c of COLS) {
          const got = ug[c]; if (got===null||got===undefined) continue;
          const g = got instanceof Date ? got.toISOString().slice(0,10) : typeof got==='boolean' ? (got?'Yes':'No') : String(got).trim();
          const want = raw===null ? (r.fileName??'') : String(raw).trim();
          const gBool = typeof got==='boolean' ? String(got) : null;
          if (g===want || (gBool && ((want==='Yes'&&gBool==='true')||(want==='No'&&gBool==='false'))) ||
              (r.fileName && String(got).trim()===String(r.fileName).trim())) {
            score.set(c,(score.get(c)||0)+1);
            if(!examples.has(c)) examples.set(c, `${JSON.stringify(want).slice(0,40)} => ${JSON.stringify(got).slice(0,40)}`);
          }
        }
      }
      const best=[...score.entries()].sort((a,b)=>b[1]-a[1]).slice(0,2);
      console.log(String(sfid).padStart(6), String(label||'').slice(0,40).padEnd(40), String(type).padEnd(11),
        best.length? best.map(([c,n])=>`${c} ${n}/${cmp}  [${examples.get(c)}]`).join('  |  ') : `(none of ${cmp})`);
    }

    // the class-10 table field specifically
    console.log('\n===== 4562 / 11239 Class 10th Academic Detail: dynamicTableData -> columns =====');
    const { rows: tbl } = await v1.query(`
      select ar."applicationManagerId" am, ar."dynamicTableData" dt from "ApplicationResponses" ar
      where ar."applicationManagerId"=any($1::int[]) and ar."sectionFieldId" in (4562,11239) and ar."dynamicTableData" is not null limit 6`,[amIds]);
    for (const r of tbl) {
      const ug = ugBy.get(leadByAm.get(r.am)); if(!ug) continue;
      console.log('\n am', r.am, 'cells:', JSON.stringify(r.dt?.rowsCellsData?.map(c=>c.value)));
      console.log('   ug: board=',JSON.stringify(ug.class_10th_board),' school=',JSON.stringify(ug.class_10th_school_name),
        ' passing=',JSON.stringify(ug.class_10th_month_and_year_of_passing),' scheme=',JSON.stringify(ug.class_10th_marking_scheme),
        ' score=',JSON.stringify(ug.class_10th_percentage_cgpa_grades));
    }
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
