/**
 * Read-only gap analysis: which v1 UG leads / applications have no v2 counterpart.
 * Writes nothing to either DB. Prints a reconciliation summary.
 */
const { connect } = require('./lib/db.cjs');

const V1_FORMS = [100, 109];
const V2_FORMS = [104, 105];

(async () => {
  const v1 = await connect('v1');
  const v2 = await connect('v2');
  try {
    console.log('Fetching v1 UG manageLeads ...');
    const { rows: v1Leads } = await v1.query(`
      select id, "applicationFormId" as form_id, "applicationManagerId" as app_id,
             "isLeadDeleted" as deleted, "userId" as user_id,
             "createdAt" as created_at, "updatedAt" as updated_at
      from "manageLeads"
      where "applicationFormId" = any($1::int[])
    `, [V1_FORMS]);
    console.log('  v1 manageLeads:', v1Leads.length);

    console.log('Fetching v1 UG ApplicationManager ...');
    const { rows: v1Apps } = await v1.query(`
      select id, "applicationFormId" as form_id, "userId" as user_id,
             "isApplicationLeadDeleted" as deleted,
             "createdAt" as created_at, "updatedAt" as updated_at
      from "ApplicationManager"
      where "applicationFormId" = any($1::int[])
    `, [V1_FORMS]);
    console.log('  v1 ApplicationManager:', v1Apps.length);

    console.log('Fetching v2 UG v2_leads ...');
    const { rows: v2Rows } = await v2.query(`
      select id, form_id, type, v1_lead_id, v1_application_id, v1_user_id, is_deleted,
             created_at, updated_at
      from v2_leads
      where org_id = 12 and school_id = 18 and form_id = any($1::int[])
    `, [V2_FORMS]);
    console.log('  v2_leads (UG):', v2Rows.length);

    // Also: any v2 row ANYWHERE carrying one of our v1 lead ids (guards against
    // a lead having been migrated onto a different form/school).
    const v1LeadIds = v1Leads.map(r => r.id);
    const { rows: v2Any } = await v2.query(`
      select id, org_id, school_id, form_id, type, v1_lead_id, v1_application_id, is_deleted
      from v2_leads where v1_lead_id = any($1::int[])
    `, [v1LeadIds]);
    console.log('  v2_leads carrying any of these v1 lead ids (org-wide):', v2Any.length);

    const migratedLeadIds = new Set(v2Any.map(r => r.v1_lead_id));
    const missingLeads = v1Leads.filter(r => !migratedLeadIds.has(r.id));

    const v1AppIds = v1Apps.map(r => r.id);
    const { rows: v2AnyApp } = await v2.query(`
      select id, org_id, school_id, form_id, type, v1_lead_id, v1_application_id, is_deleted
      from v2_leads where v1_application_id = any($1::int[])
    `, [v1AppIds]);
    const migratedAppIds = new Set(v2AnyApp.map(r => r.v1_application_id));
    const missingApps = v1Apps.filter(r => !migratedAppIds.has(r.id));

    const fmt = d => d ? new Date(d).toISOString() : null;
    const bucket = (rows, keyFn) => {
      const m = new Map();
      for (const r of rows) { const k = keyFn(r); m.set(k, (m.get(k) || 0) + 1); }
      return [...m.entries()].sort();
    };

    console.log('\n================ LEADS ================');
    console.log('v1 UG leads total      :', v1Leads.length);
    console.log('  already in v2        :', v1Leads.length - missingLeads.length);
    console.log('  MISSING from v2      :', missingLeads.length);
    console.log('  by form/deleted      :', JSON.stringify(bucket(missingLeads, r => `form${r.form_id}|del=${r.deleted}`)));
    if (missingLeads.length) {
      const ds = missingLeads.map(r => new Date(r.created_at)).sort((a,b)=>a-b);
      console.log('  createdAt range (UTC):', fmt(ds[0]), '->', fmt(ds[ds.length-1]));
      console.log('  by created date (IST):');
      for (const [k, v] of bucket(missingLeads, r => new Date(new Date(r.created_at).getTime() + 5.5*3600e3).toISOString().slice(0,10))) {
        console.log('   ', k, v);
      }
    }

    console.log('\n============ APPLICATIONS =============');
    console.log('v1 UG applications total:', v1Apps.length);
    console.log('  already in v2         :', v1Apps.length - missingApps.length);
    console.log('  MISSING from v2       :', missingApps.length);
    console.log('  by form/deleted       :', JSON.stringify(bucket(missingApps, r => `form${r.form_id}|del=${r.deleted}`)));
    if (missingApps.length) {
      console.log('  by created date (IST):');
      for (const [k, v] of bucket(missingApps, r => new Date(new Date(r.created_at).getTime() + 5.5*3600e3).toISOString().slice(0,10))) {
        console.log('   ', k, v);
      }
    }

    console.log('\n============ v2 SIDE SANITY ===========');
    const orphanV2 = v2Rows.filter(r => r.v1_lead_id === null);
    console.log('v2 UG rows with no v1_lead_id (native v2):', orphanV2.length);
    console.log('v2 UG rows by form/type:', JSON.stringify(bucket(v2Rows, r => `form${r.form_id}|${r.type}|v1=${r.v1_lead_id!==null}`)));

    // duplicate v1_lead_id in v2?
    const seen = new Map();
    for (const r of v2Any) seen.set(r.v1_lead_id, (seen.get(r.v1_lead_id)||0)+1);
    const dupes = [...seen.entries()].filter(([,c]) => c > 1);
    console.log('v1_lead_id mapped to >1 v2 row:', dupes.length, dupes.slice(0,10));

    // v2 rows for our v1 ids that sit OUTSIDE UG scope
    const outside = v2Any.filter(r => !(r.org_id===12 && r.school_id===18 && V2_FORMS.includes(r.form_id)));
    console.log('v2 rows for our v1 leads sitting OUTSIDE UG scope:', outside.length, outside.slice(0,10));
  } finally {
    await v1.end(); await v2.end();
  }
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
