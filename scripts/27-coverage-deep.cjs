/**
 * READ-ONLY deep coverage check of the things the user asked about:
 *   1. application activity trackers
 *   2. application form data for students
 *   3. lead score
 *   4. payment data, payment activity and payment dates
 *   5. do the counsellors actually exist / are they usable
 *   6. edge cases in the payload
 */
const fs = require('fs');
const path = require('path');
const { connect } = require('./lib/db.cjs');
const M = require('./lib/maps.cjs');

const EXPORT_ROOT = 'C:/Users/Prateek/Desktop/Repos/data/export';
const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(80) + '\n' + t + '\n' + '='.repeat(80));
const readNd = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const tally = (rows, f) => { const m = new Map(); rows.forEach(r => { const k = f(r); m.set(k, (m.get(k) || 0) + 1); }); return [...m.entries()].sort((a, b) => b[1] - a[1]); };

(async () => {
  const runs = fs.readdirSync(EXPORT_ROOT).sort();
  const DIR = path.join(EXPORT_ROOT, runs[runs.length - 1]);
  log('export run:', runs[runs.length - 1]);
  const leads = readNd(path.join(DIR, 'leads.ndjson'));
  const trackers = readNd(path.join(DIR, 'activity_trackers.ndjson'));
  const ugApp = readNd(path.join(DIR, 'under_graduate_applicant.ndjson'));
  const promotions = readNd(path.join(DIR, 'promotions.ndjson'));
  const v1ids = leads.map(l => l.v1_lead_id);

  const v1 = await connect('v1'); const v2 = await connect('v2');
  const issues = [];
  const bad = m => { issues.push(m); log('  ISSUE ' + m); };
  const ok = m => log('  ok    ' + m);

  try {
    const { rows: src } = await v1.query('select * from "manageLeads" where id = any($1::int[])', [v1ids]);
    const srcBy = new Map(src.map(r => [r.id, r]));
    const amIds = src.map(r => r.applicationManagerId).filter(Boolean);
    const { rows: ams } = amIds.length ? await v1.query('select * from "ApplicationManager" where id = any($1::int[])', [amIds]) : { rows: [] };

    // ---------------------------------------------------------------- 1. trackers
    hr('1. application activity trackers');
    const { rows: v1trk } = await v1.query(
      'select "leadId", count(*)::int n from "applicationActivityTracker" where "leadId" = any($1::int[]) group by 1', [v1ids]);
    log(`  v1 has tracker rows for ${v1trk.length} of the ${v1ids.length} exported leads`);
    log(`  export carries ${trackers.length}`);
    const trkLeads = new Set(trackers.map(t => t.v1_leadId));
    const missingTrk = v1trk.filter(r => !trkLeads.has(r.leadId));
    if (missingTrk.length) bad(`${missingTrk.length} lead(s) have a v1 tracker but no exported row: ${missingTrk.slice(0, 5).map(r => r.leadId)}`);
    else ok('every v1 tracker row for an exported lead is in the export');
    const dupSrc = v1trk.filter(r => r.n > 1);
    log(`  leads with >1 v1 tracker row (v2 allows one): ${dupSrc.length}`);
    // are all non-null v1 values carried?
    const { rows: trkSrc } = await v1.query('select * from "applicationActivityTracker" where "leadId" = any($1::int[])', [v1ids]);
    const TC = ['applicationForm_start_date', 'payment_Initiated_date', 'payment_last_Initiated_date',
      'counsellor_first_activity_date', 'counsellor_last_activity_date', 'application_fee_paidOn',
      'application_last_activity_date', 'lastLeadStageUpdated', 'firstLeadStageUpdated', 'applicationFormSubmittedOn'];
    const pop = {};
    for (const c of TC) pop[c] = trkSrc.filter(r => r[c] !== null).length;
    log('  v1 non-null counts per column:', JSON.stringify(pop));
    const expPop = {};
    for (const c of TC) expPop[c] = trackers.filter(r => r[c] !== null).length;
    log('  export non-null counts       :', JSON.stringify(expPop));
    for (const c of TC) if (pop[c] !== expPop[c]) bad(`tracker column ${c}: v1 has ${pop[c]} non-null, export has ${expPop[c]}`);
    if (TC.every(c => pop[c] === expPop[c])) ok('every populated tracker column is carried across');

    // ---------------------------------------------------------------- 2. application form data
    hr('2. application form data for the applicants');
    for (const am of ams) {
      const { rows: resp } = await v1.query(
        'select count(*)::int n from "ApplicationResponses" where "applicationManagerId" = $1', [am.id]);
      const built = ugApp.find(a => true && a.data && a.key);
      log(`  v1 application ${am.id}: ${resp[0].n} ApplicationResponses rows`);
    }
    log(`  under_graduate applicant payloads built: ${ugApp.length}`);
    ugApp.forEach(a => log(`    ${JSON.stringify(a.key)} -> ${Object.keys(a.data).length} columns`));
    // any response field that maps nowhere AND holds a real answer?
    const allAm = [...amIds, ...promotions.map(p => p.v1_application_id)];
    const { rows: allResp } = allAm.length ? await v1.query(`
      select ar."sectionFieldId" sfid, sf.label, sf.type, count(*)::int n,
             count(*) filter (where ar.value is not null and ar.value <> '')::int answered
      from "ApplicationResponses" ar left join sectionfields sf on sf.id = ar."sectionFieldId"
      where ar."applicationManagerId" = any($1::int[]) group by 1,2,3 order by 1`, [allAm]) : { rows: [] };
    const written = new Set(ugApp.flatMap(a => Object.keys(a.data)));
    log(`\n  every answered question, and whether it reached under_graduate:`);
    for (const r of allResp) {
      log(`    sfid ${String(r.sfid).padEnd(6)} ${String(r.label || '').slice(0, 44).padEnd(44)} answered=${r.answered}`);
    }
    log(`\n  columns actually written: ${[...written].sort().join(', ')}`);

    // documents?
    for (const t of ['applicantDocuments', 'documents']) {
      try {
        const { rows } = await v1.query(`select count(*)::int n from "${t}" where "applicationManagerId" = any($1::int[])`, [allAm]);
        log(`  v1 ${t} rows for these applications: ${rows[0].n}`);
      } catch { log(`  v1 ${t}: no applicationManagerId column (skipped)`); }
    }
    const { rows: v2docs } = await v2.query(`
      select count(*)::int n from applicant_documents d join v2_leads l on l.id = d.lead_id
      where l.org_id=$1 and l.school_id=$2`, [M.ORG_V2, M.SCHOOL_V2]).catch(() => ({ rows: [{ n: 'n/a' }] }));
    log(`  v2 applicant_documents for UG leads: ${v2docs[0].n}`);

    // ---------------------------------------------------------------- 3. lead score
    hr('3. lead score');
    let lsOk = 0, lsBad = 0;
    for (const l of leads) {
      const s = srcBy.get(l.v1_lead_id); if (!s) continue;
      if (Number(l.lead_score ?? 0) === Number(s.leadScore ?? 0)) lsOk++; else { lsBad++; bad(`lead ${l.v1_lead_id}: lead_score ${s.leadScore} -> ${l.lead_score}`); }
    }
    if (!lsBad) ok(`all ${lsOk} leads carry v1 leadScore verbatim`);
    log('  distribution:', JSON.stringify(tally(leads, r => r.lead_score)));
    const { rows: lsh } = await v2.query(`
      select count(*)::int n, count(*) filter (where v1_lead_id is not null)::int from_v1
      from "leadScoreHistory" where org_id = $1`, [M.ORG_V2]).catch(async () => {
        const c = await v2.query(`select column_name from information_schema.columns where table_name='leadScoreHistory'`);
        log('  v2 leadScoreHistory columns:', c.rows.map(r => r.column_name).join(', '));
        return { rows: [{ n: 'n/a', from_v1: 'n/a' }] };
      });
    log(`  v2 leadScoreHistory: ${JSON.stringify(lsh[0])}`);
    const { rows: v1lsh } = await v1.query(
      'select count(*)::int n from "LeadScoreHistories" where "leadId" = any($1::int[])', [v1ids]).catch(() => ({ rows: [{ n: 'n/a' }] }));
    log(`  v1 LeadScoreHistories rows for exported leads: ${v1lsh[0].n}`);

    // ---------------------------------------------------------------- 4. payments
    hr('4. payment data, activity and dates');
    log('  v1 manageLeads.paymentStatus for exported leads:', JSON.stringify(tally(src, r => r.paymentStatus)));
    log('  export payment_status                        :', JSON.stringify(tally(leads, r => r.payment_status)));
    for (const am of ams) {
      log(`  v1 application ${am.id}: paymentStatus=${am.paymentStatus} paymentInitiated=${am.paymentInitiated} paymentMethod=${am.paymentMethod}`);
      const l = leads.find(x => x.v1_application_id === am.id);
      if (l) log(`     -> export: status=${l.payment_status} initiated=${l.payment_initiated} method=${l.payment_method} mode=${l.payment_mode} done=${l.is_payment_done}`);
    }
    // v1 fee rows for ALL in-scope leads/applications
    const { rows: fd } = await v1.query(`
      select count(*)::int n from feedues where "applicationManagerId" = any($1::int[])`, [allAm.length ? allAm : [0]]);
    log(`\n  v1 feedues rows for in-scope applications: ${fd[0].n}`);
    const { rows: fdAll } = await v1.query(`
      select count(*)::int n from feedues where "applicantId" = any($1::int[])`,
      [[...new Set(src.map(r => r.userId).filter(Boolean))].length ? [...new Set(src.map(r => r.userId).filter(Boolean))] : [0]]);
    log(`  v1 feedues rows for in-scope applicants   : ${fdAll[0].n}`);
    // does v2 hold fee rows for the ALREADY-migrated UG applicants?
    const { rows: v2fd } = await v2.query(`
      select count(*)::int n from "feeDues" fd join v2_leads l on l.id = fd.lead_id
      where l.org_id=$1 and l.school_id=$2`, [M.ORG_V2, M.SCHOOL_V2]).catch(async () => {
        const c = await v2.query(`select column_name from information_schema.columns where table_name='feeDues'`);
        log('  v2 feeDues columns:', c.rows.map(r => r.column_name).join(', '));
        return { rows: [{ n: 'n/a' }] };
      });
    log(`  v2 feeDues rows linked to a UG lead       : ${v2fd[0].n}`);
    const { rows: v2paid } = await v2.query(`
      select count(*)::int n from v2_leads where org_id=$1 and school_id=$2 and v1_application_id is not null and payment_status='completed'`,
      [M.ORG_V2, M.SCHOOL_V2]);
    log(`  already-migrated UG applicants marked PAID : ${v2paid[0].n}`);

    // ---------------------------------------------------------------- 5. counsellors
    hr('5. counsellors');
    const cids = [...new Set(leads.map(l => l.counsellor_id).filter(Boolean))];
    const { rows: cs } = await v2.query(`
      select u.id, u.email, u.name, u.status, u.organization_id, u.school_id, u.role,
             (select count(*)::int from org_users ou where ou.user_id = u.id and ou.org_id = $2) in_org_users,
             (select count(*)::int from user_schools us where us.user_id = u.id) school_links
      from users u where u.id = any($1::int[]) order by u.id`, [cids, M.ORG_V2]).catch(async () => {
        const { rows } = await v2.query('select id, email, name, status, organization_id, school_id, role from users where id = any($1::int[])', [cids]);
        return { rows };
      });
    log(`  ${cids.length} distinct counsellor(s) used by the export:`);
    cs.forEach(c => log(`    ${String(c.id).padEnd(9)} ${String(c.email).padEnd(42)} status=${c.status} org=${c.organization_id} school=${c.school_id} role=${c.role}` +
      (c.in_org_users !== undefined ? ` org_users=${c.in_org_users} user_schools=${c.school_links}` : '')));
    const missingCs = cids.filter(id => !cs.some(c => c.id === id));
    if (missingCs.length) bad(`counsellor id(s) not found in v2 users: ${missingCs}`);
    else ok('every counsellor exists in v2 users');
    const inactive = cs.filter(c => c.status !== 'active');
    if (inactive.length) bad(`counsellor(s) not active: ${inactive.map(c => `${c.id} ${c.email} (${c.status})`)}`);
    else ok('every counsellor is active');
    const wrongOrg = cs.filter(c => c.organization_id !== M.ORG_V2);
    if (wrongOrg.length) bad(`counsellor(s) not in org ${M.ORG_V2}: ${wrongOrg.map(c => `${c.id} org=${c.organization_id}`)}`);
    else ok(`every counsellor belongs to org ${M.ORG_V2}`);
    // can they actually SEE UG leads? check school scoping the way the app would
    const { rows: scope } = await v2.query(`
      select u.id, u.email, u.school_id,
             (select count(*)::int from v2_leads l where l.counsellor_id = u.id and l.school_id = $2) existing_ug_leads
      from users u where u.id = any($1::int[])`, [cids, M.SCHOOL_V2]);
    log('\n  do these counsellors already own UG leads in v2?');
    scope.forEach(s => log(`    ${String(s.id).padEnd(9)} ${String(s.email).padEnd(42)} school_id=${s.school_id} existing UG leads=${s.existing_ug_leads}`));
    const noLeads = scope.filter(s => s.existing_ug_leads === 0);
    if (noLeads.length) bad(`counsellor(s) own ZERO existing UG leads - suspicious mapping: ${noLeads.map(s => s.email)}`);
    else ok('every counsellor already owns UG leads in v2, so the mapping matches live ownership');

    // ---------------------------------------------------------------- 6. edge cases
    hr('6. edge cases in the payload');
    const checks = [
      ['registered_email missing/NA', leads.filter(l => !l.registered_email || ['na', 'n/a', ''].includes(String(l.registered_email).toLowerCase()))],
      ['registered_mobile missing/NA', leads.filter(l => !l.registered_mobile || ['na', 'n/a', ''].includes(String(l.registered_mobile).toUpperCase().toLowerCase()))],
      ['registered_name missing', leads.filter(l => !l.registered_name)],
      ['country_code missing', leads.filter(l => !l.country_code)],
      ['country_code not numeric', leads.filter(l => l.country_code && !/^\d+$/.test(l.country_code))],
      ['non-India country code', leads.filter(l => l.country_code && l.country_code !== '91')],
      ['city literally "NA"', leads.filter(l => String(l.city).toUpperCase() === 'NA')],
      ['created_at in the future', leads.filter(l => new Date(l.created_at) > new Date())],
      ['updated_at before created_at', leads.filter(l => new Date(l.updated_at) < new Date(l.created_at))],
      ['is_deleted true', leads.filter(l => l.is_deleted)],
      ['lead_score negative', leads.filter(l => Number(l.lead_score) < 0)],
      ['counsellor_id null', leads.filter(l => l.counsellor_id === null)],
      ['lead_stage_id null', leads.filter(l => l.lead_stage_id === null)],
      ['email longer than 255', leads.filter(l => (l.registered_email || '').length > 255)],
      ['name longer than 255', leads.filter(l => (l.registered_name || '').length > 255)],
      ['mobile longer than 20', leads.filter(l => (l.registered_mobile || '').length > 20)],
      ['duplicate email WITHIN the batch (same form)', (() => {
        const seen = new Map(), dup = [];
        for (const l of leads) { const k = `${(l.registered_email || '').toLowerCase()}|${l.form_id}`;
          if ((l.registered_email || '').toLowerCase() === 'na' || !l.registered_email) continue;
          if (seen.has(k)) dup.push(l); else seen.set(k, l); }
        return dup; })()],
      ['duplicate mobile WITHIN the batch (same form)', (() => {
        const seen = new Map(), dup = [];
        for (const l of leads) { const k = `${l.registered_mobile}|${l.form_id}`;
          if (!l.registered_mobile || l.registered_mobile.toUpperCase() === 'NA') continue;
          if (seen.has(k)) dup.push(l); else seen.set(k, l); }
        return dup; })()],
    ];
    for (const [label, rows] of checks) {
      log(`  ${label.padEnd(46)} ${String(rows.length).padStart(4)}` +
        (rows.length && rows.length <= 6 ? '   ' + rows.map(r => r.v1_lead_id).join(',') : ''));
    }
    // string length vs actual column limits
    const { rows: lens } = await v2.query(`
      select column_name, character_maximum_length len from information_schema.columns
      where table_name='v2_leads' and character_maximum_length is not null`);
    let overflow = 0;
    for (const c of lens) {
      for (const l of leads) {
        const v = l[c.column_name];
        if (typeof v === 'string' && v.length > c.len) { bad(`lead ${l.v1_lead_id}: ${c.column_name} is ${v.length} chars, column allows ${c.len}`); overflow++; }
      }
    }
    if (!overflow) ok('no value exceeds its v2 column length limit');

    hr(issues.length ? `${issues.length} ISSUE(S)` : 'NO ISSUES');
    issues.forEach(i => log('  - ' + i));
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('FAILED:', e.message); console.error(e.stack); process.exit(1); });
