/** Read-only: payment field mapping for paid applicants + Ananya's v1 payment record. */
const { connect } = require('./lib/db.cjs');
(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    // v1 payment tables for application 730635
    for (const [t, col] of [['feeTransactions','applicationManagerId'],['feetransactions','applicationManagerId'],
                            ['feeDues','applicationManagerId'],['feedues','applicationManagerId']]) {
      try { const { rows } = await v1.query(`select * from "${t}" where "${col}"=730635 limit 3`);
        if (rows.length) console.log(`v1 ${t}:`, JSON.stringify(rows,null,1).slice(0,1500)); else console.log(`v1 ${t}: no rows`);
      } catch(e){ console.log(`v1 ${t}: ${e.message.slice(0,70)}`); }
    }
    // how do migrated PAID applicants look?
    const { rows: paid } = await v2.query(`
      select id, v1_application_id, payment_status, is_payment_done, payment_mode, payment_method,
             payment_initiated, payment_completed_at, total_amount, applicant_status, payment_partner,
             payment_first_initiated_at, payment_last_initiated_at
      from v2_leads where org_id=12 and school_id=18 and type='applicant' and v1_application_id is not null
        and payment_status='completed' order by v1_application_id desc limit 60`);
    console.log('\nmigrated PAID applicants sampled:', paid.length);
    const t=(f)=>{const m=new Map();paid.forEach(r=>{const k=f(r);m.set(k,(m.get(k)||0)+1)});return [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,6)};
    for (const c of ['is_payment_done','payment_mode','payment_method','payment_initiated','total_amount','applicant_status','payment_partner'])
      console.log('  ', c.padEnd(28), JSON.stringify(t(r=>r[c]===null?null:String(r[c]))));
    console.log('  payment_completed_at set:', JSON.stringify(t(r=>r.payment_completed_at!==null)));

    // where did payment_completed_at come from?
    const amIds = paid.filter(r=>r.payment_completed_at).map(r=>r.v1_application_id).slice(0,25);
    if (amIds.length) {
      const { rows: ft } = await v1.query(`
        select "applicationManagerId" am, id, amount, status, "paymentDate", "createdAt", "updatedAt", "paymentMode", "transactionId"
        from "feeTransactions" where "applicationManagerId"=any($1::int[]) limit 40`).catch(async()=>{
          const c = await v1.query(`select column_name from information_schema.columns where table_name='feeTransactions'`);
          console.log('\nfeeTransactions cols:', c.rows.map(r=>r.column_name).join(', ')); return {rows:[]}; });
      console.log('\nv1 feeTransactions for paid apps:', JSON.stringify(ft.slice(0,4),null,1).slice(0,900));
      const map=new Map();
      for (const r of paid.filter(x=>amIds.includes(x.v1_application_id))) {
        const f = ft.filter(x=>x.am===r.v1_application_id);
        const hit = f.find(x=>x.paymentDate && new Date(x.paymentDate).getTime()===new Date(r.payment_completed_at).getTime());
        map.set(hit?'== feeTransactions.paymentDate':'(no match)', (map.get(hit?'== feeTransactions.paymentDate':'(no match)')||0)+1);
      }
      console.log('payment_completed_at provenance:', JSON.stringify([...map.entries()]));
    }
  } finally { await v1.end(); await v2.end(); }
})().catch(e=>{console.error('ERROR:',e);process.exit(1);});
