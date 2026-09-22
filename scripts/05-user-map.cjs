/** Read-only: build + validate the v1 user -> v2 user mapping used for counsellor_id. */
const { connect } = require('./lib/db.cjs');
const SOURCES = ['Collegewollege','Dekhocampus','collegedekho','Getmyuni','Shiksha','Kollegeapply','Zollege','whatsapp'];

(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    // empirical pairs: v1 assignTo uuid -> v2 counsellor_id
    const { rows: v2Rows } = await v2.query(`
      select v1_lead_id, counsellor_id from v2_leads
      where org_id=12 and school_id=18 and form_id in (104,105)
        and v1_lead_id is not null and counsellor_id is not null
        and source = any($1::text[]) order by v1_lead_id desc limit 20000`, [SOURCES]);
    const { rows: v1Rows } = await v1.query(`
      select id, "assignTo" from "manageLeads" where id = any($1::int[])`, [v2Rows.map(r=>r.v1_lead_id)]);
    const by = new Map(v1Rows.map(r=>[r.id, r.assignTo]));
    const observed = new Map();
    for (const r of v2Rows) { const u = by.get(r.v1_lead_id); if (!u) continue;
      if (!observed.has(u)) observed.set(u, new Map());
      const m = observed.get(u); m.set(r.counsellor_id, (m.get(r.counsellor_id)||0)+1); }
    console.log('observed distinct v1 assignTo uuids:', observed.size);

    const uuids = [...observed.keys()];
    const { rows: v1Users } = await v1.query(`
      select id, uuid, email, name, "mobileNumber" from users where uuid = any($1::uuid[])`, [uuids]);
    console.log('v1 users resolved from uuid:', v1Users.length, '/', uuids.length);
    const v1UserByUuid = new Map(v1Users.map(u=>[u.uuid, u]));

    const emails = v1Users.map(u => (u.email||'').toLowerCase()).filter(Boolean);
    const { rows: v2Users } = await v2.query(`
      select id, email, name, status, v1_id from users where lower(email) = any($1::text[]) or v1_id = any($2::int[])`, [emails, v1Users.map(u=>u.id)]);
    const v2ByEmail = new Map();
    for (const u of v2Users) { const k=(u.email||'').toLowerCase(); if(!v2ByEmail.has(k)) v2ByEmail.set(k,[]); v2ByEmail.get(k).push(u); }

    console.log('\nuuid -> v1 user -> v2 user, vs what the migration actually wrote:');
    let agree=0, disagree=0, unresolved=0, ambiguousObs=0;
    for (const [uuid, counts] of observed) {
      const obs = [...counts.entries()].sort((a,b)=>b[1]-a[1]);
      if (obs.length > 1) ambiguousObs++;
      const u1 = v1UserByUuid.get(uuid);
      const byV1 = u1 ? v2Users.filter(x=>x.v1_id===u1.id) : [];
      const cand = byV1.length ? byV1 : (u1 ? (v2ByEmail.get((u1.email||'').toLowerCase())||[]) : []);
      const derived = cand.length===1 ? cand[0].id : null;
      const actual = obs[0][0];
      const status = derived===null ? 'UNRESOLVED' : derived===actual ? 'agree' : 'DISAGREE';
      if (status==='agree') agree++; else if (status==='DISAGREE') disagree++; else unresolved++;
      if (status!=='agree' || obs.length>1) {
        console.log(' ', status.padEnd(11), uuid, '| v1:', u1? `${u1.id} ${u1.email}`:'(no v1 user)',
          '| v2 candidates:', JSON.stringify(cand.map(c=>c.id)), '| migration wrote:', JSON.stringify(obs));
      }
    }
    console.log(`\nsummary: agree=${agree} disagree=${disagree} unresolved=${unresolved} uuidsWithMultipleObservedIds=${ambiguousObs}`);

    // full map used by the migration, as ground truth
    console.log('\nGROUND-TRUTH MAP (v1 uuid -> v2 counsellor_id), majority vote:');
    const map = {};
    for (const [uuid, counts] of observed) {
      const top = [...counts.entries()].sort((a,b)=>b[1]-a[1])[0];
      const u1 = v1UserByUuid.get(uuid);
      map[uuid] = { v2_user_id: top[0], n: top[1], v1_user_id: u1?.id ?? null, email: u1?.email ?? null,
                    name: u1?.name ?? null };
    }
    console.log(JSON.stringify(map, null, 1));
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
