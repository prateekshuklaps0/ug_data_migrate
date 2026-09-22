/**
 * READ-ONLY. Application-form drift on applicants that ARE already in v2.
 *
 * The old sync copied an applicant once. If the student kept filling the form in v1
 * afterwards (the v1 portal stayed live), v2 still holds the early snapshot.
 * Found 2026-09-22 from testers' reports (Aaliyah Ahmed, Rabia Ahuja).
 *
 * For every live v2 UG applicant with a v1 application it compares:
 *   - under_graduate columns, built from v1 with the SAME mapping the migration uses
 *   - the form-progress fields on v2_leads (submitted / % / section / completion date)
 * and classifies each difference:
 *   FILL      v1 has a value, v2 is empty                        -> safe to copy
 *   CONFLICT  both have a value and they differ                  -> needs a rule
 * and says who edited last: v1 (the student's latest answers) or v2.
 *
 *   node scripts/32-form-drift.cjs [--show <email>]
 */
const { connect } = require('./lib/db.cjs');
const M = require('./lib/maps.cjs');
const { buildApplicantUnderGraduate } = require('./lib/appform.cjs');

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(84) + '\n' + t + '\n' + '='.repeat(84));
const args = process.argv.slice(2);
const SHOW = args.includes('--show') ? args.slice(args.indexOf('--show') + 1).map(s => s.toLowerCase()) : [];

const norm = v => {
  if (v === null || v === undefined) return null;
  let s = String(v).trim();
  // a v2 timestamptz at UTC midnight is the same calendar date as v1's YYYY-MM-DD
  const m = s.match(/^(\d{4}-\d{2}-\d{2}) 00:00:00(\+00)?$/);
  if (m) s = m[1];
  return s === '' ? null : s;
};

(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    hr('1. live v2 UG applicants that carry a v1 application');
    const { rows: apps } = await v2.query(`
      select id, v1_lead_id, v1_application_id, registered_email, registered_name, form_id,
             application_form_submitted, form_percentage_filled, last_interacted_section,
             form_completion_date, updated_at
      from v2_leads
      where org_id = $1 and school_id = $2 and form_id = any($3::int[]) and not is_deleted
        and v1_application_id is not null`, [M.ORG_V2, M.SCHOOL_V2, M.V2_FORMS]);
    log(`  ${apps.length} applicants`);

    const amIds = apps.map(a => Number(a.v1_application_id));
    const leadIds = apps.map(a => Number(a.id));

    // v1: application state + when the student last touched an answer
    const am = new Map(), lastAns = new Map();
    for (let i = 0; i < amIds.length; i += 2000) {
      const chunk = amIds.slice(i, i + 2000);
      const { rows } = await v1.query(`
        select id, "applicationFormSubmitted" sub, "applicationStatus" st, "lastInteractedSection" sec,
               "formCompletionDate" fcd, "applicationFormId" f from "ApplicationManager" where id = any($1::int[])`, [chunk]);
      rows.forEach(r => am.set(r.id, r));
      const { rows: t } = await v1.query(`
        select "applicationManagerId" a, max("updatedAt") last from "ApplicationResponses"
        where "applicationManagerId" = any($1::int[]) group by 1`, [chunk]);
      t.forEach(r => lastAns.set(r.a, r.last));
    }

    // v1: the under_graduate payload, same code the migration uses
    const payload = new Map();
    for (let i = 0; i < amIds.length; i += 500) {
      const m = await buildApplicantUnderGraduate(v1, amIds.slice(i, i + 500));
      for (const [k, v] of m) if (typeof k === 'number') payload.set(k, v);
    }
    const allCols = [...new Set([...payload.values()].flatMap(o => Object.keys(o)))];
    const { rows: ugc } = await v2.query(`select column_name from information_schema.columns where table_name = 'under_graduate'`);
    const ugColSet = new Set(ugc.map(r => r.column_name));
    const cols = allCols.filter(c => ugColSet.has(c));

    // v2: current under_graduate, every compared column as TEXT (dates/bools compare cleanly)
    const ug = new Map();
    for (let i = 0; i < leadIds.length; i += 2000) {
      const { rows } = await v2.query(`
        select lead_id, id, updated_at, ${cols.map(c => `"${c}"::text as "${c}"`).join(', ')}
        from under_graduate where lead_id = any($1::bigint[])`, [leadIds.slice(i, i + 2000)]);
      rows.forEach(r => ug.set(Number(r.lead_id), r));
    }

    hr('2. comparison');
    const res = [];
    for (const a of apps) {
      const aid = Number(a.v1_application_id);
      const want = payload.get(aid) || {};
      const have = ug.get(Number(a.id));
      const fill = [], conflict = [];
      for (const c of Object.keys(want)) {
        if (!ugColSet.has(c)) continue;
        const w = norm(want[c]), h = have ? norm(have[c]) : null;
        if (w === null) continue;
        if (h === null) fill.push(c);
        else if (w !== h) conflict.push({ c, v1: w, v2: h });
      }
      const s = am.get(aid) || {};
      const pct1 = (s.st === 'untouched' || s.st == null) ? 0 : (Number(s.st) || 0);
      const prog = [];
      if (s.sub === true && a.application_form_submitted !== true) prog.push('submitted false->true');
      if (pct1 > Number(a.form_percentage_filled || 0)) prog.push(`% ${Number(a.form_percentage_filled || 0)}->${pct1}`);
      if (s.sec != null && (a.last_interacted_section == null || Number(s.sec) > Number(a.last_interacted_section))) prog.push(`section ${a.last_interacted_section}->${s.sec}`);
      if (s.fcd && !a.form_completion_date) prog.push('completion date');
      const v1Last = lastAns.get(aid) ? new Date(lastAns.get(aid)) : null;
      const v2Last = have ? new Date(have.updated_at) : null;
      res.push({ a, fill, conflict, prog, v1Last, v2Last, hasRow: !!have,
        v1Newer: v1Last && (!v2Last || v1Last > v2Last) });
    }

    const behind = res.filter(r => r.fill.length || r.conflict.length || r.prog.length);
    const onlyFill = behind.filter(r => !r.conflict.length);
    const withConf = behind.filter(r => r.conflict.length);
    log(`  applicants compared                        : ${res.length}`);
    log(`  identical to v1 (nothing to do)            : ${res.length - behind.length}`);
    log(`  BEHIND v1                                  : ${behind.length}`);
    log(`    only EMPTY v2 fields to fill (safe)      : ${onlyFill.length}`);
    log(`    has at least one CONFLICTING value       : ${withConf.length}`);
    log(`    ... of those, v1 edited AFTER v2         : ${withConf.filter(r => r.v1Newer).length}`);
    log(`    ... of those, v2 edited AFTER v1         : ${withConf.filter(r => !r.v1Newer).length}`);
    const withFill = behind.filter(r => r.fill.length || r.prog.length);
    log(`  => applicants with EMPTY v2 fields or progress behind (the actionable set): ${withFill.length}`);
    log(`     ... whose student edited in v1 AFTER the v2 form row was written   : ${withFill.filter(r => r.v1Newer).length}`);
    log(`     ... total empty v2 fields v1 could fill                            : ${withFill.reduce((n, r) => n + r.fill.length, 0)}`);
    log(`    form-progress behind (submitted/%/section): ${behind.filter(r => r.prog.length).length}`);
    log(`    have NO under_graduate row at all        : ${behind.filter(r => !r.hasRow).length}`);

    const byMonth = new Map();
    behind.forEach(r => { const k = r.v1Last ? r.v1Last.toISOString().slice(0, 10) : 'none'; byMonth.set(k, (byMonth.get(k) || 0) + 1); });
    log('\n  when the student last edited in v1 (behind applicants):');
    [...byMonth.entries()].sort().slice(-15).forEach(([k, n]) => log(`    ${k}  ${n}`));

    const cc = new Map();
    withConf.forEach(r => r.conflict.forEach(x => cc.set(x.c, (cc.get(x.c) || 0) + 1)));
    log('\n  conflicting columns (both sides filled, different):');
    [...cc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([c, n]) => log(`    ${String(n).padStart(5)}  ${c}`));
    log('  sample conflicts:');
    withConf.slice(0, 8).forEach(r => r.conflict.slice(0, 2).forEach(x =>
      log(`    lead ${r.a.id} ${x.c}: v1=${JSON.stringify(x.v1).slice(0, 40)}  v2=${JSON.stringify(x.v2).slice(0, 40)}`)));

    // Which side edited last decides whether an empty v2 field is SAFE to fill.
    //   v1 newer : the student carried on in v1 after the copy -> v2 is simply behind
    //   v2 newer : the row was touched in v2 after the student's last v1 edit, so an
    //              empty v2 field could be one the student cleared on purpose
    hr('2b. empty v2 fields, split by which side edited last');
    {
      const wf = res.filter(r => r.fill.length || r.prog.length);
      const newer = wf.filter(r => r.v1Newer), older = wf.filter(r => !r.v1Newer);
      const tally = rs => {
        const m = new Map();
        rs.forEach(r => r.fill.forEach(c => m.set(c, (m.get(c) || 0) + 1)));
        return [...m.entries()].sort((a, b) => b[1] - a[1]);
      };
      log(`  v1 NEWER - the student kept filling in v1 after the copy (${newer.length} applicants):`);
      newer.forEach(r => log(`    lead ${String(r.a.id).padEnd(8)} ${String(r.a.registered_email).padEnd(34).slice(0, 34)} ` +
        `fill=${String(r.fill.length).padStart(2)}  ${r.prog.join(', ')}   v1 ${r.v1Last.toISOString().slice(0, 16)}  v2 row ${r.v2Last ? r.v2Last.toISOString().slice(0, 16) : '-'}`));
      log(`  columns:`);
      tally(newer).forEach(([c, n]) => log(`    ${String(n).padStart(4)}  ${c}`));
      log('');
      log(`  v2 NEWER - v2 row touched after the last v1 edit (${older.length} applicants):`);
      log(`  columns:`);
      tally(older).forEach(([c, n]) => log(`    ${String(n).padStart(4)}  ${c}`));
    }

    hr('3. worst 15 (most empty fields in v2)');
    behind.sort((x, y) => y.fill.length - x.fill.length).slice(0, 15).forEach(r => log(
      `  lead ${String(r.a.id).padEnd(8)} ${String(r.a.registered_email).padEnd(34).slice(0, 34)} fill=${String(r.fill.length).padStart(2)} conflict=${r.conflict.length} ${r.prog.join(', ')}  v1 last ${r.v1Last ? r.v1Last.toISOString().slice(0, 10) : '-'}`));

    for (const e of SHOW) {
      const r = res.find(x => (x.a.registered_email || '').toLowerCase() === e);
      hr(`detail: ${e}`);
      if (!r) { log('  not a live v2 applicant with a v1 application'); continue; }
      log(`  v2 lead ${r.a.id}   v1 app ${r.a.v1_application_id}   v1 last edit ${r.v1Last && r.v1Last.toISOString()}   v2 form row last edit ${r.v2Last && r.v2Last.toISOString()}`);
      log(`  form progress: ${r.prog.join(', ') || 'in step'}`);
      const want = payload.get(Number(r.a.v1_application_id)) || {}; const have = ug.get(Number(r.a.id)) || {};
      log(`  ${'column'.padEnd(52)} ${'v1 (student answer)'.padEnd(30)} v2 now`);
      for (const c of Object.keys(want)) {
        if (!ugColSet.has(c)) continue;
        const w = norm(want[c]), h = norm(have[c]);
        const tag = w === h ? '' : h === null ? '   <- MISSING in v2' : '   <- DIFFERENT';
        log(`  ${c.padEnd(52)} ${String(w).slice(0, 29).padEnd(30)} ${String(h).slice(0, 29)}${tag}`);
      }
    }
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('ERR', e.message); console.error(e.stack); process.exit(1); });
