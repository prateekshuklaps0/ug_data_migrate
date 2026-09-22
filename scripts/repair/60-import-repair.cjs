/**
 * STREAM H - REPAIR IMPORT.  The only repair script that writes.
 *
 *   node scripts/repair/60-import-repair.cjs                 # DRY RUN - every batch rolled back
 *   node scripts/repair/60-import-repair.cjs --apply         # commits
 *   node scripts/repair/60-import-repair.cjs --run <id>      # pick a repair export (default newest)
 *   ... --restart                                            # ignore the checkpoint
 *
 * The user's rules (lib/repair-rules.cjs): CONTENT is filled only where v2 is EMPTY (v2 is
 * the source of truth); PROGRESS (submitted / paid / % / section / "last" dates) only moves
 * FORWARD; nothing is ever blanked.
 *
 * Safety, in order:
 *  1. app.skip_automation = 'true' at SESSION level, read back, re-checked after every
 *     batch. Inside EVERY batch - before it commits (or, in a dry run, rolls back) -
 *     automation_events is checked for the batch's leads; one event aborts the batch.
 *  2. Live CRM first: batches of 250 rows, each ONE short transaction of a few statements,
 *     a pause between batches, lock_timeout 3s, FOR UPDATE SKIP LOCKED - a row a counsellor
 *     is editing right now is skipped (and retried at the end) instead of waited for.
 *  3. Per batch: rows are locked and read LIVE, the rules re-applied to the live values and
 *     asserted, ONE set-based UPDATE applies them with the rule guard inside the SQL
 *     (guardExpr), and every row is read back: any column that changed without being
 *     planned, went blank, or a planned value that did not land -> the batch rolls back.
 *  4. v2_leads.updated_at is never touched. under_graduate.updated_at = now() on rows
 *     whose form answers are filled (an honest "this row changed").
 *  5. Checkpoint per batch; rollback.sql grows with every committed batch.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connect, armAutomationGuard } = require('../lib/db.cjs');
const M = require('../lib/maps.cjs');
const R = require('../lib/repair-rules.cjs');
const { Progress } = require('../lib/progress.cjs');

const ROOT = 'C:/Users/Prateek/Desktop/Repos/data/repair';
const BATCH = 250, PAUSE_MS = 60;
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const RESTART = args.includes('--restart');
const runArg = args.includes('--run') ? args[args.indexOf('--run') + 1] : null;
const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78));
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const readNd = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
const sleep = t => new Promise(r => setTimeout(r, t));
const lit = v => {
  if (v === null || v === undefined) return 'NULL';
  if (v instanceof Date) return `'${v.toISOString()}'`;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const norm = v => (v instanceof Date ? v.toISOString() : v);
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

(async () => {
  const runs = fs.readdirSync(ROOT).filter(d => /^\d{4}-/.test(d)).sort();
  const runId = runArg || runs[runs.length - 1];
  const DIR = path.join(ROOT, runId);
  hr(`STREAM H REPAIR IMPORT   ${APPLY ? '*** APPLY - this commits ***' : 'DRY RUN (every batch is rolled back)'}`);
  log(`  repair export : ${DIR}`);
  const man = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  for (const [f, m] of Object.entries(man.files)) if (sha256(path.join(DIR, f)) !== m.sha256) throw new Error(`${f} changed after export - refusing`);
  log(`  checksums     : all ${Object.keys(man.files).length} files verified`);
  const PH = [
    { key: 'forms', file: 'h_forms.ndjson', table: 'under_graduate', label: 'application form answers', bump: true,
      lockSql: 'select * from under_graduate where id = any($1::int[]) and org_id = $2 for update skip locked', lockArgs: [M.ORG_V2],
      idOf: r => r.ug_id, belongs: (r, live) => Number(live.lead_id) === r.v2_lead_id },
    { key: 'leads', file: 'h_leads.ndjson', table: 'v2_leads', label: 'lead: progress, payment, stage + submission dates', bump: false,
      lockSql: 'select * from v2_leads where id = any($1::bigint[]) and org_id = $2 and school_id = $3 and not is_deleted for update skip locked',
      lockArgs: [M.ORG_V2, M.SCHOOL_V2], idOf: r => r.v2_lead_id, belongs: (r, live) => Number(live.v1_lead_id) === r.v1_lead_id },
    { key: 'trackers', file: 'h_trackers.ndjson', table: '"ApplicationActivityTrackers"', label: 'activity tracker dates', bump: false,
      lockSql: 'select * from "ApplicationActivityTrackers" where id = any($1::int[]) for update skip locked', lockArgs: [],
      idOf: r => r.tracker_id, belongs: (r, live) => Number(live.leadId) === r.v2_lead_id },
  ];
  for (const ph of PH) ph.rows = readNd(path.join(DIR, ph.file));
  log(`  payload       : ${PH.map(p => `${p.rows.length} ${p.key}`).join(', ')}`);

  const RUN_TS = new Date().toISOString().replace(/[:.]/g, '-');
  const RUNDIR = path.join(DIR, 'runs', RUN_TS);
  fs.mkdirSync(RUNDIR, { recursive: true });
  const RB = path.join(RUNDIR, 'rollback.sql');
  if (APPLY) fs.writeFileSync(RB, ['-- Rollback for Stream H repair run ' + RUN_TS,
    '-- Restores the exact values each row had immediately before this run changed it.',
    '-- One statement per row, each independent. Review before running.',
    "-- app.skip_automation MUST stay: undoing a v2_leads change would otherwise emit events.",
    "SET app.skip_automation = 'true';", ''].join('\n'));

  const CKPT = path.join(DIR, 'checkpoint.json');
  let ckpt = { manifestSha: sha256(path.join(DIR, 'manifest.json')), phases: {} };
  if (APPLY && !RESTART && fs.existsSync(CKPT)) {
    const d = JSON.parse(fs.readFileSync(CKPT, 'utf8'));
    if (d.manifestSha === ckpt.manifestSha) ckpt = d; else log('  checkpoint for a different payload - ignored');
    for (const [k, v] of Object.entries(ckpt.phases)) log(`  checkpoint    : ${k} - ${v.done ? 'DONE' : `${v.batches} batch(es) committed`} - resuming after that`);
  }
  const saveCkpt = () => { if (APPLY) fs.writeFileSync(CKPT, JSON.stringify(ckpt, null, 2)); };

  const v2 = await connect('v2', { readOnly: false });
  const totals = {};
  try {
    hr('0. automation guard + live-CRM protections');
    await armAutomationGuard(v2);
    await v2.query(`set lock_timeout = '3s'`);
    await v2.query(`set statement_timeout = '120s'`);
    log(`  app.skip_automation = "true"  (verified)   lock_timeout 3s   batches of ${BATCH}, FOR UPDATE SKIP LOCKED`);
    const { rows: [b] } = await v2.query('select coalesce(max(id),0)::bigint mx from automation_events');
    const BASE = b.mx;
    log(`  automation_events baseline id: ${BASE}`);

    // exact column types, for jsonb_to_recordset
    const typesOf = async table => {
      const { rows } = await v2.query(`select attname, format_type(atttypid, atttypmod) t from pg_attribute
        where attrelid = $1::regclass and attnum > 0 and not attisdropped`, [table]);
      return new Map(rows.map(r => [r.attname, r.t]));
    };

    let proof = 0;
    let pn = 0;
    for (const ph of PH) {
      pn++;
      hr(`${pn}. ${ph.label}  (${ph.rows.length} rows)`);
      const st = ckpt.phases[ph.key] || { batches: 0, done: false };
      if (APPLY && st.done) { log(`  SKIPPED - completed at ${st.at}`); continue; }
      const types = await typesOf(ph.table);
      const nb = Math.ceil(ph.rows.length / BATCH);
      const bar = new Progress(ph.rows.length, ph.key);
      const tot = { rows: 0, cols: 0, nothingLeft: 0, locked: 0, gone: 0, byCol: {} };
      let retry = [];

      const runBatch = async (rows, isRetry) => {
        const rbOut = [];
        await v2.query('begin');
        try {
          // 1. lock + read LIVE
          const { rows: liveRows } = await v2.query(ph.lockSql, [rows.map(ph.idOf), ...ph.lockArgs]);
          const liveBy = new Map(liveRows.map(r => [Number(r.id), r]));
          const missing = rows.filter(r => !liveBy.has(ph.idOf(r)));
          if (missing.length) {
            const { rows: ex } = await v2.query(`select id from ${ph.table} where id = any($1)`, [missing.map(ph.idOf)]);
            const exists = new Set(ex.map(e => Number(e.id)));
            for (const r of missing) {
              if (!exists.has(ph.idOf(r))) tot.gone++;
              else if (!isRetry) { retry.push(r); tot.locked++; } else tot.locked++;
            }
          }
          // 2. re-apply the rules to the live values
          const writes = [];
          for (const r of rows) {
            const live = liveBy.get(ph.idOf(r));
            if (!live) continue;
            if (!ph.belongs(r, live)) { tot.gone++; continue; }             // re-linked since export - leave it
            const set = R.plan(ph.table, live, r.want);
            if (!Object.keys(set).length) { tot.nothingLeft++; continue; }
            R.assertAllowed(`${ph.key} ${ph.idOf(r)}`, ph.table, live, set);
            writes.push({ r, live, set });
          }
          // 3. ONE guarded, set-based UPDATE
          if (writes.length) {
            const cols = [...new Set(writes.flatMap(w => Object.keys(w.set)))];
            for (const c of cols) if (!types.has(c)) throw new Error(`${ph.table}.${c} does not exist`);
            const idType = types.get('id');
            const payload = writes.map(w => Object.fromEntries([['id', Number(w.live.id)], ...cols.map(c => [c, c in w.set ? w.set[c] : null])]));
            const sql = `UPDATE ${ph.table} AS t SET ${cols.map(c => `"${c}" = ${R.guardExpr(ph.table, c, `t."${c}"`, `v."${c}"`)}`).join(', ')}` +
              `${ph.bump ? ', updated_at = now()' : ''}` +
              ` FROM jsonb_to_recordset($1::jsonb) AS v(id ${idType}, ${cols.map(c => `"${c}" ${types.get(c)}`).join(', ')})` +
              ` WHERE t.id = v.id`;
            const res = await v2.query(sql, [JSON.stringify(payload)]);
            if (res.rowCount !== writes.length) throw new Error(`${ph.key}: updated ${res.rowCount} rows, expected ${writes.length} - rolled back`);
            // 4. whole-row proof
            const { rows: afterRows } = await v2.query(`select * from ${ph.table} where id = any($1)`, [writes.map(w => Number(w.live.id))]);
            const afterBy = new Map(afterRows.map(r => [Number(r.id), r]));
            for (const w of writes) {
              const after = afterBy.get(Number(w.live.id));
              const ks = Object.keys(w.set);
              for (const c of Object.keys(w.live)) {
                if (ks.includes(c) || (ph.bump && c === 'updated_at')) continue;
                if (!same(w.live[c], after[c])) throw new Error(`${ph.key} ${w.live.id}: ${c} changed without being planned - batch rolled back`);
              }
              for (const c of Object.keys(w.live)) if (!R.isEmpty(w.live[c]) && R.isEmpty(after[c])) throw new Error(`${ph.key} ${w.live.id}: ${c} went BLANK - batch rolled back`);
              if (Object.keys(R.plan(ph.table, after, w.r.want)).length) throw new Error(`${ph.key} ${w.live.id}: a planned value did not land - batch rolled back`);
              proof++;
              tot.rows++; tot.cols += ks.length; ks.forEach(c => { tot.byCol[c] = (tot.byCol[c] || 0) + 1; });
              rbOut.push(`UPDATE ${ph.table} SET ${[...ks, ...(ph.bump ? ['updated_at'] : [])].map(c => `"${c}" = ${lit(w.live[c])}`).join(', ')} WHERE id = ${w.live.id};`);
            }
            // 5. the automation guard, before anything commits. Only an event inserted by
            //    THIS transaction can come from our UPDATE; Postgres stamps every row with
            //    the inserting transaction id (xmin). Events the live CRM commits meanwhile
            //    (the 30-second lead_score job, a counsellor changing a substage) carry a
            //    different xmin - counted separately, reported, never confused with ours.
            const leadIds = [...new Set(writes.map(w => w.r.v2_lead_id))];
            const { rows: [ev] } = await v2.query(`
              select count(*) filter (where xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text)::int ours,
                     count(*)::int total
              from automation_events where id > $1 and table_name = 'v2_leads' and row_id = any($2::bigint[])`, [BASE, leadIds]);
            if (ev.ours) throw new Error(`${ev.ours} automation event(s) were emitted BY THIS REPAIR - batch rolled back, STOP and investigate`);
            tot.liveEvents = Math.max(tot.liveEvents || 0, ev.total);
          }
          if (APPLY) { await v2.query('commit'); if (rbOut.length) fs.appendFileSync(RB, rbOut.join('\n') + '\n'); }
          else await v2.query('rollback');
        } catch (e) { await v2.query('rollback').catch(() => {}); throw e; }
        const { rows: [g] } = await v2.query(`select current_setting('app.skip_automation', true) v`);
        if (g.v !== 'true') throw new Error('app.skip_automation is no longer true - aborting');
        bar.tick(rows.length);
      };

      for (let bi = 0; bi < nb; bi++) {
        const rows = ph.rows.slice(bi * BATCH, (bi + 1) * BATCH);
        if (APPLY && bi < st.batches) { bar.tick(rows.length); continue; }
        await runBatch(rows, false);
        if (APPLY) { st.batches = bi + 1; ckpt.phases[ph.key] = st; saveCkpt(); }
        await sleep(PAUSE_MS);
      }
      bar.done();
      if (retry.length) {
        log(`  retrying ${retry.length} row(s) that a live user had locked...`);
        await sleep(2000);
        const again = retry; retry = []; tot.locked -= again.length;
        for (let i = 0; i < again.length; i += BATCH) await runBatch(again.slice(i, i + BATCH), true);
      }
      log(`  ${tot.rows} row(s) written (${tot.cols} values)   already up to date: ${tot.nothingLeft}   busy: ${tot.locked}   gone/re-linked: ${tot.gone}`);
      Object.entries(tot.byCol).sort().forEach(([c, n]) => log(`      ${String(n).padStart(6)}  ${c}`));
      totals[ph.key] = tot;
      if (APPLY) { st.done = true; st.at = new Date().toISOString(); ckpt.phases[ph.key] = st; saveCkpt(); }
    }

    hr(`${pn + 1}. verification`);
    log(`  whole-row proof passed on ${proof} row(s): no unplanned column changed, nothing went blank, every planned value landed`);
    log('  automation_events checked inside every batch before it committed: 0 events emitted by this repair');
    const live = Object.values(totals).reduce((n, t) => n + (t.liveEvents || 0), 0);
    if (live) log(`  (the live CRM meanwhile logged its own events on some of these leads - lead_score job, counsellor edits - not the repair)`);
    const busy = Object.values(totals).reduce((n, t) => n + t.locked, 0);
    if (busy) log(`  ${busy} row(s) were being edited by a live user - re-run the same command later; it only does what is left`);
    if (APPLY) {
      fs.writeFileSync(path.join(RUNDIR, 'summary.json'), JSON.stringify({ runId, RUN_TS, totals }, null, 2));
      log(`\n  run artefacts: ${RUNDIR}\n    rollback.sql, summary.json`);
    }
    hr(APPLY ? 'REPAIR COMPLETE (COMMITTED)' : 'DRY RUN COMPLETE (nothing was committed)');
    for (const [k, t] of Object.entries(totals)) log(`  ${k.padEnd(9)} ${t.rows} rows, ${t.cols} values${t.locked ? `, ${t.locked} busy` : ''}`);
    if (!APPLY) log('\n  Re-run with --apply to commit.');
  } finally { await v2.end(); }
})().catch(e => { console.error('\nREPAIR IMPORT FAILED:', e.message); console.error(e.stack); process.exit(1); });
