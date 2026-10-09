/**
 * K12 INCIDENT REPAIR - 2026-10-09 12:17 IST
 *
 * WHAT HAPPENED
 *   `UPDATE v2_leads SET lead_stage_id = 132 WHERE form_id = 128;` was run by hand, with no
 *   is_deleted / stage filter and without `app.skip_automation`. It set EVERY form-128 lead to
 *   stage 132 ("Untouched"). The intent was only to fill the leads whose stage was NULL.
 *
 * WHAT IT ACTUALLY COST  (measured, not assumed)
 *   7,490 form-128 rows now read 132. The statement raised 1,675 automation_events, i.e. it
 *   really changed 1,675 rows; the other 5,815 were already 132:
 *     - 1,597 had stage NULL  -> 132  ... which is what the user WANTED. Left alone.
 *     -    78 had a REAL stage -> 132 ... this is the damage. Restored by this script.
 *   The 2 native v2 K12 rows were already 132 and raised no event, so they are untouched.
 *   `lead_stage_date` was NOT in the statement and is unchanged on all 78, so restoring
 *   `lead_stage_id` alone puts those rows back exactly as they were.
 *
 * NO COMMS WENT OUT. Verified on four layers: 0 workflow_executions and 0
 *   communicationAudiences for any form-128 lead (ever, not just today), and every published
 *   workflow on school 18 triggers on `lead_create` / `regular_interval` /
 *   `application_form_complete` / `application_form_progress` - NONE on a stage change. The
 *   1,675 events are all status=done with no action taken.
 *
 * TWO INDEPENDENT SOURCES OF TRUTH, and the run refuses unless they agree per row:
 *   1. `automation_events.before_data->>'lead_stage_id'` - the exact value the row held
 *      moments before the mistake, written by the trigger itself.
 *   2. `data/k12/2026-10-08T18-13-47-160Z/leads.ndjson` - the stage this migration imported,
 *      derived from v1.
 *   They agreed on all 78 when this was written, which also proves no counsellor had changed
 *   a stage in v2 between the migration and the mistake.
 *
 * SAFETY
 *   - `app.skip_automation = 'true'` at SESSION level, read back, re-verified after COMMIT.
 *   - `WHERE lead_stage_id = 132` is in the statement, so a stage someone sets between plan
 *     and write is never overwritten.
 *   - `updated_at` and `lead_stage_date` are not written.
 *   - Whole-row jsonb proof before/after; any other column moving aborts the transaction.
 *   - One short transaction for 78 rows. Undo SQL + CSV written on apply.
 *
 * USAGE
 *   node scripts/k12/81-restore-lead-stage-k12.cjs                      # dry run
 *   node scripts/k12/81-restore-lead-stage-k12.cjs --apply              # restore the 78
 *   node scripts/k12/81-restore-lead-stage-k12.cjs --also-revert-nulls  # ALSO put the 1,597
 *                                                                        back to NULL
 */
const fs = require('fs');
const path = require('path');
const { connect, armAutomationGuard, REPOS } = require('../lib/db.cjs');
const K = require('../k12/lib-k12.cjs');

const APPLY = process.argv.includes('--apply');
const REVERT_NULLS = process.argv.includes('--also-revert-nulls');
const WINDOW = '24 hours';
const EXPORT = path.join(REPOS, 'data', 'k12', '2026-10-08T18-13-47-160Z', 'leads.ndjson');
const BAD_STAGE = 132;
const RUN_TS = new Date().toISOString().replace(/[:.]/g, '-');
const RUNDIR = path.join(REPOS, 'data', 'k12', 'stage-restore-' + RUN_TS);

const log = s => console.log(s);
const hr = t => log('\n' + '='.repeat(92) + '\n' + t + '\n' + '='.repeat(92));
let pass = 0, fail = 0;
const ok = m => { pass++; log('  PASS  ' + m); };
const no = m => { fail++; log('  FAIL  ' + m); };

(async () => {
  const v2 = await connect('v2', { readOnly: false });
  const q = async (s, p) => (await v2.query(s, p)).rows;

  log(`K12 lead_stage_id restore        mode: ${APPLY ? 'APPLY (will COMMIT)' : 'DRY RUN (rolls back)'}`);
  log(`run ${RUN_TS}${REVERT_NULLS ? '        --also-revert-nulls: the 1,597 go back to NULL too' : ''}`);

  try {
    // ---------------------------------------------------------------- 0. guard
    hr('0. automation guard');
    await armAutomationGuard(v2);
    const [g] = await q(`select current_setting('app.skip_automation', true) v`);
    g.v === 'true' ? ok('app.skip_automation = "true" (read back from the session)')
                   : no('could not arm the automation guard');
    if (g.v !== 'true') throw new Error('refusing to continue without the automation guard');
    const [base] = await q(`select coalesce(max(id),0)::bigint mx from automation_events`);
    log(`  automation_events baseline id: ${base.mx}`);

    // ---------------------------------------------------------------- 1. the damage
    hr('1. what the accidental UPDATE actually changed');
    const ids = (await q(`select array_agg(id) a from v2_leads where form_id = $1`, [K.V2.form]))[0].a;
    log(`  form ${K.V2.form} rows: ${ids.length}`);

    const evs = await q(`
      select row_id::bigint id,
             (before_data->>'lead_stage_id') old_stage,
             (after_data ->>'lead_stage_id') new_stage,
             (before_data->>'lead_stage_date') old_date,
             created_at
        from automation_events
       where table_name = 'v2_leads' and row_id = any($1::bigint[])
         and changed_fields @> ARRAY['lead_stage_id']::text[]
         and created_at > now() - interval '${WINDOW}'
       order by row_id`, [ids]);
    const dupes = evs.length - new Set(evs.map(e => String(e.id))).size;
    dupes === 0 ? ok(`${evs.length} stage event(s) in the window, one per lead`)
                : no(`${dupes} lead(s) have more than one stage event - the window is ambiguous`);

    const allTo132 = evs.every(e => String(e.new_stage) === String(BAD_STAGE));
    allTo132 ? ok(`every one of those events ends at stage ${BAD_STAGE} - consistent with the one statement`)
             : no('some events in the window did NOT end at 132 - another change is mixed in');

    const wasNull = evs.filter(e => e.old_stage === null);
    const wasReal = evs.filter(e => e.old_stage !== null);
    log(`  of those: ${wasNull.length} were NULL (the intended fill), ${wasReal.length} held a REAL stage (the damage)`);

    const names = new Map((await q(`select id, "stageName" n from "leadStage" where id = any($1::int[])`,
      [[...new Set(wasReal.map(e => Number(e.old_stage)))]])).map(r => [String(r.id), r.n]));
    const byStage = {};
    for (const e of wasReal) byStage[e.old_stage] = (byStage[e.old_stage] || 0) + 1;
    for (const [s, n] of Object.entries(byStage).sort((a, b) => b[1] - a[1])) {
      log(`    stage ${s} "${names.get(s) || '?'}": ${n} lead(s)`);
    }

    // ---------------------------------------------------------------- 2. second source
    hr('2. cross-check against our own export (v1-derived)');
    const exp = new Map(fs.readFileSync(EXPORT, 'utf8').trim().split('\n')
      .map(l => JSON.parse(l)).map(r => [Number(r.v1_lead_id), r.lead_stage_id ?? null]));
    const liveRows = await q(`select id, v1_lead_id, lead_stage_id from v2_leads
       where id = any($1::bigint[])`, [wasReal.map(e => Number(e.id))]);
    const v1by = new Map(liveRows.map(r => [String(r.id), r]));

    const plan = [], disagree = [], moved = [];
    for (const e of wasReal) {
      const row = v1by.get(String(e.id));
      if (!row) { disagree.push({ ...e, why: 'no live v2 row' }); continue; }
      const fromExport = exp.get(Number(row.v1_lead_id));
      if (String(fromExport) !== String(e.old_stage)) {
        disagree.push({ ...e, why: `export says ${fromExport}, trigger says ${e.old_stage}` });
        continue;
      }
      if (Number(row.lead_stage_id) !== BAD_STAGE) { moved.push({ ...e, cur: row.lead_stage_id }); continue; }
      plan.push({ id: Number(e.id), stage: Number(e.old_stage) });
    }
    disagree.length === 0
      ? ok(`both sources agree on all ${wasReal.length} damaged lead(s) - and that proves no counsellor had changed a stage in v2 since the migration`)
      : no(`${disagree.length} lead(s) where the two sources DISAGREE:\n` +
           disagree.slice(0, 10).map(d => `        ${d.id}: ${d.why}`).join('\n'));
    if (moved.length) log(`  NOTE ${moved.length} lead(s) no longer read ${BAD_STAGE} (someone set a stage since) - skipped, left as they are`);
    if (disagree.length) throw new Error('refusing to restore from sources that disagree');

    // ---------------------------------------------------------------- 3. plan
    hr('3. plan');
    log(`  restore ${plan.length} lead(s) from stage ${BAD_STAGE} back to the stage they held:`);
    for (const p of plan.slice(0, 12)) log(`    ${p.id} -> ${p.stage} "${names.get(String(p.stage))}"`);
    if (plan.length > 12) log(`    ... and ${plan.length - 12} more`);
    log(`\n  LEFT ALONE on purpose: the ${wasNull.length} lead(s) that were NULL stay at ${BAD_STAGE} "Untouched",`);
    log(`  because that is what you wanted the statement to do.`);
    if (REVERT_NULLS) log(`  --also-revert-nulls given: those ${wasNull.length} will instead go back to NULL.`);
    log(`  lead_stage_date is not written - it was never changed, so the rows end up exactly as before.`);

    const nullIds = wasNull.map(e => Number(e.id));
    if (!plan.length && !(REVERT_NULLS && nullIds.length)) { ok('nothing to do'); throw { done: true }; }

    // ---------------------------------------------------------------- 4. write
    hr(APPLY ? '4. apply' : '4. dry run (everything below is rolled back)');
    const touched = plan.map(p => p.id).concat(REVERT_NULLS ? nullIds : []);
    await v2.query('begin');
    const before = await q(`select id, to_jsonb(l) j from v2_leads l
       where id = any($1::bigint[]) order by id for update`, [touched]);
    ok(`${before.length} row(s) locked with FOR UPDATE`);

    let n1 = 0, n2 = 0;
    if (plan.length) {
      const r = await v2.query(`
        update v2_leads t set lead_stage_id = v.stage
          from jsonb_to_recordset($1::jsonb) as v(id bigint, stage int)
         where t.id = v.id and t.lead_stage_id = $2`, [JSON.stringify(plan), BAD_STAGE]);
      n1 = r.rowCount;
      n1 === plan.length ? ok(`restored ${n1} lead(s) to their original stage`)
                         : no(`restored ${n1}, expected ${plan.length}`);
    }
    if (REVERT_NULLS && nullIds.length) {
      const r = await v2.query(`update v2_leads set lead_stage_id = null
         where id = any($1::bigint[]) and lead_stage_id = $2`, [nullIds, BAD_STAGE]);
      n2 = r.rowCount;
      n2 === nullIds.length ? ok(`reverted ${n2} lead(s) to NULL`) : no(`reverted ${n2}, expected ${nullIds.length}`);
    }

    const after = await q(`select id, to_jsonb(l) j from v2_leads l where id = any($1::bigint[]) order by id`, [touched]);
    const bby = new Map(before.map(r => [String(r.id), r.j]));
    const want = new Map(plan.map(p => [String(p.id), p.stage]));
    let drift = 0, good = 0;
    for (const r of after) {
      const b = bby.get(String(r.id)), a = r.j;
      for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
        if (JSON.stringify(b[k]) === JSON.stringify(a[k])) continue;
        if (k === 'lead_stage_id') {
          const expect = want.has(String(r.id)) ? want.get(String(r.id)) : null;
          if (String(a[k] ?? null) === String(expect ?? null)) { good++; continue; }
        }
        drift++; log(`  DRIFT lead ${r.id}: ${k} ${JSON.stringify(b[k])} -> ${JSON.stringify(a[k])}`);
      }
    }
    good === touched.length ? ok(`all ${good} row(s) now hold the stage we planned`)
                            : no(`${good} row(s) changed, expected ${touched.length}`);
    drift === 0 ? ok('whole-row proof: no other column moved - lead_stage_date and updated_at included')
                : no(`${drift} unplanned column change(s)`);

    const [mine] = await q(`select count(*)::int n from automation_events
       where xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text`);
    mine.n === 0 ? ok('automation_events: this transaction wrote 0 event(s)')
                 : no(`this transaction wrote ${mine.n} event(s) - NOT committing`);

    if (fail) { await v2.query('rollback'); throw new Error(`${fail} check(s) failed - rolled back, nothing written`); }

    if (!APPLY) {
      await v2.query('rollback');
      log('\n  DRY RUN: rolled back. Nothing in the database changed.');
    } else {
      fs.mkdirSync(RUNDIR, { recursive: true });
      fs.writeFileSync(path.join(RUNDIR, 'stage_restore_undo.sql'),
        ['-- Undo for the K12 lead_stage_id restore, run ' + RUN_TS,
          `-- Puts every row back to ${BAD_STAGE}, i.e. re-creates the accident. Here for completeness.`,
          'BEGIN;', "SET app.skip_automation = 'true';",
          `UPDATE v2_leads SET lead_stage_id = ${BAD_STAGE} WHERE id IN (${touched.join(', ')});`,
          'COMMIT;'].join('\n') + '\n');
      fs.writeFileSync(path.join(RUNDIR, 'stage_restored.csv'),
        ['v2_lead_id,stage_before_accident,stage_after_accident,stage_now,stage_name']
          .concat(plan.map(p => `${p.id},${p.stage},${BAD_STAGE},${p.stage},"${names.get(String(p.stage)) || ''}"`))
          .concat(REVERT_NULLS ? nullIds.map(i => `${i},NULL,${BAD_STAGE},NULL,`) : [])
          .join('\n') + '\n');
      await v2.query('commit');
      log('\n  COMMITTED.');

      const [g2] = await q(`select current_setting('app.skip_automation', true) v`);
      g2.v === 'true' ? ok('app.skip_automation still "true" after COMMIT') : no('the guard was lost');

      const post = await q(`select lead_stage_id, count(*)::int n from v2_leads
         where form_id = $1 group by 1 order by 2 desc`, [K.V2.form]);
      log('  form 128 now reads:');
      for (const r of post) log(`    stage ${r.lead_stage_id ?? 'NULL'} "${names.get(String(r.lead_stage_id)) || ''}": ${r.n}`);

      const [ev2] = await q(`select count(*)::int n from automation_events
         where id > $1 and table_name = 'v2_leads' and row_id = any($2::bigint[])`, [base.mx, touched]);
      ev2.n === 0 ? ok('after COMMIT: 0 automation_events for the restored leads - no email, no whatsapp')
                  : no(`after COMMIT: ${ev2.n} automation_event(s)`);

      log(`\n  undo + csv written to ${RUNDIR}`);
    }
  } catch (e) {
    if (!e || !e.done) {
      try { await v2.query('rollback'); } catch {}
      log('\nERROR ' + (e && e.message ? e.message : String(e)));
      hr(`${pass} passed, ${fail} failed - NOTHING WAS COMMITTED`);
      await v2.end().catch(() => {});
      process.exit(1);
    }
  }

  hr(fail === 0 ? `ALL CHECKS PASSED  (${pass} passed, 0 failed)` : `${pass} passed, ${fail} FAILED`);
  await v2.end();
  process.exit(fail === 0 ? 0 : 1);
})();
