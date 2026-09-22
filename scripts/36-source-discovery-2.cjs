/**
 * READ-ONLY. Round 2 of source discovery: DERIVED v1 values for the columns v1 never
 * stored directly. Each candidate is scored against rows where v2 already HAS the value.
 *
 *   ut.enteredLeadStage  - when the lead ENTERED its current MAIN stage (substage-only
 *                          changes do not count - v2 only stamps lead_stage_date on a
 *                          main-stage change: processChangeLeadStage.js)
 *   ut.enteredAppStage   - same for the application stage, parsed from the event text
 *                          ("changed application stage from 'A' to 'B'")
 *   ut.firstStageChange / ut.lastStageChange  - first / last Changed_Lead_Stage event
 *   ar.lastAnswer / ar.firstAnswer - last / first save of any form answer
 *
 *   node scripts/36-source-discovery-2.cjs
 */
const { connect } = require('./lib/db.cjs');
const M = require('./lib/maps.cjs');
const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(88) + '\n' + t + '\n' + '='.repeat(88));
const ms = v => v == null ? null : new Date(v).getTime();

/** "... changed application stage from 'A' substage: 'x' to 'B' substage: 'y'" -> {from:'a', to:'b'} */
function parseAppStage(msg) {
  if (!msg) return null;
  const to = msg.match(/ to '([^']+)'/i);
  const from = msg.match(/ from '([^']+)'/i);
  if (!to) return null;
  return { from: from ? from[1].trim().toLowerCase() : null, to: to[1].trim().toLowerCase() };
}

(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { stage } = await M.buildStageMaps(v1, v2);
    const { rows: leads } = await v2.query(`
      select l.id, l.v1_lead_id, l.v1_application_id, l.lead_stage_id, l.application_stage_id, l.lead_stage_date,
             l.application_stage_date, l.form_completion_date, s."stageName" app_stage_name,
             t."applicationFormSubmittedOn", t."firstLeadStageUpdated", t."lastLeadStageUpdated",
             t."application_last_activity_date", t."applicationForm_start_date"
      from v2_leads l
      left join "ApplicationActivityTrackers" t on t."leadId" = l.id
      left join "applicationStage" s on s.id = l.application_stage_id
      where l.org_id = $1 and l.school_id = $2 and l.form_id = any($3::int[]) and not l.is_deleted and l.v1_lead_id is not null`,
      [M.ORG_V2, M.SCHOOL_V2, M.V2_FORMS]);
    // evidence rows: something relevant is filled in v2
    const ev = leads.filter(l => l.application_stage_date || l.form_completion_date || l.applicationFormSubmittedOn ||
      (l.firstLeadStageUpdated && Math.random() < 0.35) || (l.application_last_activity_date && l.v1_application_id));
    log(`evidence rows: ${ev.length}`);

    const v1ids = ev.map(l => Number(l.v1_lead_id));
    const ut = new Map(), ar = new Map();
    for (let i = 0; i < v1ids.length; i += 3000) {
      (await v1.query(`select "leadId", "leadStageId", "createdAt", "eventType"->>'title' title, message from "UserTimelines"
                        where "leadId" = any($1::int[]) and "eventType"->>'title' in ('Changed_Lead_Stage','Stage Assigned','Application Stage Changed')
                        order by "createdAt", id`, [v1ids.slice(i, i + 3000)]))
        .rows.forEach(r => { if (!ut.has(r.leadId)) ut.set(r.leadId, []); ut.get(r.leadId).push(r); });
    }
    const amids = ev.filter(l => l.v1_application_id).map(l => Number(l.v1_application_id));
    for (let i = 0; i < amids.length; i += 3000) {
      (await v1.query(`select "applicationManagerId" a, min("createdAt") first, max("updatedAt") last from "ApplicationResponses"
                        where "applicationManagerId" = any($1::int[]) group by 1`, [amids.slice(i, i + 3000)]))
        .rows.forEach(r => ar.set(r.a, r));
    }

    const cand = l => {
      const c = {};
      const e = ut.get(Number(l.v1_lead_id)) || [];
      const ls = e.filter(x => x.leadStageId != null && x.title !== 'Application Stage Changed');
      const ch = ls.filter(x => x.title === 'Changed_Lead_Stage');
      if (ch.length) { c['ut.firstStageChange'] = ch[0].createdAt; c['ut.lastStageChange'] = ch[ch.length - 1].createdAt; }
      if (ls.length) { c['ut.firstStageEvent'] = ls[0].createdAt; c['ut.lastStageEvent'] = ls[ls.length - 1].createdAt; }
      // entered the CURRENT v2 main stage: last transition into a v1 stage that maps to it
      let prev = null, entered = null;
      for (const x of ls) {
        const mapped = stage.get(x.leadStageId);
        if (mapped === Number(l.lead_stage_id) && prev !== mapped) entered = x.createdAt;
        prev = mapped;
      }
      if (entered) c['ut.enteredLeadStage'] = entered;
      // application stage, from the event text
      const as = e.filter(x => x.title === 'Application Stage Changed').map(x => ({ at: x.createdAt, p: parseAppStage(x.message) })).filter(x => x.p);
      if (as.length) {
        c['ut.lastAppStageChange'] = as[as.length - 1].at;
        const cur = (l.app_stage_name || '').trim().toLowerCase();
        const into = as.filter(x => x.p.to === cur && x.p.from !== cur);
        if (into.length) c['ut.enteredAppStage'] = into[into.length - 1].at;
      }
      const a = ar.get(Number(l.v1_application_id));
      if (a) { c['ar.firstAnswer'] = a.first; c['ar.lastAnswer'] = a.last; }
      return c;
    };

    hr('which DERIVED v1 value reproduces the v2 value (rows where v2 has it)');
    for (const col of ['application_stage_date', 'form_completion_date', 'applicationFormSubmittedOn', 'firstLeadStageUpdated',
      'lastLeadStageUpdated', 'application_last_activity_date', 'applicationForm_start_date', 'lead_stage_date']) {
      const hits = new Map(); let n = 0;
      for (const l of ev) {
        if (l[col] == null) continue; n++;
        for (const [k, v] of Object.entries(cand(l))) {
          if (v == null) continue;
          const h = hits.get(k) || { exact: 0, min10: 0, both: 0 };
          h.both++;
          const d = Math.abs(ms(v) - ms(l[col]));
          if (d <= 2000) h.exact++; else if (d <= 600000) h.min10++;
          hits.set(k, h);
        }
      }
      log(`\n  ${col}   (v2 filled on ${n} evidence rows)`);
      [...hits.entries()].sort((x, y) => (y[1].exact + y[1].min10) / y[1].both - (x[1].exact + x[1].min10) / x[1].both).slice(0, 5)
        .forEach(([k, h]) => log(`      ${k.padEnd(24)} exact ${String(h.exact).padStart(5)}  +within 10 min ${String(h.min10).padStart(5)}  of ${String(h.both).padEnd(5)} = ${(100 * (h.exact + h.min10) / h.both).toFixed(1)}%`));
    }
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('ERR', e.message); console.error(e.stack); process.exit(1); });
