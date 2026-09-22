const { connect } = require('./lib/db.cjs');
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: u2 } = await v2.query(`
      select id, v1_id, email, password_hash, name, phone, country_code, status, login_count, last_logged_in_at, image, timezone, user_type, role
      from users where role='student' and organization_id=12 and school_id=18 and v1_id is not null
      order by v1_id desc limit 40`);
    const { rows: u1 } = await v1.query(`select id, email, password, name, "mobileNumber", "countryCode", timezone, image, user_type from users where id = any($1::int[])`, [u2.map(r=>r.v1_id)]);
    const by = new Map(u1.map(r=>[r.id,r]));
    const t=(f)=>{const m=new Map();u2.forEach(r=>{const a=by.get(r.v1_id); if(!a)return; const k=f(a,r); m.set(k,(m.get(k)||0)+1)});return [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,4)};
    console.log('password verbatim:', JSON.stringify(t((a,r)=> a.password===r.password_hash ? 'EXACT' : 'differs')));
    console.log('email           :', JSON.stringify(t((a,r)=> a.email===r.email ? 'EXACT' : `${a.email} -> ${r.email}`)));
    console.log('name            :', JSON.stringify(t((a,r)=> a.name===r.name ? 'EXACT' : 'differs')));
    console.log('phone           :', JSON.stringify(t((a,r)=> (a.mobileNumber||null)===(r.phone||null) ? 'EXACT' : `${a.mobileNumber} -> ${r.phone}`)).slice(0,300));
    console.log('country_code    :', JSON.stringify(t((a,r)=> `${a.countryCode} -> ${r.country_code}`)).slice(0,300));
    console.log('user_type       :', JSON.stringify(t((a,r)=> `${a.user_type} -> ${r.user_type}`)));
    console.log('role/status     :', JSON.stringify(t((a,r)=> `${r.role}/${r.status}`)));
    console.log('login_count     :', JSON.stringify(t((a,r)=> String(r.login_count))));
    console.log('timezone        :', JSON.stringify(t((a,r)=> `${a.timezone} -> ${r.timezone}`)).slice(0,250));
    console.log('sample v2 row   :', JSON.stringify(u2[0]).slice(0,400));
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1)});
