/** Read-only: are v2 UG notes/timelines copies of v1, or v2-native? */
const { connect } = require('./lib/db.cjs');
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    // pick migrated UG leads that HAVE v1 notes
    const { rows: cand } = await v2.query(`
      select id, v1_lead_id from v2_leads
      where org_id=12 and school_id=18 and form_id in (104,105) and v1_lead_id is not null
      order by v1_lead_id desc limit 3000`);
    const v1ids = cand.map(r=>r.v1_lead_id);
    const { rows: n1 } = await v1.query(`
      select id, "leadId", "userId", message, "createdAt" from "Notes" where "leadId"=any($1::int[]) order by "leadId", id`, [v1ids]);
    console.log('v1 Notes in sample:', n1.length, 'over', new Set(n1.map(r=>r.leadId)).size, 'leads');
    if (!n1.length) { console.log('no v1 notes in this slice'); }
    const pick = n1[0];
    if (pick) {
      const v2lead = cand.find(c=>c.v1_lead_id===pick.leadId);
      const { rows: n2 } = await v2.query(`
        select id, v2_lead_id, v1_lead_id, v1_note_id, admin_id, v1_counsellor_id, content, created_at
        from notes where v2_lead_id=$1 order by created_at`, [v2lead.id]);
      const { rows: n1all } = await v1.query(`select id, message, "createdAt", "userId" from "Notes" where "leadId"=$1 order by id`, [pick.leadId]);
      console.log('\n--- lead v1', pick.leadId, '/ v2', v2lead.id, '---');
      console.log('v1 Notes  :', JSON.stringify(n1all, null, 1).slice(0,1200));
      console.log('v2 notes  :', JSON.stringify(n2, null, 1).slice(0,1600));
    }

    // same for timelines
    const { rows: tl } = await v1.query(`
      select "leadId", count(*)::int n from "UserTimelines" where "leadId"=any($1::int[]) group by 1 order by 2 desc limit 3`, [v1ids]);
    console.log('\nv1 UserTimelines busiest leads in sample:', JSON.stringify(tl));
    if (tl.length) {
      const lid = tl[0].leadId;
      const v2lead = cand.find(c=>c.v1_lead_id===lid);
      const { rows: t1 } = await v1.query(`
        select id, "eventType", message, "leadStageId", "createdAt" from "UserTimelines" where "leadId"=$1 order by id limit 6`, [lid]);
      const { rows: t2 } = await v2.query(`
        select id, v2_lead_id, v1_lead_id, v1_timeline_id, event_type, title, description, created_by, v1_counsellor_id, created_at
        from timelines where v2_lead_id=$1 order by created_at limit 12`, [v2lead.id]);
      console.log('\n--- timelines lead v1', lid, '/ v2', v2lead.id, '---');
      console.log('v1 UserTimelines:', JSON.stringify(t1, null, 1).slice(0,1500));
      console.log('v2 timelines    :', JSON.stringify(t2, null, 1).slice(0,2000));
      const { rows: c1 } = await v1.query(`select count(*)::int n from "UserTimelines" where "leadId"=$1`,[lid]);
      const { rows: c2 } = await v2.query(`select count(*)::int n from timelines where v2_lead_id=$1`,[v2lead.id]);
      console.log('counts -> v1:', c1[0].n, ' v2:', c2[0].n);
    }
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
