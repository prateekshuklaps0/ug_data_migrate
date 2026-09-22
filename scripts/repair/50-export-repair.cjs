/**
 * STREAM H - REPAIR EXPORT.  READ-ONLY on both databases.
 *
 * Rows ALREADY in v2 (org 12 / school 18 / forms 104,105, live, migrated from v1) that
 * are missing data v1 has, or are behind v1's progress. Plans three repairs:
 *
 *   h_forms     under_graduate form answers                 FILL empty only
 *   h_leads     v2_leads: progress (submitted / paid / % / section) FORWARD only,
 *               and payment + stage + submission dates, partner, registered-on,
 *               a few direct lead columns                       FILL empty only
 *   h_trackers  ApplicationActivityTrackers dates              FILL empty; "last" dates FORWARD
 *
 * Column classes and rules: scripts/lib/repair-rules.cjs. Every source below was chosen
 * by EVIDENCE (scripts/35-*.cjs, 36-*.cjs): it reproduces the value v2 already holds on
 * rows where v2 has it. The source of each planned value is recorded in the output.
 *
 *   node scripts/repair/50-export-repair.cjs      -> data/repair/<runId>/
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connect } = require('../lib/db.cjs');
const M = require('../lib/maps.cjs');
const { Progress } = require('../lib/progress.cjs');
const { buildApplicantUnderGraduate } = require('../lib/appform.cjs');
const R = require('../lib/repair-rules.cjs');

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join('C:/Users/Prateek/Desktop/Repos/data/repair', RUN_ID);
const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(84) + '\n' + t + '\n' + '='.repeat(84));
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const iso = v => v instanceof Date ? v.toISOString() : v;
const ms = R.ms;
const DECL = [4575, 5291, 4576, 5292, 11268];      // declaration fields = the last step of the v1 form

/** "... changed application stage from 'A' substage: 'x' to 'B' ..." */
function parseAppStage(msg) {
  if (!msg) return null;
  const to = msg.match(/ to '([^']+)'/i), from = msg.match(/ from '([^']+)'/i);
  return to ? { from: from ? from[1].trim().toLowerCase() : null, to: to[1].trim().toLowerCase() } : null;
}

(async () => {
  hr(`STREAM H REPAIR EXPORT   run ${RUN_ID}`);
  const v1 = await connect('v1', { readOnly: true });
  const v2 = await connect('v2', { readOnly: true });
  const warnings = [];
  const warn = m => { warnings.push(m); log('  !  ' + m); };
  try {
    const { rows: [ro] } = await v1.query('show default_transaction_read_only');
    if (ro.default_transaction_read_only !== 'on') throw new Error('v1 session is not read-only');

    // ---------------------------------------------------------------- population
    hr('1. population + v1 sources');
    const { rows: leads } = await v2.query(`
      select l.*, s."stageName" app_stage_name from v2_leads l
      left join "applicationStage" s on s.id = l.application_stage_id
      where l.org_id = $1 and l.school_id = $2 and l.form_id = any($3::int[]) and not l.is_deleted and l.v1_lead_id is not null`,
      [M.ORG_V2, M.SCHOOL_V2, M.V2_FORMS]);
    const apps = leads.filter(l => l.v1_application_id != null);
    log(`  live migrated UG leads ${leads.length}   applicants ${apps.length}`);
    const { stage } = await M.buildStageMaps(v1, v2);

    const v1ids = leads.map(l => Number(l.v1_lead_id));
    const amIds = apps.map(a => Number(a.v1_application_id));
    const ml = new Map(), t1 = new Map(), ut = new Map(), am = new Map(), fd = new Map(), ar = new Map(), decl = new Map(), t2 = new Map();
    const p = new Progress(v1ids.length, 'v1 leads + events');
    for (let i = 0; i < v1ids.length; i += 2000) {
      const ch = v1ids.slice(i, i + 2000);
      (await v1.query(`select id, "leadStageId", "secondarySource", "secondaryMedium", "secondaryCampaign", "tertiarySource",
                               "tertiaryMedium", "tertiaryCampaign", "widgetId", grade, "alternateMobileNumber"
                        from "manageLeads" where id = any($1::int[])`, [ch])).rows.forEach(r => ml.set(r.id, r));
      (await v1.query('select * from "applicationActivityTracker" where "leadId" = any($1::int[]) order by "leadId", "createdAt", id', [ch]))
        .rows.forEach(r => { if (!t1.has(r.leadId)) t1.set(r.leadId, []); t1.get(r.leadId).push(r); });
      (await v1.query(`select "leadId", "leadStageId", "createdAt", "eventType"->>'title' title, message from "UserTimelines"
                        where "leadId" = any($1::int[]) and "eventType"->>'title' in ('Changed_Lead_Stage','Stage Assigned','Application Stage Changed')
                        order by "createdAt", id`, [ch]))
        .rows.forEach(r => { if (!ut.has(r.leadId)) ut.set(r.leadId, []); ut.get(r.leadId).push(r); });
      p.tick(ch.length);
    }
    p.done();
    for (let i = 0; i < amIds.length; i += 2000) {
      const ch = amIds.slice(i, i + 2000);
      (await v1.query('select * from "ApplicationManager" where id = any($1::int[])', [ch])).rows.forEach(r => am.set(r.id, r));
      (await v1.query(`select f.id, f."applicationManagerId" a, f."isPaid", f."paymentPartner", f."createdAt", f."updatedAt",
                               (select max(t."paidOn") from feetransactions t where t."feeDueId" = f.id) paid_on,
                               (select max(t."paymentPartner") from feetransactions t where t."feeDueId" = f.id) tx_partner
                        from feedues f where f."applicationManagerId" = any($1::int[]) order by f.id`, [ch]))
        .rows.forEach(r => { if (!fd.has(r.a)) fd.set(r.a, []); fd.get(r.a).push(r); });
      (await v1.query(`select "applicationManagerId" a, min("createdAt") first, max("updatedAt") last from "ApplicationResponses"
                        where "applicationManagerId" = any($1::int[]) group by 1`, [ch])).rows.forEach(r => ar.set(r.a, r));
      (await v1.query(`select "applicationManagerId" a, max("updatedAt") t from "ApplicationResponses"
                        where "applicationManagerId" = any($1::int[]) and "sectionFieldId" = any($2::int[])
                          and value is not null and btrim(value) <> '' group by 1`, [ch, DECL])).rows.forEach(r => decl.set(r.a, r.t));
    }
    const ids2 = leads.map(l => Number(l.id));
    for (let i = 0; i < ids2.length; i += 20000) {
      (await v2.query('select * from "ApplicationActivityTrackers" where "leadId" = any($1::int[])', [ids2.slice(i, i + 20000)]))
        .rows.forEach(r => t2.set(Number(r.leadId), r));
    }
    log(`  v1 trackers for ${t1.size} leads, stage events for ${ut.size}, v2 trackers ${t2.size}`);

    // ---------------------------------------------------------------- derive per lead
    hr('2. planning (v2 is read as it is NOW; the importer re-checks every row live)');
    const hLeads = [], hTrk = [], hForms = [];
    const colCount = new Map(), srcCount = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    const p2 = new Progress(leads.length, 'planning');
    for (const l of leads) {
      p2.tick();
      const id = Number(l.id), v1id = Number(l.v1_lead_id);
      const m = ml.get(v1id) || {};
      const s = l.v1_application_id != null ? am.get(Number(l.v1_application_id)) : null;
      const live2 = t2.get(id);
      const rows1 = t1.get(v1id) || [];
      const r1 = (live2 && rows1.find(r => ms(r.createdAt) === ms(live2.createdAt))) || rows1[0] || null;
      const ev = ut.get(v1id) || [];
      const want = {}, src = {};
      const put = (c, v, from) => { if (!R.isEmpty(v)) { want[c] = iso(v); src[c] = from; } };

      // --- lead stage date: when the lead ENTERED its current main stage (v2's definition)
      if (l.lead_stage_id != null) {
        const ls = ev.filter(x => x.leadStageId != null && x.title !== 'Application Stage Changed');
        let prev = null, entered = null;
        for (const x of ls) { const mp = stage.get(x.leadStageId); if (mp === Number(l.lead_stage_id) && prev !== mp) entered = x.createdAt; prev = mp; }
        if (entered) put('lead_stage_date', entered, 'v1 stage event: entered current stage');
        else if (!ls.length) put('lead_stage_date', l.created_at, 'lead created in this stage (no stage change ever)');
      }
      // --- direct lead columns (the old migration copied these 1:1; a few were missed)
      put('secondary_source', m.secondarySource, 'v1 lead'); put('secondary_medium', m.secondaryMedium, 'v1 lead');
      put('secondary_campaign', m.secondaryCampaign, 'v1 lead'); put('tertiary_source', m.tertiarySource, 'v1 lead');
      put('tertiary_medium', m.tertiaryMedium, 'v1 lead'); put('tertiary_campaign', m.tertiaryCampaign, 'v1 lead');
      put('widget_id', m.widgetId, 'v1 lead'); put('grade', m.grade, 'v1 lead');
      put('alternate_mobile_number', m.alternateMobileNumber, 'v1 lead');

      let paidEvidence = null;
      if (s) {
        const dues = fd.get(s.id) || [];
        const paid = dues.filter(d => d.isPaid);
        if (s.paymentStatus === 'completed' && paid.length) paidEvidence = paid[paid.length - 1];
        if (s.paymentStatus === 'completed' && !paid.length) warn(`lead ${id}: v1 says paid but has NO paid fee record - payment not changed`);
        // --- progress, forward only
        if (s.applicationFormInitiated === true) put('application_form_initiated', true, 'v1 application');
        if (s.applicationFormSubmitted === true) put('application_form_submitted', true, 'v1 application');
        if (s.paymentInitiated === true) put('payment_initiated', true, 'v1 application');
        if (paidEvidence) { put('payment_status', 'completed', `v1 paid fee #${paidEvidence.id}`); put('is_payment_done', true, `v1 paid fee #${paidEvidence.id}`); }
        const pct = (s.applicationStatus === 'untouched' || s.applicationStatus == null) ? null : (Number(s.applicationStatus) || null);
        put('form_percentage_filled', pct, 'v1 application'); put('last_interacted_section', s.lastInteractedSection, 'v1 application');
        put('application_registered_on', s.registeredOn, 'v1 application registeredOn (2165/2165 exact)');
        // --- submission date: v1 never stored it; the declaration save IS the submit step
        if (s.applicationFormSubmitted === true) {
          if (s.formCompletionDate) put('form_completion_date', s.formCompletionDate, 'v1 formCompletionDate');
          else if (decl.get(s.id)) put('form_completion_date', decl.get(s.id), 'v1 declaration save (submit step)');
        }
        // --- payment detail, only when v2 IS (or becomes) paid - never contradict v2
        const willBePaid = l.payment_status === 'completed' || !!paidEvidence;
        if (willBePaid && paidEvidence) {
          const t = r1 && r1.application_fee_paidOn;
          put('payment_completed_at', t || paidEvidence.paid_on || paidEvidence.updatedAt,
            t ? 'v1 tracker application_fee_paidOn (9/9 exact)' : paidEvidence.paid_on ? 'v1 fee transaction paidOn' : 'v1 fee record paid time');
          put('payment_partner', R.normPartner(paidEvidence.tx_partner || paidEvidence.paymentPartner), 'v1 fee record');
          put('payment_mode', 'online', 'the migration\'s rule for a paid v1 application');
          put('payment_method', s.paymentMethod, 'v1 application');
        }
        if (s.paymentInitiated === true || willBePaid) {
          const first = dues.length ? dues[0].createdAt : null, last = dues.length ? dues[dues.length - 1].createdAt : null;
          put('payment_first_initiated_at', (r1 && r1.payment_Initiated_date) || first, r1 && r1.payment_Initiated_date ? 'v1 tracker payment_Initiated_date' : 'v1 first fee record');
          put('payment_last_initiated_at', (r1 && r1.payment_last_Initiated_date) || last, r1 && r1.payment_last_Initiated_date ? 'v1 tracker payment_last_Initiated_date' : 'v1 last fee record');
        }
        // --- application stage date: when the application ENTERED its current main stage
        if (l.application_stage_id != null) {
          const as = ev.filter(x => x.title === 'Application Stage Changed').map(x => ({ at: x.createdAt, p: parseAppStage(x.message) })).filter(x => x.p);
          const cur = (l.app_stage_name || '').trim().toLowerCase();
          const into = as.filter(x => x.p.to === cur && x.p.from !== cur);
          const mainChanges = as.filter(x => x.p.from !== x.p.to);
          if (into.length) put('application_stage_date', into[into.length - 1].at, 'v1 event: entered current application stage');
          else if (!mainChanges.length) put('application_stage_date', s.registeredOn, 'application created in this stage (no main-stage change ever)');
        }
      }
      const setL = R.plan('v2_leads', l, want);
      if (Object.keys(setL).length) {
        hLeads.push({ v2_lead_id: id, v1_lead_id: v1id, v1_application_id: s ? s.id : null, email: l.registered_email,
          want, src, payment_evidence: paidEvidence ? { fee_id: paidEvidence.id, partner: paidEvidence.paymentPartner, paid_at: iso(paidEvidence.paid_on || paidEvidence.updatedAt) } : null,
          set: setL, before: Object.fromEntries(Object.keys(setL).map(c => [c, iso(l[c] ?? null)])) });
        Object.keys(setL).forEach(c => { bump(colCount, 'v2_leads.' + c); bump(srcCount, `v2_leads.${c} <- ${src[c]}`); });
      }

      // --- tracker
      if (live2) {
        const tw = {}, ts = {};
        const tput = (c, v, from) => { if (!R.isEmpty(v)) { tw[c] = iso(v); ts[c] = from; } };
        if (r1) {
          for (const c of ['applicationForm_start_date', 'payment_Initiated_date', 'payment_last_Initiated_date', 'application_fee_paidOn',
            'applicationFormSubmittedOn', 'application_last_activity_date', 'counsellor_first_activity_date', 'counsellor_last_activity_date',
            'firstLeadStageUpdated', 'lastLeadStageUpdated']) tput(c, r1[c], 'v1 tracker');
          tput('v1_applicationId', r1.applicationId, 'v1 tracker');
        }
        const ch = ev.filter(x => x.title === 'Changed_Lead_Stage');
        if (ch.length) {
          if (R.isEmpty(tw.firstLeadStageUpdated)) tput('firstLeadStageUpdated', ch[0].createdAt, 'v1 first stage-change event (91% match)');
          if (R.isEmpty(tw.lastLeadStageUpdated)) tput('lastLeadStageUpdated', ch[ch.length - 1].createdAt, 'v1 last stage-change event (94% match)');
        }
        if (s) {
          const a = ar.get(s.id);
          if (a && R.isEmpty(tw.applicationForm_start_date)) tput('applicationForm_start_date', a.first, 'v1 first form answer (89% match)');
          if (a && R.isEmpty(tw.application_last_activity_date)) tput('application_last_activity_date', a.last, 'v1 last form answer (95% match)');
          if (s.applicationFormSubmitted === true && R.isEmpty(tw.applicationFormSubmittedOn) && decl.get(s.id)) tput('applicationFormSubmittedOn', decl.get(s.id), 'v1 declaration save (submit step)');
          if (paidEvidence && R.isEmpty(tw.application_fee_paidOn)) tput('application_fee_paidOn', paidEvidence.paid_on || paidEvidence.updatedAt, 'v1 fee record paid time');
        }
        const setT = R.plan('"ApplicationActivityTrackers"', live2, tw);
        if (Object.keys(setT).length) {
          hTrk.push({ v2_lead_id: id, tracker_id: Number(live2.id), v1_tracker_id: r1 ? r1.id : null, email: l.registered_email,
            want: tw, src: ts, set: setT, before: Object.fromEntries(Object.keys(setT).map(c => [c, iso(live2[c] ?? null)])) });
          Object.keys(setT).forEach(c => { bump(colCount, 'tracker.' + c); bump(srcCount, `tracker.${c} <- ${ts[c]}`); });
        }
      }
    }
    p2.done();

    // ---------------------------------------------------------------- forms (FILL only)
    hr('3. application form answers (fill EMPTY v2 fields only)');
    const { rows: ugc } = await v2.query(`select column_name from information_schema.columns where table_name = 'under_graduate'`);
    const ugCols = new Set(ugc.map(r => r.column_name));
    const payload = new Map();
    for (let i = 0; i < amIds.length; i += 500) {
      const mm = await buildApplicantUnderGraduate(v1, amIds.slice(i, i + 500));
      for (const [k, v] of mm) if (typeof k === 'number') payload.set(k, v);
    }
    const ugRows = new Map();
    for (let i = 0; i < apps.length; i += 2000) {
      (await v2.query('select * from under_graduate where lead_id = any($1::bigint[])', [apps.slice(i, i + 2000).map(a => Number(a.id))]))
        .rows.forEach(r => ugRows.set(Number(r.lead_id), r));
    }
    for (const a of apps) {
      const live = ugRows.get(Number(a.id)); if (!live) continue;
      const want = Object.fromEntries(Object.entries(payload.get(Number(a.v1_application_id)) || {}).filter(([c]) => ugCols.has(c)).map(([c, v]) => [c, iso(v)]));
      const set = R.plan('under_graduate', live, want);
      if (!Object.keys(set).length) continue;
      hForms.push({ v2_lead_id: Number(a.id), ug_id: Number(live.id), v1_application_id: Number(a.v1_application_id), email: a.registered_email,
        want: set, set, before: Object.fromEntries(Object.keys(set).map(c => [c, iso(live[c] ?? null)])) });
      Object.keys(set).forEach(c => bump(colCount, 'under_graduate.' + c));
    }
    log(`  applicants with empty form fields v1 can fill: ${hForms.length} (${hForms.reduce((n, f) => n + Object.keys(f.set).length, 0)} fields)`);

    // ---------------------------------------------------------------- summary
    hr('4. what would change, per column (v2 is read as it is now)');
    [...colCount.entries()].sort().forEach(([c, n]) => log(`  ${String(n).padStart(6)}  ${c}`));
    log('\n  where each value comes from:');
    [...srcCount.entries()].sort().forEach(([c, n]) => log(`  ${String(n).padStart(6)}  ${c}`));

    // ---------------------------------------------------------------- assertions
    hr('5. assertions');
    const fail = [];
    const byId = new Map(leads.map(l => [Number(l.id), l]));
    for (const [name, arr, table, liveOf] of [
      ['leads', hLeads, 'v2_leads', g => byId.get(g.v2_lead_id)],
      ['trackers', hTrk, '"ApplicationActivityTrackers"', g => t2.get(g.v2_lead_id)],
      ['forms', hForms, 'under_graduate', g => ugRows.get(g.v2_lead_id)]]) {
      for (const g of arr) { try { R.assertAllowed(`${name} lead ${g.v2_lead_id}`, table, liveOf(g), g.set); } catch (e) { fail.push(e.message); } }
      const dup = arr.length - new Set(arr.map(x => x.v2_lead_id)).size;
      if (dup) fail.push(`${name}: ${dup} duplicate lead(s)`);
    }
    for (const g of hLeads) if (g.set.payment_status && !g.payment_evidence) fail.push(`lead ${g.v2_lead_id}: payment -> completed without a paid v1 fee record`);
    // coherence: never leave v2 saying "pending" with a completed-at date
    for (const g of hLeads) {
      const l = byId.get(g.v2_lead_id);
      const finalStatus = g.set.payment_status || l.payment_status;
      if ((g.set.payment_completed_at || g.set.payment_partner) && finalStatus !== 'completed') fail.push(`lead ${g.v2_lead_id}: payment detail on an unpaid lead`);
    }
    if (fail.length) { fail.slice(0, 30).forEach(f => log('  FAIL ' + f)); throw new Error(`${fail.length} assertion(s) failed - nothing written`); }
    const nWrites = [...hLeads, ...hTrk, ...hForms].reduce((n, g) => n + Object.keys(g.set).length, 0);
    log(`  all ${nWrites} planned writes obey the rules: content fills EMPTY v2 fields only, progress only moves forward, nothing is blanked`);

    // ---------------------------------------------------------------- the named applicants
    hr('6. the applicants your testers named');
    for (const e of ['aaliyahxahmed13@gmail.com', 'rabiaahuja09@gmail.com', 'ayushman.28.2008@gmail.com', 'guananya@tisb.ac.in']) {
      const mine = arr => arr.filter(x => (x.email || '').toLowerCase() === e);
      const ids = [...new Set([...mine(hLeads), ...mine(hTrk), ...mine(hForms)].map(x => x.v2_lead_id))];
      log(`  ${e}`);
      if (!ids.length) log('     nothing missing');
      for (const id of ids) {
        const L = hLeads.find(x => x.v2_lead_id === id), T = hTrk.find(x => x.v2_lead_id === id), F = hForms.find(x => x.v2_lead_id === id);
        log(`   v2 lead ${id}`);
        if (L) log(`     lead   : ${Object.entries(L.set).map(([c, v]) => `${c} ${JSON.stringify(L.before[c])} -> ${JSON.stringify(v)}`).join('; ')}`);
        if (T) log(`     tracker: ${Object.entries(T.set).map(([c, v]) => `${c} ${JSON.stringify(T.before[c])} -> ${String(v).slice(0, 19)}`).join('; ')}`);
        if (F) log(`     form   : ${Object.keys(F.set).length} empty field(s) filled`);
      }
    }

    // ---------------------------------------------------------------- write
    hr('7. writing files');
    fs.mkdirSync(OUT, { recursive: true });
    const files = {};
    for (const [name, rows] of [['h_forms.ndjson', hForms], ['h_leads.ndjson', hLeads], ['h_trackers.ndjson', hTrk]]) {
      const f = path.join(OUT, name);
      fs.writeFileSync(f, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
      files[name] = { rows: rows.length, sha256: sha256(f) };
      log(`  ${name.padEnd(20)} ${String(rows.length).padStart(6)} rows`);
    }
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
      runId: RUN_ID, generatedAt: new Date().toISOString(), stream: 'H (repair of rows already in v2)',
      target: { org: M.ORG_V2, school: M.SCHOOL_V2, forms: M.V2_FORMS }, files, warnings,
      rules: 'lib/repair-rules.cjs: content FILL-empty-only, progress FORWARD-only, never blank; importer re-applies live and enforces in SQL',
    }, null, 2));
    log('  manifest.json');
    hr('REPAIR EXPORT COMPLETE');
    log(`  run folder : ${OUT}`);
    log(`  forms ${hForms.length}   leads ${hLeads.length}   trackers ${hTrk.length}   planned writes ${nWrites}   warnings ${warnings.length}`);
    log('  Nothing was written to any database.');
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('\nREPAIR EXPORT FAILED:', e.message); console.error(e.stack); process.exit(1); });
