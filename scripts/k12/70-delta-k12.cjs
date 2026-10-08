/**
 * K12 DELTA / RE-SYNC - for leads that are ALREADY in v2.
 *
 *   node scripts/k12/70-delta-k12.cjs                  # DRY RUN (default)
 *   node scripts/k12/70-delta-k12.cjs --apply           # commits, batch by batch
 *   node scripts/k12/70-delta-k12.cjs --run <exportId>  # pick an export folder (default: newest)
 *   node scripts/k12/70-delta-k12.cjs --restart         # ignore the checkpoint
 *
 * WHY THIS EXISTS
 *   60-import-k12.cjs is insert-only. Run it again and it picks up leads that are new in v1,
 *   and satellites (notes, timelines, tags, tracker, score rows) that are new on any lead -
 *   but it will never change a column on a lead that is already in v2. That is deliberate:
 *   an insert cannot damage anything.
 *   This script is the other half: a lead that was migrated and has since been EDITED in v1.
 *
 * THE RULES (the user's, from 2026-09-22, enforced by scripts/lib/repair-rules.cjs - the
 * same module that ran the UG repair)
 *   1. A value in v2 never becomes blank because v1 is blank.
 *   2. v2 is the source of truth for CONTENT: a column that already holds something in v2 is
 *      NOT overwritten with a different v1 value. It goes to delta_review.csv instead, so a
 *      human decides.
 *   3. PROGRESS moves forward only: a false->true flag, a higher score, a later date.
 *   Enforced four times over: when planning, by an assertion over the plan, a third time
 *   inside the SQL itself (CASE WHEN ...), and a fourth by re-reading every row afterwards
 *   and refusing to commit if any column changed that was not planned.
 *
 * SAFETY
 *   - `app.skip_automation = 'true'` at SESSION level, verified before any write and
 *     re-verified after every commit. An UPDATE on v2_leads fires the same trigger an INSERT
 *     does, so the guard matters exactly as much here.
 *   - automation_events is checked INSIDE each transaction, before it commits, by transaction
 *     id: an event this transaction wrote aborts the batch. Events the live CRM writes
 *     meanwhile have a different xmin and are only reported.
 *   - Batches of 200 leads. Each is its own short transaction: rows are locked, read, written
 *     with ONE set-based statement and released. The CRM never waits on this script.
 *   - `updated_at` is never written, so a later audit can still tell an app edit (which
 *     always stamps updated_at) from one of ours.
 *   - Every committed change goes to delta_undo.sql with its OLD value, as a literal.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connect, armAutomationGuard } = require('../lib/db.cjs');
const { Progress } = require('../lib/progress.cjs');
const R = require('../lib/repair-rules.cjs');
const K = require('./lib-k12.cjs');

const REPOS = 'C:/Users/Prateek/Desktop/Repos';
const ROOT = path.join(REPOS, 'data', 'k12');
const BATCH = 200;
const LEAD_TABLE = 'v2_leads_k12';            // the class set in lib-k12, registered with the rules engine

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const RESTART = args.includes('--restart');
const runArg = args.includes('--run') ? args[args.indexOf('--run') + 1] : null;

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(84) + '\n' + t + '\n' + '='.repeat(84));
const readNd = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const norm = v => (v instanceof Date ? v.toISOString() : v);
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const lit = v => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return "'" + v.toISOString() + "'";
  if (typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::json";
  return "'" + String(v).replace(/'/g, "''") + "'";
};
const csvCell = v => '"' + String(v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v)).replace(/"/g, '""') + '"';

/**
 * lead_payload is MERGED, never replaced: a key v2 already holds keeps its value, and only
 * missing keys are added - and inside formFields / __legacy / __v1_answers, only missing
 * subkeys. That is what carries "School & City" onto a lead that is already in v2.
 * Returns null when there is nothing to add. Throws rather than change an existing value.
 */
function mergePayload(live, want) {
  if (!want || typeof want !== 'object' || Array.isArray(want)) return null;
  const base = (live && typeof live === 'object' && !Array.isArray(live)) ? live : {};
  const out = { ...base };
  let added = 0;
  for (const key of ['formFields', '__legacy', '__v1_answers']) {
    const w = want[key];
    if (w === undefined || w === null || typeof w !== 'object' || Array.isArray(w)) continue;
    const cur = out[key];
    if (cur === undefined || cur === null) { out[key] = { ...w }; added += Object.keys(w).length; continue; }
    if (typeof cur !== 'object' || Array.isArray(cur)) continue;          // leave anything odd alone
    const merged = { ...cur };
    for (const [k, v] of Object.entries(w)) {
      if (merged[k] === undefined || merged[k] === null || merged[k] === '') { merged[k] = v; added += 1; }
    }
    out[key] = merged;
  }
  if (!added) return null;
  const walk = (a, b, where) => {
    for (const [k, v] of Object.entries(a)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && b[k] && typeof b[k] === 'object') { walk(v, b[k], where + '.' + k); continue; }
      if (JSON.stringify(b[k]) !== JSON.stringify(v)) throw new Error('payload merge would change ' + where + '.' + k + ' - refused');
    }
  };
  walk(base, out, 'lead_payload');
  return out;
}

(async () => {
  if (!fs.existsSync(ROOT)) throw new Error(`no export folder at ${ROOT} - run the export first`);
  const runs = fs.readdirSync(ROOT).filter(d => fs.statSync(path.join(ROOT, d)).isDirectory()).sort();
  const runId = runArg || runs[runs.length - 1];
  if (!runId || !runs.includes(runId)) throw new Error(`export run "${runId}" not found. available: ${runs.join(', ')}`);
  const DIR = path.join(ROOT, runId);

  hr(`K12 DELTA   ${APPLY ? '*** APPLY - this COMMITS ***' : 'DRY RUN (everything is rolled back)'}`);
  log(`  export run : ${DIR}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  for (const [name, meta] of Object.entries(manifest.files)) {
    const f = path.join(DIR, name);
    if (!fs.existsSync(f)) throw new Error(`export file missing: ${name}`);
    if (sha256(f) !== meta.sha256) throw new Error(`checksum mismatch on ${name} - refusing to run`);
  }
  log(`  exported   : ${manifest.generatedAt}   checksums: all ${Object.keys(manifest.files).length} files verified`);

  // Which rows this run may touch. Taken from the export's own manifest - which the export
  // wrote only after asserting it against LIVE v2 - and then checked here to be the K12
  // scope, so a file from another migration cannot be applied by accident.
  const SCOPE = (manifest.scope && manifest.scope.v2) || K.V2;
  if (!manifest.selftest) {
    for (const k of ['org', 'school', 'program', 'form', 'batch', 'round']) {
      if (Number(SCOPE[k]) !== Number(K.V2[k])) throw new Error(`this export is scoped to v2 ${k} ${SCOPE[k]}, not K12's ${K.V2[k]} - refusing`);
    }
  } else log('  *** SELF-TEST manifest: the scope comes from the file ***');
  log(`  scope      : v2 org ${SCOPE.org} / school ${SCOPE.school} / program ${SCOPE.program} / form ${SCOPE.form}`);

  const deltaLeads = readNd(path.join(DIR, 'delta_leads.ndjson'));
  const deltaUg = readNd(path.join(DIR, 'delta_under_graduate.ndjson'));
  log(`  already in v2: ${deltaLeads.length} lead(s), ${deltaUg.length} form row(s)`);
  if (!deltaLeads.length) {
    log('\n  Nothing to do: every live K12 lead in this export is new, so 60-import-k12.cjs covers all of it.');
    return;
  }
  if (!K.DELTA_CLASSES) throw new Error('lib-k12.cjs has no DELTA_CLASSES');
  R.CLASSES[LEAD_TABLE] = K.DELTA_CLASSES;
  const CLASS_COLS = Object.values(K.DELTA_CLASSES).flat();

  const RUN_TS = new Date().toISOString().replace(/[:.]/g, '-');
  const RUNDIR = path.join(DIR, 'runs', 'delta-' + RUN_TS);
  fs.mkdirSync(RUNDIR, { recursive: true });

  const CKPT = path.join(DIR, 'delta-checkpoint.json');
  let ckpt = { exportRun: runId, manifestSha: sha256(path.join(DIR, 'manifest.json')), done: [] };
  if (fs.existsSync(CKPT) && !RESTART) {
    const onDisk = JSON.parse(fs.readFileSync(CKPT, 'utf8'));
    if (onDisk.manifestSha !== ckpt.manifestSha) log('  checkpoint: found one for a DIFFERENT export payload - ignoring it');
    else { ckpt = onDisk; log(`  checkpoint: ${ckpt.done.length} batch(es) already committed - they will be SKIPPED`); }
  } else if (RESTART && fs.existsSync(CKPT)) log('  checkpoint: --restart given, ignoring it');

  const v2 = await connect('v2', { readOnly: false });
  const undo = [];
  const review = [];
  const writtenCols = new Map();
  let changedLeads = 0, changedUg = 0, insertedUg = 0, otherEvents = 0, proofs = 0;

  const flushUndo = () => {
    if (!APPLY) return;
    fs.writeFileSync(path.join(RUNDIR, 'delta_undo.sql'),
      ['-- Undo for the K12 delta run ' + RUN_TS,
        '-- Each statement restores ONE column to the value it held before this run.',
        '-- Review before running. app.skip_automation must be set first.',
        'BEGIN;', "SET app.skip_automation = 'true';", ...undo, 'COMMIT;'].join('\n') + '\n');
  };
  const flushReview = () => {
    fs.writeFileSync(path.join(RUNDIR, 'delta_review.csv'),
      ['v1_lead_id,v2_lead_id,column,value_in_v1,value_in_v2,decision']
        .concat(review.map(r => [r.v1, r.v2, r.col, csvCell(r.v1val), csvCell(r.v2val), csvCell(r.why)].join(','))).join('\n') + '\n');
  };
  const typesOf = async table => {
    const { rows } = await v2.query(`select attname, format_type(atttypid, atttypmod) t from pg_attribute
      where attrelid = $1::regclass and attnum > 0 and not attisdropped`, [table]);
    return new Map(rows.map(r => [r.attname, r.t]));
  };

  try {
    // ---------------------------------------------------------------- 0. guard + schema
    hr('0. automation guard and schema check');
    await armAutomationGuard(v2);
    const { rows: [g] } = await v2.query(`select current_setting('app.skip_automation', true) as v`);
    if (g.v !== 'true') throw new Error('could not arm the automation guard');
    const { rows: [base] } = await v2.query('select coalesce(max(id), 0)::bigint mx from automation_events');
    log(`  app.skip_automation = "${g.v}" (verified)   automation_events baseline id ${base.mx}`);

    const leadTypes = await typesOf('v2_leads');
    const ugTypes = await typesOf('under_graduate');
    const missing = CLASS_COLS.filter(c => !leadTypes.has(c));
    if (missing.length) throw new Error('v2_leads has no column ' + missing.join(', ') + ' - fix DELTA_CLASSES in lib-k12.cjs');
    log(`  ${CLASS_COLS.length} v2_leads column(s) in the rule set, all present`);
    log(`  under_graduate: every column is FILL (written only into an empty one), ${ugTypes.size} column(s) available`);
    if (!APPLY) await v2.query('begin');

    // ---------------------------------------------------------------- 1. the leads
    hr(`1. leads already in v2 (${deltaLeads.length}), in batches of ${BATCH}`);
    const ugByV1 = new Map(deltaUg.map(r => [r.v1_lead_id, r]));
    const batches = [];
    for (let i = 0; i < deltaLeads.length; i += BATCH) batches.push(deltaLeads.slice(i, i + BATCH));
    const p = new Progress(deltaLeads.length || 1, 'delta');

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      if (APPLY && ckpt.done.includes(bi)) { p.tick(batch.length); continue; }
      if (APPLY) await v2.query('begin');
      const undoMark = undo.length;
      try {
        const ids = batch.map(r => Number(r.v2_lead_id));
        // Lock and read the LIVE rows. Everything is planned against what v2 holds right
        // now, not against what the export saw, so an edit made in the CRM since the export
        // still wins.
        const { rows: live } = await v2.query(
          `select * from v2_leads where id = any($1::bigint[]) and is_deleted = false order by id for update`, [ids]);
        const liveById = new Map(live.map(r => [Number(r.id), r]));
        const { rows: ugLiveRows } = await v2.query(
          `select * from under_graduate where lead_id = any($1::bigint[]) order by id for update`, [ids]);
        const ugById = new Map(ugLiveRows.map(r => [Number(r.lead_id), r]));

        const writes = [], ugWrites = [], ugInserts = [];
        for (const want of batch) {
          const row = liveById.get(Number(want.v2_lead_id));
          if (!row) { review.push({ v1: want.v1_lead_id, v2: want.v2_lead_id, col: '-', v1val: '', v2val: '', why: 'the v2 lead is gone or deleted - skipped' }); continue; }
          if (Number(row.form_id) !== Number(SCOPE.form) || Number(row.school_id) !== Number(SCOPE.school)) {
            review.push({ v1: want.v1_lead_id, v2: want.v2_lead_id, col: 'form_id', v1val: SCOPE.form, v2val: row.form_id, why: 'the v2 lead has moved to another form/school - skipped' });
            continue;
          }

          const proposed = {};
          for (const c of CLASS_COLS) if (want[c] !== undefined) proposed[c] = want[c];
          const set = R.plan(LEAD_TABLE, row, proposed);
          R.assertAllowed(`lead ${want.v1_lead_id}`, LEAD_TABLE, row, set);

          // every disagreement we are deliberately NOT writing, for a human to look at
          for (const c of K.DELTA_REVIEW) {
            const a = want[c], b = row[c];
            if (R.isEmpty(a) || R.isEmpty(b) || String(a) === String(b)) continue;
            review.push({ v1: want.v1_lead_id, v2: want.v2_lead_id, col: c, v1val: a, v2val: b, why: 'v2 already has a different value - left alone (rule 2)' });
          }

          const payload = mergePayload(row.lead_payload, want.lead_payload);
          if (Object.keys(set).length || payload) writes.push({ want, live: row, set, payload });

          // the form table: FILL only, exactly like Stream G
          const ugWant = ugByV1.get(want.v1_lead_id);
          if (!ugWant) continue;
          const ugRow = ugById.get(Number(want.v2_lead_id));
          const candidate = {};
          for (const [c, v] of Object.entries(ugWant)) {
            if (['org_id', 'v1_lead_id', 'v2_lead_id', 'lead_id', 'created_at', 'updated_at', 'id'].includes(c)) continue;
            if (ugTypes.has(c)) candidate[c] = v;
          }
          if (!ugRow) {
            const cs = Object.keys(candidate).filter(c => !R.isEmpty(candidate[c]));
            if (cs.length) ugInserts.push({ want, cs, candidate, ugWant });
          } else {
            const ugSet = R.plan('under_graduate', ugRow, candidate);
            R.assertAllowed(`under_graduate for lead ${want.v1_lead_id}`, 'under_graduate', ugRow, ugSet);
            if (Object.keys(ugSet).length) ugWrites.push({ want, live: ugRow, set: ugSet });
          }
        }

        // ---------------- ONE guarded, set-based UPDATE per table, then a whole-row proof
        const applySet = async (table, types, list, allowPayload) => {
          if (!list.length) return 0;
          const cols = [...new Set(list.flatMap(w => Object.keys(w.set)))];
          for (const c of cols) if (!types.has(c)) throw new Error(`${table}.${c} does not exist`);
          const withPayload = allowPayload && list.some(w => w.payload);
          const recCols = [...cols, ...(withPayload ? ['lead_payload'] : [])];
          const rows = list.map(w => Object.fromEntries([
            ['id', Number(w.live.id)],
            ...cols.map(c => [c, c in w.set ? w.set[c] : null]),
            ...(withPayload ? [['lead_payload', w.payload || null]] : []),
          ]));
          const sets = cols.map(c => `"${c}" = ${R.guardExpr(table, c, `t."${c}"`, `v."${c}"`)}`);
          // lead_payload is the one column that is MERGED rather than guarded - the merge was
          // computed from the row this transaction has locked, and asserted not to change any
          // key that was already there.
          if (withPayload) sets.push('"lead_payload" = COALESCE(v."lead_payload", t."lead_payload")');
          const sql = `UPDATE ${table} AS t SET ${sets.join(', ')}`
            + ` FROM jsonb_to_recordset($1::jsonb) AS v(id ${types.get('id')}, ${recCols.map(c => `"${c}" ${types.get(c)}`).join(', ')})`
            + ' WHERE t.id = v.id';
          const res = await v2.query(sql, [JSON.stringify(rows)]).catch(err => {
            throw new Error(err.message + ' | SQL: ' + sql);
          });
          if (res.rowCount !== list.length) throw new Error(`${table}: updated ${res.rowCount} row(s), expected ${list.length} - rolled back`);

          // 4th enforcement: re-read and refuse anything that was not planned
          const { rows: after } = await v2.query(`select * from ${table} where id = any($1::bigint[])`, [list.map(w => Number(w.live.id))]);
          const afterBy = new Map(after.map(r => [Number(r.id), r]));
          let n = 0;
          const label = c => (table === 'v2_leads' ? c : table + '.' + c);
          for (const w of list) {
            const a = afterBy.get(Number(w.live.id));
            const planned = Object.keys(w.set);
            for (const c of Object.keys(w.live)) {
              if (planned.includes(c) || (c === 'lead_payload' && w.payload)) continue;
              if (!same(w.live[c], a[c])) throw new Error(`${table} ${w.live.id}: ${c} changed without being planned - rolled back`);
            }
            for (const c of Object.keys(w.live)) {
              if (!R.isEmpty(w.live[c]) && R.isEmpty(a[c])) throw new Error(`${table} ${w.live.id}: ${c} went BLANK - rolled back`);
            }
            proofs += 1;
            n += 1;
            for (const c of planned) {
              writtenCols.set(label(c), (writtenCols.get(label(c)) || 0) + 1);
              undo.push(`UPDATE ${table} SET "${c}" = ${lit(w.live[c])} WHERE id = ${Number(w.live.id)};`);
            }
            if (w.payload) {
              writtenCols.set('lead_payload (merged)', (writtenCols.get('lead_payload (merged)') || 0) + 1);
              undo.push(`UPDATE ${table} SET "lead_payload" = ${lit(w.live.lead_payload)} WHERE id = ${Number(w.live.id)};`);
            }
          }
          return n;
        };
        changedLeads += await applySet('v2_leads', leadTypes, writes, true);
        changedUg += await applySet('under_graduate', ugTypes, ugWrites, false);

        for (const ins of ugInserts) {
          const r = await v2.query(
            `insert into under_graduate (org_id, lead_id, v1_lead_id, created_at, updated_at, ${ins.cs.map(c => `"${c}"`).join(',')})
             values ($1,$2,$3,$4,$5,${ins.cs.map((_, i) => '$' + (i + 6)).join(',')})
             on conflict (v1_lead_id) where v1_lead_id is not null do nothing returning id`,
            [SCOPE.org, Number(ins.want.v2_lead_id), ins.want.v1_lead_id, ins.ugWant.created_at, ins.ugWant.updated_at,
              ...ins.cs.map(c => ins.candidate[c])]);
          if (r.rows.length) {
            insertedUg += 1;
            writtenCols.set('under_graduate (new row)', (writtenCols.get('under_graduate (new row)') || 0) + 1);
            undo.push(`DELETE FROM under_graduate WHERE id = ${r.rows[0].id};`);
          }
        }

        // Did WE wake the workflow engine? Checked before this batch commits. An event with
        // our transaction id aborts the run; one from the live CRM has a different xmin.
        const { rows: [ev] } = await v2.query(
          `select count(*) filter (where xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text)::int ours,
                  count(*) filter (where xmin::text <> (pg_current_xact_id()::text::bigint % 4294967296)::text)::int others
             from automation_events where id > $1 and table_name = 'v2_leads' and row_id = any($2::bigint[])`,
          [base.mx, ids]);
        if (ev.ours > 0) throw new Error(`${ev.ours} automation_events row(s) were emitted by THIS transaction - STOPPING. Read incident_2026-08-18_automation_emails/README.md`);
        otherEvents += ev.others;

        if (APPLY) {
          await v2.query('commit');
          ckpt.done.push(bi);
          fs.writeFileSync(CKPT, JSON.stringify(ckpt, null, 2));
          flushUndo();
          const { rows: [gg] } = await v2.query(`select current_setting('app.skip_automation', true) as v`);
          if (gg.v !== 'true') throw new Error('app.skip_automation is no longer true - aborting');
        }
      } catch (e) {
        if (APPLY) { await v2.query('rollback').catch(() => {}); undo.length = undoMark; flushUndo(); }
        log(`\n  batch ${bi + 1}/${batches.length} failed: ${e.message}`);
        if (APPLY) log(`  ${ckpt.done.length} batch(es) are committed; re-running resumes from batch ${ckpt.done.length + 1}.`);
        throw e;
      }
      p.tick(batch.length);
    }
    p.done();

    // ---------------------------------------------------------------- 2. what happened
    hr('2. what this run changed');
    log(`  leads written          ${changedLeads} of ${deltaLeads.length}`);
    log(`  form rows written      ${changedUg}   new form rows ${insertedUg}`);
    if (writtenCols.size) {
      log('  by column:');
      [...writtenCols.entries()].sort((a, b) => b[1] - a[1]).forEach(([c, n]) => log(`    ${c.padEnd(32)} ${String(n).padStart(6)}`));
    } else log('  nothing needed changing - v2 is already at least as complete as v1');
    log(`  rows re-read and proved untouched beyond the plan: ${proofs}`);
    log(`  left alone for review  ${review.length}  (rule 2: v2 already had a different value)`);
    log(`  automation_events from the rest of the CRM while we ran: ${otherEvents} (not ours)`);
    flushReview();
    log(`  review CSV             ${path.join(RUNDIR, 'delta_review.csv')}`);

    if (!APPLY) {
      await v2.query('rollback');
      hr('DRY RUN COMPLETE - rolled back');
      log('  Nothing was changed. Re-run with --apply to commit.');
    } else {
      flushUndo();
      fs.writeFileSync(path.join(RUNDIR, 'summary.json'), JSON.stringify(
        { runId, at: new Date().toISOString(), changedLeads, changedUg, insertedUg, review: review.length,
          byColumn: Object.fromEntries(writtenCols) }, null, 2));
      hr('K12 DELTA COMPLETE (COMMITTED)');
      log(`  artefacts: ${RUNDIR}  (delta_undo.sql, delta_review.csv, summary.json)`);
    }
  } finally {
    await v2.query('rollback').catch(() => {});
    await v2.end();
  }
})().catch(e => { console.error('DELTA FAILED:', e.message); process.exit(1); });
