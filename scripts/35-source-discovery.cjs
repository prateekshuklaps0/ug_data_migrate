/**
 * READ-ONLY. Which v1 value is the right source for each v2 column the old sync left
 * empty? Decided by EVIDENCE, not by name:
 *
 *   A. on MIGRATED rows where v2 already HAS the value, which v1 candidate reproduces it
 *   B. on NATIVE v2 rows (no v1), how v2 itself relates the column to its own tracker
 *
 *   node scripts/35-source-discovery.cjs
 */
const { connect } = require('./lib/db.cjs');
const M = require('./lib/maps.cjs');
const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(88) + '\n' + t + '\n' + '='.repeat(88));
const ms = v => v == null ? null : new Date(v).getTime();

(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: leads } = await v2.query(`
      select * from v2_leads where org_id = $1 and school_id = $2 and form_id = any($3::int[])
        and not is_deleted and v1_lead_id is not null`, [M.ORG_V2, M.SCHOOL_V2, M.V2_FORMS]);
    const byId = new Map(leads.map(l => [Number(l.id), l]));
    const t2 = new Map();
    for (let i = 0; i < leads.length; i += 20000) {
      (await v2.query('select * from "ApplicationActivityTrackers" where "leadId" = any($1::int[])', [leads.slice(i, i + 20000).map(l => Number(l.id))]))
        .rows.forEach(r => t2.set(Number(r.leadId), r));
    }

    // Only leads where SOME target is filled in v2 are needed for part A.
    const TL = ['payment_completed_at', 'payment_first_initiated_at', 'payment_last_initiated_at', 'lead_stage_date',
      'application_stage_date', 'form_completion_date', 'application_registered_on'];
    const TT = ['applicationFormSubmittedOn', 'application_last_activity_date', 'firstLeadStageUpdated', 'lastLeadStageUpdated',
      'applicationForm_start_date', 'application_fee_paidOn', 'payment_Initiated_date', 'payment_last_Initiated_date'];
    const sample = leads.filter(l => TL.some(c => l[c] != null) || l.payment_partner != null);
    const trkSample = leads.filter(l => { const t = t2.get(Number(l.id)); return t && ['applicationFormSubmittedOn', 'firstLeadStageUpdated'].some(c => t[c] != null); }).slice(0, 3000);
    const all = [...new Map([...sample, ...trkSample].map(l => [Number(l.id), l])).values()];
    log(`migrated live UG leads ${leads.length}; used for evidence ${all.length}`);

    // ---------------------------------------------------------------- v1 candidates
    const v1ids = all.map(l => Number(l.v1_lead_id));
    const amids = all.filter(l => l.v1_application_id).map(l => Number(l.v1_application_id));
    const ml = new Map(), am = new Map(), t1 = new Map(), fd = new Map(), ft = new Map(), ut = new Map();
    for (let i = 0; i < v1ids.length; i += 5000) {
      const ch = v1ids.slice(i, i + 5000);
      (await v1.query('select * from "manageLeads" where id = any($1::int[])', [ch])).rows.forEach(r => ml.set(r.id, r));
      (await v1.query('select * from "applicationActivityTracker" where "leadId" = any($1::int[]) order by "createdAt"', [ch]))
        .rows.forEach(r => { if (!t1.has(r.leadId)) t1.set(r.leadId, []); t1.get(r.leadId).push(r); });
      // stage changes + submission events, from the v1 activity feed
      (await v1.query(`select "leadId", "leadStageId", "createdAt", "eventType"->>'title' title from "UserTimelines"
                        where "leadId" = any($1::int[]) and ("leadStageId" is not null or "eventType"->>'title' ilike any(array['%stage%','%submit%','%payment%']))`, [ch]))
        .rows.forEach(r => { if (!ut.has(r.leadId)) ut.set(r.leadId, []); ut.get(r.leadId).push(r); });
    }
    for (let i = 0; i < amids.length; i += 5000) {
      const ch = amids.slice(i, i + 5000);
      (await v1.query('select * from "ApplicationManager" where id = any($1::int[])', [ch])).rows.forEach(r => am.set(r.id, r));
      (await v1.query(`select "applicationManagerId" a, id, "isPaid", "paymentPartner", "createdAt", "updatedAt" from feedues
                        where "applicationManagerId" = any($1::int[]) order by id`, [ch]))
        .rows.forEach(r => { if (!fd.has(r.a)) fd.set(r.a, []); fd.get(r.a).push(r); });
    }
    const fdIds = [...fd.values()].flat().map(r => r.id);
    const ftByDue = new Map();
    for (let i = 0; i < fdIds.length; i += 5000) {
      (await v1.query('select "feeDueId", "paidOn", "paymentPartner", "createdAt" from feetransactions where "feeDueId" = any($1::int[])', [fdIds.slice(i, i + 5000)]))
        .rows.forEach(r => { if (!ftByDue.has(r.feeDueId)) ftByDue.set(r.feeDueId, []); ftByDue.get(r.feeDueId).push(r); });
    }
    const titles = new Map();
    [...ut.values()].flat().forEach(r => titles.set(r.title, (titles.get(r.title) || 0) + 1));

    const cand = l => {
      const c = {};
      const m = ml.get(Number(l.v1_lead_id)) || {};
      const a = am.get(Number(l.v1_application_id)) || {};
      const live2 = t2.get(Number(l.id));
      const rows1 = t1.get(Number(l.v1_lead_id)) || [];
      const r1 = (live2 && rows1.find(r => ms(r.createdAt) === ms(live2.createdAt))) || rows1[0] || {};
      for (const k of ['createdAt', 'updatedAt', 'registeredOn', 'reassignedOn']) c['ml.' + k] = m[k];
      for (const k of ['createdAt', 'updatedAt', 'registeredOn', 'formCompletionDate', 'lastFormStageDate', 'editAccessGrantedAt']) c['am.' + k] = a[k];
      for (const k of TT.concat(['counsellor_first_activity_date', 'counsellor_last_activity_date', 'createdAt', 'updatedAt'])) c['v1trk.' + k] = r1[k];
      if (live2) for (const k of TT.concat(['counsellor_first_activity_date', 'counsellor_last_activity_date'])) c['v2trk.' + k] = live2[k];
      const paid = (fd.get(Number(l.v1_application_id)) || []).filter(r => r.isPaid);
      if (paid.length) {
        c['fd.paid.updatedAt'] = paid[paid.length - 1].updatedAt; c['fd.paid.createdAt'] = paid[0].createdAt;
        c['fd.paymentPartner'] = paid[paid.length - 1].paymentPartner;
        const txs = paid.flatMap(p => ftByDue.get(p.id) || []);
        if (txs.length) { c['ft.paidOn'] = txs[txs.length - 1].paidOn; c['ft.createdAt'] = txs[txs.length - 1].createdAt; c['ft.paymentPartner'] = txs[txs.length - 1].paymentPartner; }
      }
      const ev = (ut.get(Number(l.v1_lead_id)) || []).slice().sort((x, y) => ms(x.createdAt) - ms(y.createdAt));
      const st = ev.filter(e => e.leadStageId != null);
      if (st.length) {
        c['ut.firstStageEvent'] = st[0].createdAt; c['ut.lastStageEvent'] = st[st.length - 1].createdAt;
        const cur = st.filter(e => Number(e.leadStageId) === Number(m.leadStageId));
        if (cur.length) { c['ut.enteredCurrentStage.first'] = cur[0].createdAt; c['ut.enteredCurrentStage.last'] = cur[cur.length - 1].createdAt; }
      }
      const as = ev.filter(e => /application stage/i.test(e.title || ''));
      if (as.length) c['ut.lastAppStageEvent'] = as[as.length - 1].createdAt;
      const sub = ev.filter(e => /submit/i.test(e.title || ''));
      if (sub.length) c['ut.submitEvent'] = sub[0].createdAt;
      return c;
    };

    // ---------------------------------------------------------------- A. evidence
    hr('A. which v1 value reproduces the v2 value, on rows where v2 HAS it');
    const targets = [...TL.map(c => ['lead', c]), ...TT.map(c => ['trk', c])];
    for (const [kind, col] of targets) {
      const hits = new Map(); let n = 0;
      for (const l of all) {
        const val = kind === 'lead' ? l[col] : (t2.get(Number(l.id)) || {})[col];
        if (val == null) continue;
        n++;
        const c = cand(l);
        for (const [k, v] of Object.entries(c)) {
          if (v == null || (kind === 'trk' && k === 'v2trk.' + col)) continue;
          const h = hits.get(k) || { exact: 0, day: 0, both: 0 };
          h.both++;
          const d = Math.abs(ms(v) - ms(val));
          if (d <= 2000) h.exact++; else if (d <= 86400000) h.day++;
          hits.set(k, h);
        }
      }
      const ranked = [...hits.entries()].filter(([, h]) => h.both >= 3).sort((x, y) => (y[1].exact / y[1].both) - (x[1].exact / x[1].both) || y[1].exact - x[1].exact).slice(0, 4);
      log(`\n  ${kind === 'lead' ? 'v2_leads' : 'tracker'}.${col}   (v2 filled on ${n} evidence rows)`);
      ranked.forEach(([k, h]) => log(`      ${k.padEnd(34)} exact(<=2s) ${String(h.exact).padStart(5)}/${String(h.both).padEnd(5)} ${(100 * h.exact / h.both).toFixed(1).padStart(5)}%   within a day +${h.day}`));
    }
    // partner (text)
    {
      const h = new Map(); let n = 0;
      for (const l of all) {
        if (!l.payment_partner) continue; n++;
        const c = cand(l);
        for (const k of ['fd.paymentPartner', 'ft.paymentPartner']) if (c[k]) { const x = h.get(k) || [0, 0]; x[1]++; if (String(c[k]).toLowerCase() === String(l.payment_partner).toLowerCase()) x[0]++; h.set(k, x); }
      }
      log(`\n  v2_leads.payment_partner   (v2 filled on ${n})`);
      for (const [k, [e, b]] of h) log(`      ${k.padEnd(34)} same ${e}/${b}`);
    }

    // ---------------------------------------------------------------- B. native semantics
    hr('B. how v2 relates these on its OWN (native) UG rows');
    const { rows: nat } = await v2.query(`
      select l.*, t."application_fee_paidOn" t_paid, t."payment_Initiated_date" t_pi, t."payment_last_Initiated_date" t_pl,
             t."applicationFormSubmittedOn" t_sub, t."lastLeadStageUpdated" t_lls, t."firstLeadStageUpdated" t_fls,
             t."application_last_activity_date" t_lad, t."applicationForm_start_date" t_start
      from v2_leads l left join "ApplicationActivityTrackers" t on t."leadId" = l.id
      where l.org_id = $1 and l.school_id = $2 and l.form_id = any($3::int[]) and not l.is_deleted and l.v1_lead_id is null`,
      [M.ORG_V2, M.SCHOOL_V2, M.V2_FORMS]);
    const rel = (a, b, label) => {
      const both = nat.filter(r => r[a] != null && r[b] != null);
      const ex = both.filter(r => Math.abs(ms(r[a]) - ms(r[b])) <= 2000).length;
      const near = both.filter(r => Math.abs(ms(r[a]) - ms(r[b])) <= 600000).length;
      const onlyA = nat.filter(r => r[a] != null && r[b] == null).length, onlyB = nat.filter(r => r[a] == null && r[b] != null).length;
      log(`  ${label.padEnd(62)} both ${String(both.length).padStart(5)}  exact ${String(ex).padStart(5)}  within 10min ${String(near).padStart(5)}   only-left ${onlyA} only-right ${onlyB}`);
    };
    rel('payment_completed_at', 't_paid', 'payment_completed_at  vs tracker application_fee_paidOn');
    rel('payment_first_initiated_at', 't_pi', 'payment_first_initiated_at vs tracker payment_Initiated_date');
    rel('payment_last_initiated_at', 't_pl', 'payment_last_initiated_at  vs tracker payment_last_Initiated_date');
    rel('form_completion_date', 't_sub', 'form_completion_date vs tracker applicationFormSubmittedOn');
    rel('form_completion_date', 'payment_completed_at', 'form_completion_date vs payment_completed_at');
    rel('lead_stage_date', 't_lls', 'lead_stage_date vs tracker lastLeadStageUpdated');
    rel('lead_stage_date', 'created_at', 'lead_stage_date vs created_at');
    rel('application_stage_date', 'application_registered_on', 'application_stage_date vs application_registered_on');
    rel('application_stage_date', 'payment_completed_at', 'application_stage_date vs payment_completed_at');
    rel('t_start', 'application_registered_on', 'tracker applicationForm_start_date vs application_registered_on');
    rel('t_lad', 'updated_at', 'tracker application_last_activity_date vs updated_at');
    const { rows: pp } = await v2.query(`select payment_partner, count(*)::int n from v2_leads where org_id = $1 and school_id = $2 and payment_status = 'completed' group by 1 order by 2 desc`, [M.ORG_V2, M.SCHOOL_V2]);
    log(`\n  payment_partner on paid UG rows: ${pp.map(r => `${r.payment_partner}=${r.n}`).join(', ')}`);

    hr('C. v1 timeline event titles seen (stage / submit / payment)');
    [...titles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([t, n]) => log(`  ${String(n).padStart(7)}  ${t}`));
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('ERR', e.message); console.error(e.stack); process.exit(1); });
