/**
 * K12: set lead_score = 0 where the migration faithfully carried a NULL from v1.
 *
 * WHY THIS EXISTS
 *   v1's "manageLeads"."leadScore" is NULL for 28 of the 7,488 migrated K12 leads, and the
 *   import copied it as-is. v2's own convention is 0, not NULL: V2Lead.leadScore carries
 *   `defaultValue: 0` in the model (new_crm_backend/src/models/V2Lead.js:384) while the
 *   column itself has no DB default, so every lead the v2 app creates gets 0 and only a raw
 *   insert can leave a NULL. The tester is right - these rows should read 0.
 *   This is a convention correction, not a lost value: nothing in v1 was dropped.
 *
 * SCOPE - deliberately narrow
 *   v2_leads WHERE form_id = 128 AND v1_lead_id IS NOT NULL AND lead_score IS NULL
 *   i.e. only leads THIS migration created. Native v2 K12 rows and the other school-18
 *   forms are left alone even where they are also NULL - they are not ours to change.
 *
 * SAFETY
 *   - `app.skip_automation = 'true'` at SESSION level, read back before any write and
 *     re-verified after the commit (incident_2026-08-18_automation_emails). Belt and braces:
 *     the live emit_automation_event() already returns early when the changed-column set is
 *     within ARRAY['lead_score','updated_at'], verified at run time by step 0.
 *   - v1 is re-read and the run REFUSES if any candidate has a non-NULL score in v1. Such a
 *     row would be a real migration miss needing its true value, not a blanket 0.
 *   - The UPDATE carries `WHERE lead_score IS NULL` in the statement itself, so it can never
 *     overwrite a score the CRM has since computed, even if the plan went stale.
 *   - `updated_at` is NOT written, so a later audit can still tell an app edit from ours.
 *   - Whole-row proof: every row is captured as jsonb before and after; if any key other than
 *     lead_score moved, the transaction rolls back.
 *   - One short transaction for 28 rows. No downtime, no long lock.
 *   - Every committed change is written to leadscore_undo.sql with its OLD value.
 *
 * USAGE
 *   node scripts/k12/80-fix-null-lead-score-k12.cjs            # dry run (default)
 *   node scripts/k12/80-fix-null-lead-score-k12.cjs --apply    # writes, then COMMITs
 */
const fs = require('fs');
const path = require('path');
const { connect, armAutomationGuard, REPOS } = require('../lib/db.cjs');
const K = require('../k12/lib-k12.cjs');

const APPLY = process.argv.includes('--apply');
const RUN_TS = new Date().toISOString().replace(/[:.]/g, '-');
const RUNDIR = path.join(REPOS, 'data', 'k12', 'leadscore-fix-' + RUN_TS);

const out = [];
const log = s => { out.push(s); console.log(s); };
const hr = t => log('\n' + '='.repeat(92) + '\n' + t + '\n' + '='.repeat(92));

let pass = 0, fail = 0;
const ok = m => { pass++; log('  PASS  ' + m); };
const no = m => { fail++; log('  FAIL  ' + m); };

(async () => {
  // Same as 70-delta: the dry run exercises the real write path inside a transaction and
  // then ROLLS BACK, so "dry run" proves the statement, the locks and the row-level proof
  // rather than just printing a plan. Nothing survives a dry run.
  const v1 = await connect('v1'), v2 = await connect('v2', { readOnly: false });
  const q1 = async (s, p) => (await v1.query(s, p)).rows;
  const q2 = async (s, p) => (await v2.query(s, p)).rows;

  log(`K12 lead_score NULL -> 0        mode: ${APPLY ? 'APPLY (will COMMIT)' : 'DRY RUN (rolls back)'}`);
  log(`run ${RUN_TS}`);

  try {
    // ------------------------------------------------------------------ 0. guards
    hr('0. automation guard');
    await armAutomationGuard(v2);
    const [g] = await q2(`select current_setting('app.skip_automation', true) v`);
    g.v === 'true' ? ok(`app.skip_automation = "${g.v}" (read back from the session)`)
                   : no('could not arm the automation guard');
    if (g.v !== 'true') throw new Error('refusing to continue without the automation guard');

    const [fn] = await q2(`select prosrc from pg_proc where proname = 'emit_automation_event'`);
    /v_changed\s*<@\s*ARRAY\['lead_score',\s*'updated_at'\]/.test(fn.prosrc)
      ? ok('the live trigger ALSO ignores an UPDATE confined to lead_score/updated_at')
      : log('  NOTE  the live trigger has no lead_score-only short circuit; the session guard is doing the work');

    const [base] = await q2(`select coalesce(max(id),0)::bigint mx from automation_events`);
    log(`  automation_events baseline id: ${base.mx}`);

    // ------------------------------------------------------------------ 1. the candidates
    hr('1. which rows qualify');
    const cand = await q2(`
      select id, v1_lead_id, registered_email, registered_mobile, registered_name, is_deleted
        from v2_leads
       where form_id = $1 and v1_lead_id is not null and lead_score is null
       order by id`, [K.V2.form]);
    const live = cand.filter(r => !r.is_deleted);
    log(`  v2 form ${K.V2.form}, migrated by us, lead_score IS NULL : ${cand.length} row(s)`);
    log(`    of those not deleted (what we will write)            : ${live.length}`);
    if (cand.length !== live.length) log(`    skipped because is_deleted = true                   : ${cand.length - live.length}`);

    const [spread] = await q2(`
      select count(*)::int total,
             count(*) filter (where lead_score is null)::int nulls,
             count(*) filter (where lead_score = 0)::int zeros,
             count(*) filter (where lead_score > 0)::int pos
        from v2_leads where form_id = $1 and is_deleted = false`, [K.V2.form]);
    log(`  context: form ${K.V2.form} holds ${spread.total} live leads - ${spread.nulls} NULL, ${spread.zeros} at 0, ${spread.pos} above 0`);

    if (!live.length) { ok('nothing to do - no migrated K12 lead has a NULL lead_score'); throw { done: true }; }

    // ------------------------------------------------------------------ 2. v1 agrees it was NULL
    hr('2. cross-check v1 - was the score really absent there?');
    const v1ids = live.map(r => Number(r.v1_lead_id));
    const v1rows = await q1(`select id, "leadScore" from "manageLeads" where id = any($1::int[])`, [v1ids]);
    const v1by = new Map(v1rows.map(r => [Number(r.id), r.leadScore]));
    const absent = v1ids.filter(id => v1by.has(id) && v1by.get(id) === null);
    const present = v1ids.filter(id => v1by.has(id) && v1by.get(id) !== null);
    const gone = v1ids.filter(id => !v1by.has(id));
    absent.length === v1ids.length
      ? ok(`all ${absent.length} have "leadScore" IS NULL in v1 too - the migration copied them faithfully`)
      : no(`${present.length} candidate(s) DO have a score in v1: ` +
           present.slice(0, 10).map(id => `${id}=${v1by.get(id)}`).join(', '));
    if (gone.length) no(`${gone.length} candidate(s) have no v1 row any more: ${gone.slice(0, 10).join(', ')}`);
    if (present.length || gone.length) {
      throw new Error('refusing to write 0 over a row whose true v1 value is not NULL - fix those individually');
    }

    // ------------------------------------------------------------------ 3. the plan
    hr('3. plan');
    log('  id         v1 lead   v2 score -> new   who');
    for (const r of live) {
      log(`  ${String(r.id).padEnd(10)} ${String(r.v1_lead_id).padEnd(9)} NULL     -> 0     ` +
        `${r.registered_email || 'na'} / ${r.registered_mobile || 'na'}`);
    }
    log(`\n  ONE statement: UPDATE v2_leads SET lead_score = 0 WHERE id = ANY($1) AND lead_score IS NULL`);
    log('  updated_at is not touched. No other column is named.');

    // ------------------------------------------------------------------ 4. write
    hr(APPLY ? '4. apply' : '4. dry run (everything below is rolled back)');
    const ids = live.map(r => Number(r.id));
    await v2.query('begin');

    const before = await q2(`select id, to_jsonb(l) j from v2_leads l where id = any($1::bigint[]) order by id for update`, [ids]);
    ok(`${before.length} row(s) locked with FOR UPDATE`);

    const res = await v2.query(
      `update v2_leads set lead_score = 0 where id = any($1::bigint[]) and lead_score is null`, [ids]);
    res.rowCount === ids.length ? ok(`UPDATE touched ${res.rowCount} row(s), exactly the plan`)
                                : no(`UPDATE touched ${res.rowCount} row(s), expected ${ids.length}`);

    const after = await q2(`select id, to_jsonb(l) j from v2_leads l where id = any($1::bigint[]) order by id`, [ids]);
    const bby = new Map(before.map(r => [String(r.id), r.j]));
    let drift = 0, scored = 0;
    for (const r of after) {
      const b = bby.get(String(r.id)), a = r.j;
      for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
        if (JSON.stringify(b[k]) === JSON.stringify(a[k])) continue;
        if (k === 'lead_score' && b[k] === null && Number(a[k]) === 0) { scored++; continue; }
        drift++; log(`  DRIFT lead ${r.id}: ${k} ${JSON.stringify(b[k])} -> ${JSON.stringify(a[k])}`);
      }
    }
    scored === ids.length ? ok(`every one of the ${scored} row(s) now reads lead_score = 0`)
                          : no(`${scored} row(s) changed, expected ${ids.length}`);
    drift === 0 ? ok('whole-row proof: not one other column moved, updated_at included')
                : no(`${drift} unplanned column change(s) - see DRIFT above`);

    const [mine] = await q2(`
      select count(*)::int n from automation_events
       where xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text`);
    mine.n === 0 ? ok('automation_events: this transaction wrote 0 event(s)')
                 : no(`automation_events: this transaction wrote ${mine.n} event(s) - NOT committing`);

    const [touch] = await q2(`
      select count(*)::int n from automation_events
       where id > $1 and table_name = 'v2_leads' and row_id = any($2::bigint[])`, [base.mx, ids]);
    touch.n === 0 ? ok('automation_events: no new event references any of our leads')
                  : no(`automation_events: ${touch.n} new event(s) reference our leads`);

    if (fail) { await v2.query('rollback'); throw new Error(`${fail} check(s) failed - rolled back, nothing written`); }

    if (!APPLY) {
      await v2.query('rollback');
      log('\n  DRY RUN: rolled back. Nothing in the database changed.');
    } else {
      fs.mkdirSync(RUNDIR, { recursive: true });
      fs.writeFileSync(path.join(RUNDIR, 'leadscore_undo.sql'),
        ['-- Undo for the K12 lead_score fix, run ' + RUN_TS,
          '-- Restores every row to the NULL it held before.',
          'BEGIN;', "SET app.skip_automation = 'true';",
          `UPDATE v2_leads SET lead_score = NULL WHERE id IN (${ids.join(', ')}) AND lead_score = 0;`,
          'COMMIT;'].join('\n') + '\n');
      fs.writeFileSync(path.join(RUNDIR, 'leadscore_changed.csv'),
        ['v2_lead_id,v1_lead_id,registered_email,registered_mobile,old_lead_score,new_lead_score']
          .concat(live.map(r => `${r.id},${r.v1_lead_id},${r.registered_email || ''},${r.registered_mobile || ''},NULL,0`))
          .join('\n') + '\n');
      await v2.query('commit');
      log('\n  COMMITTED.');

      const [g2] = await q2(`select current_setting('app.skip_automation', true) v`);
      g2.v === 'true' ? ok('app.skip_automation still "true" after COMMIT (session level, as intended)')
                      : no(`app.skip_automation is now ${JSON.stringify(g2.v)} - the guard was lost`);

      const [post] = await q2(`
        select count(*)::int total, count(*) filter (where lead_score is null)::int nulls
          from v2_leads where form_id = $1 and v1_lead_id is not null and is_deleted = false`, [K.V2.form]);
      post.nulls === 0 ? ok(`re-read: ${post.total} migrated K12 leads, 0 with a NULL lead_score`)
                       : no(`re-read: ${post.nulls} migrated K12 lead(s) still NULL`);

      const [ev] = await q2(`
        select count(*)::int n from automation_events
         where id > $1 and table_name = 'v2_leads' and row_id = any($2::bigint[])`, [base.mx, ids]);
      ev.n === 0 ? ok('after COMMIT: still 0 automation_events for our leads - no email, no whatsapp')
                 : no(`after COMMIT: ${ev.n} automation_event(s) reference our leads`);

      log(`\n  undo + csv written to ${RUNDIR}`);
    }
  } catch (e) {
    if (!e || !e.done) {
      try { await v2.query('rollback'); } catch {}
      log('\nERROR ' + (e && e.message ? e.message : String(e)));
      hr(`${pass} passed, ${fail} failed - NOTHING WAS COMMITTED`);
      await v1.end().catch(() => {}); await v2.end().catch(() => {});
      process.exit(1);
    }
  }

  hr(fail === 0 ? `ALL CHECKS PASSED  (${pass} passed, 0 failed)` : `${pass} passed, ${fail} FAILED`);
  await v1.end(); await v2.end();
  process.exit(fail === 0 ? 0 : 1);
})();
