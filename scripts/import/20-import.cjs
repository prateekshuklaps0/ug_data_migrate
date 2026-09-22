/**
 * STEP 2 of 2 - IMPORT.  The only script in this migration that writes.
 *
 *   node scripts/import/20-import.cjs              # DRY RUN (default) - rolls everything back
 *   node scripts/import/20-import.cjs --apply      # commits
 *   node scripts/import/20-import.cjs --run <id>   # pick an export folder (default: newest)
 *
 * Safety properties, in order of importance:
 *
 *  1. `SET app.skip_automation = 'true'` is issued at SESSION level on connect and
 *     VERIFIED to read back, before a single row is touched. Without it the
 *     AFTER INSERT OR UPDATE trigger on v2_leads writes to automation_events, wakes
 *     the workflow engine and sends real email/SMS/WhatsApp to real applicants.
 *     That is exactly what happened on 2026-08-18 (6,388 emails). The guard is
 *     re-verified after every COMMIT, because a lost connection would silently
 *     reset it.
 *  2. Every write is idempotent through a real unique index, so a re-run inserts
 *     nothing twice:
 *        users           ON CONFLICT (v1_id)
 *        v2_leads        ON CONFLICT (v1_lead_id)
 *        under_graduate  ON CONFLICT (v1_lead_id); the Stream F backfill also
 *                        skips any lead that already has a form row
 *        timelines       pre-filter on v1_timeline_id - its unique index is INVALID
 *                        because timelines_p202605 is detached from the parent
 *        notes           ON CONFLICT (v1_note_id)
 *        lead_tags       ON CONFLICT (v2_lead_id, tag_id)
 *        ApplicationActivityTrackers  ON CONFLICT (v1_leadId)
 *        leadScoreHistory ON CONFLICT (leadId, dedupeKey)
 *  3. The single UPDATE (the lead -> applicant promotion) is optimistic: it only
 *     fires if the row still looks the way the export saw it.
 *  4. Work is batched and, on --apply, each phase commits separately, so no long
 *     transaction holds locks on a table the live CRM is using. A dry run instead
 *     wraps every phase in ONE transaction and rolls it back, so the rehearsal is
 *     honest about ids that later phases depend on.
 *  5. automation_events is counted before and after; any increase is reported loudly.
 *  6. Every apply writes runs/<ts>/ with a backup of anything updated and a
 *     rollback.sql that undoes the run.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connect, armAutomationGuard } = require('../lib/db.cjs');
const { Progress } = require('../lib/progress.cjs');
const M = require('../lib/maps.cjs');
const { planGapFill, needsGapFill } = require('../lib/promotion.cjs');

const REPOS = 'C:/Users/Prateek/Desktop/Repos';
const EXPORT_ROOT = path.join(REPOS, 'data', 'export');
const BATCH = 500;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const runArg = args.includes('--run') ? args[args.indexOf('--run') + 1] : null;
const RESTART = args.includes('--restart');   // ignore any existing checkpoint

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78));
const readNd = f => fs.existsSync(f)
  ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** Build a multi-row INSERT with bound parameters only. */
function insertSql(table, cols, rowCount, conflict, returning) {
  const vals = [];
  let i = 1;
  for (let r = 0; r < rowCount; r++) vals.push('(' + cols.map(() => `$${i++}`).join(',') + ')');
  return `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES ${vals.join(',')} ` +
    `${conflict} ${returning || ''}`;
}

async function insertBatched(client, { table, cols, rows, conflict, returning, label, cast = {} }) {
  const got = [];
  const p = new Progress(rows.length || 1, label);
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const binds = [];
    for (const r of chunk) for (const c of cols) binds.push(r[c] === undefined ? null : r[c]);
    // Apply explicit casts (json / text[] / bigint / enum) where the driver cannot
    // infer the type. A replacer FUNCTION is used deliberately: `$1` inside a
    // replacement STRING is a backreference, which would corrupt the placeholders.
    const castAt = new Map();
    for (const [col, type] of Object.entries(cast)) {
      const idx = cols.indexOf(col);
      if (idx === -1) continue;
      for (let r = 0; r < chunk.length; r++) castAt.set(r * cols.length + idx + 1, type);
    }
    let sql = insertSql(table, cols, chunk.length, conflict, returning);
    if (castAt.size) {
      sql = sql.replace(/\$(\d+)/g, (m, n) => castAt.has(Number(n)) ? `${m}::${castAt.get(Number(n))}` : m);
    }
    const res = await client.query(sql, binds);
    if (returning) got.push(...res.rows);
    p.tick(chunk.length);
  }
  p.done();
  return got;
}

(async () => {
  // ---------------------------------------------------------------- pick the run
  if (!fs.existsSync(EXPORT_ROOT)) throw new Error(`no export folder at ${EXPORT_ROOT} - run the export first`);
  const runs = fs.readdirSync(EXPORT_ROOT).filter(d => fs.statSync(path.join(EXPORT_ROOT, d)).isDirectory()).sort();
  const runId = runArg || runs[runs.length - 1];
  if (!runId || !runs.includes(runId)) throw new Error(`export run "${runId}" not found. available: ${runs.join(', ')}`);
  const DIR = path.join(EXPORT_ROOT, runId);

  hr(`UG v1 -> v2 IMPORT   ${APPLY ? '*** APPLY (writes will be COMMITTED) ***' : 'DRY RUN (everything is rolled back)'}`);
  log(`  export run : ${DIR}`);

  // ---------------------------------------------------------------- verify files
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  log(`  exported   : ${manifest.generatedAt}`);
  let bad = 0;
  for (const [name, meta] of Object.entries(manifest.files)) {
    const f = path.join(DIR, name);
    if (!fs.existsSync(f)) { log(`  MISSING ${name}`); bad++; continue; }
    if (sha256(f) !== meta.sha256) { log(`  CHECKSUM MISMATCH ${name} - the file changed after export`); bad++; }
  }
  if (bad) throw new Error(`${bad} export file(s) failed verification - refusing to import`);
  log(`  checksums  : all ${Object.keys(manifest.files).length} files verified`);

  const leads = readNd(path.join(DIR, 'leads.ndjson'));
  const ugLead = readNd(path.join(DIR, 'under_graduate_lead.ndjson'));
  const ugApp = readNd(path.join(DIR, 'under_graduate_applicant.ndjson'));
  const timelines = readNd(path.join(DIR, 'timelines.ndjson'));
  const notes = readNd(path.join(DIR, 'notes.ndjson'));
  const tags = readNd(path.join(DIR, 'lead_tags.ndjson'));
  const students = readNd(path.join(DIR, 'students.ndjson'));
  const promotions = readNd(path.join(DIR, 'promotions.ndjson'));
  const trackers = readNd(path.join(DIR, 'activity_trackers.ndjson'));
  const trackerUpdates = readNd(path.join(DIR, 'activity_tracker_updates.ndjson'));
  const scoreHistory = readNd(path.join(DIR, 'lead_score_history.ndjson'));
  const ugBackfill = readNd(path.join(DIR, 'under_graduate_backfill.ndjson'));
  log(`  payload    : ${leads.length} leads, ${timelines.length} timelines, ${notes.length} notes, ` +
      `${tags.length} tags, ${students.length} students, ${promotions.length} promotions, ` +
      `${trackers.length} activity trackers, ${scoreHistory.length} score-history rows, ` +
      `${ugBackfill.length} form backfills`);

  const RUN_TS = new Date().toISOString().replace(/[:.]/g, '-');
  const RUNDIR = path.join(DIR, 'runs', RUN_TS);
  fs.mkdirSync(RUNDIR, { recursive: true });

  /* --------------------------------------------------------------------------
   * CHECKPOINT
   *
   * The checkpoint lives in the EXPORT folder, not the run folder, so every apply
   * against the same export shares it. If the script dies half way - network drop,
   * a killed terminal, an error in a later phase - re-running it skips the phases
   * that already committed and carries on from the first one that did not.
   *
   * This is belt and braces, not the primary safety net: every write is already
   * idempotent through a unique index, so a re-run without a checkpoint would also
   * be correct. What the checkpoint buys is speed and a clear, auditable record of
   * exactly how far the migration got.
   *
   * A dry run never reads or writes it - only --apply does.
   * ------------------------------------------------------------------------- */
  const CKPT_FILE = path.join(DIR, 'checkpoint.json');
  let ckpt = { exportRun: runId, manifestSha: sha256(path.join(DIR, 'manifest.json')), phases: {} };
  if (fs.existsSync(CKPT_FILE) && !RESTART) {
    const onDisk = JSON.parse(fs.readFileSync(CKPT_FILE, 'utf8'));
    if (onDisk.manifestSha !== ckpt.manifestSha) {
      log('  checkpoint: found one for a DIFFERENT export payload - ignoring it');
    } else {
      ckpt = onDisk;
      const done = Object.keys(ckpt.phases).filter(k => ckpt.phases[k].done);
      if (done.length) {
        log(`  checkpoint: ${done.length} phase(s) already completed in an earlier run:`);
        done.forEach(k => log(`      ${k.padEnd(26)} at ${ckpt.phases[k].at}  ${JSON.stringify(ckpt.phases[k].result || {})}`));
        log('  those phases will be SKIPPED. Use --restart to force them to run again');
        log('  (safe either way - every write is idempotent).');
      }
    }
  } else if (RESTART && fs.existsSync(CKPT_FILE)) {
    log('  checkpoint: --restart given, ignoring the existing checkpoint');
  }
  const phaseDone = k => APPLY && !!(ckpt.phases[k] && ckpt.phases[k].done);
  const markPhase = (k, result) => {
    if (!APPLY) return;
    ckpt.phases[k] = { done: true, at: new Date().toISOString(), result };
    fs.writeFileSync(CKPT_FILE, JSON.stringify(ckpt, null, 2));
  };

  const v2 = await connect('v2', { readOnly: false });
  const summary = {};
  const rollback = [];
  let phaseNo = 0;

  /**
   * On APPLY each phase gets its own short transaction, so nothing holds locks on
   * tables the live CRM is using.
   *
   * On a DRY RUN every phase runs inside ONE enclosing transaction that is rolled
   * back at the end. That matters: later phases depend on ids created by earlier
   * ones (an applicant's user_id is the students phase's output), so committing
   * per phase and rolling back would make the rehearsal fail on a foreign key that
   * would never fail for real. One transaction makes the dry run an honest
   * rehearsal of the whole import - including whether the automation trigger fires.
   */
  /** Persist the undo script as we go, so a mid-run failure still leaves one. */
  const writeRollback = () => {
    if (!APPLY) return;
    fs.writeFileSync(path.join(RUNDIR, 'rollback.sql'),
      ['-- Rollback for import run ' + RUN_TS,
       '-- Review before running. Execute exactly as written, in this order.',
       '--',
       '-- Statements are emitted in REVERSE phase order on purpose. under_graduate has',
       '-- NO foreign key to v2_leads, so deleting the lead first would strand its',
       '-- under_graduate row - the same orphan defect this migration had to repair.',
       '-- timelines, notes, lead_tags and ApplicationActivityTrackers DO cascade from',
       '-- v2_leads, so their explicit DELETEs are belt and braces.',
       '--',
       "-- app.skip_automation must be set, or undoing the promotion UPDATE will emit",
       '-- automation events for a real applicant.',
       'BEGIN;', "SET app.skip_automation = 'true';",
       ...[...rollback].reverse(), 'COMMIT;'].join('\n') + '\n');
  };

  const phase = async (key, name, fn) => {
    phaseNo++;
    hr(`${phaseNo}. ${name}`);
    if (phaseDone(key)) {
      log(`  SKIPPED - completed at ${ckpt.phases[key].at} ${JSON.stringify(ckpt.phases[key].result || {})}`);
      summary[key] = 'SKIPPED (checkpoint)';
      return;
    }
    if (APPLY) await v2.query('begin');
    // Undo statements pushed by THIS phase describe rows Postgres is about to roll
    // back itself; keeping them would let rollback.sql "restore" values the live
    // CRM may have changed since. Trim back to this mark if the phase fails.
    const rbMark = rollback.length;
    let out;
    try {
      out = await fn();
      if (APPLY) { await v2.query('commit'); log('  committed'); markPhase(key, { ...summary }); writeRollback(); }
      else log('  (held inside the dry-run transaction)');
    } catch (e) {
      if (APPLY) await v2.query('rollback').catch(() => {});
      rollback.length = rbMark;
      // Phases already committed are still on disk; make sure their undo is too.
      writeRollback();
      if (APPLY && rollback.length) {
        log(`\n  *** ${rollback.length} statement(s) from COMMITTED phases were written to:`);
        log(`  *** ${path.join(RUNDIR, 'rollback.sql')}`);
        log('  *** Re-running the import is safe (every write is idempotent);');
        log('  *** use rollback.sql only if you want to undo what already committed.');
      }
      throw e;
    }
    // A reconnect would silently lose the session GUC - re-verify after every commit.
    const { rows } = await v2.query(`select current_setting('app.skip_automation', true) as v`);
    if (rows[0].v !== 'true') throw new Error('app.skip_automation is no longer true - aborting');
    return out;
  };

  try {
    // ---------------------------------------------------------------- guard
    hr('0. automation guard');
    await armAutomationGuard(v2);
    const { rows: g } = await v2.query(`select current_setting('app.skip_automation', true) v, current_setting('app.automation_channel', true) ch`);
    log(`  app.skip_automation = ${JSON.stringify(g[0].v)}  (verified)`);
    log(`  automation channel  = ${JSON.stringify(g[0].ch)}`);
    const { rows: ae0 } = await v2.query(`select count(*)::bigint n, coalesce(max(id), 0)::bigint mx from automation_events where org_id=$1`, [M.ORG_V2]);
    log(`  automation_events for org ${M.ORG_V2} before: ${ae0[0].n} (max id ${ae0[0].mx})`);
    // The max id is the baseline for the guard check at the end. Counting events for
    // our row ids WITHOUT it gives false positives: a promotion target is an existing
    // row the live CRM touches on its own, and its history predates this run.
    const AE_BASELINE = ae0[0].mx;

    // open the enclosing dry-run transaction (see `phase` above)
    if (!APPLY) { await v2.query('begin'); log('  dry run: opened one transaction; it will be rolled back at the end'); }

    const { rows: trg } = await v2.query(`
      select c.relname t, tg.tgname, tg.tgenabled from pg_trigger tg join pg_class c on c.oid=tg.tgrelid
      where not tg.tgisinternal and c.relname in ('v2_leads','under_graduate','timelines','notes','lead_tags','users')`);
    log(`  triggers on target tables: ${trg.length ? trg.map(r => `${r.t}.${r.tgname}(${r.tgenabled})`).join(', ') : 'none'}`);

    // ---------------------------------------------------------------- 1. students
    const studentMap = new Map();      // v1 user id -> v2 user id
    await phase('students', `students -> users  (${students.length})`, async () => {
      // Resolve BEFORE inserting. A v2 user for this person can already exist with
      // v1_id = NULL (the v2 portal creates its own row when a student registers
      // there). ON CONFLICT (v1_id) would not fire for such a row, so inserting
      // blindly would mint a SECOND account on the same email and split the person
      // in two. Match on v1_id first, then on email within the org.
      if (students.length) {
        const { rows: byV1 } = await v2.query(
          'select id, v1_id, email from users where v1_id = any($1::int[])', [students.map(s => s.v1_id)]);
        byV1.forEach(r => studentMap.set(r.v1_id, r.id));
        const stillNeed = students.filter(s => !studentMap.has(s.v1_id));
        if (stillNeed.length) {
          const { rows: byEmail } = await v2.query(
            `select id, email, v1_id, role, created_at from users
              where organization_id = $1 and lower(email) = any($2::text[])
              order by id`, [M.ORG_V2, stillNeed.map(s => (s.email || '').toLowerCase())]);
          for (const s of stillNeed) {
            const hit = byEmail.find(u => (u.email || '').toLowerCase() === (s.email || '').toLowerCase());
            if (!hit) continue;
            studentMap.set(s.v1_id, hit.id);
            log(`  reusing existing v2 user ${hit.id} <${hit.email}> for v1 user ${s.v1_id} ` +
                `(it has v1_id=${hit.v1_id}) - NOT creating a duplicate`);
            if (hit.v1_id === null) {
              await v2.query('update users set v1_id = $1 where id = $2 and v1_id is null', [s.v1_id, hit.id]);
              log(`    stamped v1_id=${s.v1_id} onto user ${hit.id} so the link is explicit from now on`);
              rollback.push(`UPDATE "users" SET v1_id = NULL WHERE id = ${hit.id};`);
            }
          }
        }
      }
      const toInsert = students.filter(s => !studentMap.has(s.v1_id));
      let created = 0;
      log(`  ${students.length} student(s) in the payload: ${studentMap.size} already exist, ${toInsert.length} to create`);
      if (toInsert.length) {
        const cols = ['email', 'password_hash', 'name', 'phone', 'country_code', 'role', 'user_type',
          'organization_id', 'school_id', 'status', 'timezone', 'image', 'login_count', 'v1_id',
          'created_at', 'updated_at'];
        const got = await insertBatched(v2, {
          table: 'users', cols, rows: toInsert, label: 'users',
          conflict: 'ON CONFLICT (v1_id) WHERE v1_id IS NOT NULL DO NOTHING',
          returning: 'RETURNING id, v1_id',
        });
        got.forEach(r => studentMap.set(r.v1_id, r.id));
        created = got.length;
        log(`  inserted ${got.length} of ${toInsert.length}`);
        got.forEach(r => rollback.push(`DELETE FROM "users" WHERE id = ${r.id}; -- v1_id ${r.v1_id}`));
      }
      // Every student the payload names must now resolve - an applicant's user_id
      // depends on it, and v2_leads.user_id has a foreign key.
      const unresolved = students.filter(s => !studentMap.has(s.v1_id));
      if (unresolved.length) {
        throw new Error(`${unresolved.length} student(s) could not be resolved or created: ` +
          JSON.stringify(unresolved.map(s => `${s.v1_id} ${s.email}`)));
      }
      log(`  student map: ${JSON.stringify([...studentMap.entries()])}`);
      summary.studentsResolved = studentMap.size;
      summary.studentsCreated = created;
      return studentMap;
    });

    // A resumed run SKIPS the students phase, but every later phase still needs the
    // map, so rebuild it from v2 unconditionally. Cheap, and it also covers the case
    // where that phase committed in a process that then died before phase 2.
    if (students.length && studentMap.size !== students.length) {
      const { rows } = await v2.query(
        'select id, v1_id, email from users where v1_id = any($1::int[])', [students.map(x => x.v1_id)]);
      rows.forEach(r => studentMap.set(r.v1_id, r.id));
      const missing = students.filter(x => !studentMap.has(x.v1_id));
      if (missing.length) {
        const { rows: byEmail } = await v2.query(
          'select id, email, v1_id from users where organization_id = $1 and lower(email) = any($2::text[])',
          [M.ORG_V2, missing.map(x => (x.email || '').toLowerCase())]);
        for (const x of missing) {
          const hit = byEmail.find(u => (u.email || '').toLowerCase() === (x.email || '').toLowerCase());
          if (hit) studentMap.set(x.v1_id, hit.id);
        }
      }
      log(`  (rehydrated student map from v2: ${studentMap.size}/${students.length})`);
      if (studentMap.size !== students.length) {
        throw new Error('cannot rebuild the student map on resume - re-run with --restart');
      }
    }

    // ---------------------------------------------------------------- 2. v2_leads
    const leadMap = new Map();        // v1_lead_id -> v2 lead id
    await phase('leads', `leads -> v2_leads  (${leads.length})`, async () => {
      const cols = [
        'org_id', 'school_id', 'program_id', 'batch_id', 'round_id', 'form_id', 'lead_table_id', 'user_id',
        'registered_name', 'registered_email', 'registered_mobile', 'country_code', 'status', 'lead_score',
        'lead_stage_id', 'lead_sub_stage_id', 'counsellor_id', 'is_mobile_verified', 'is_email_verified',
        'alternate_email', 'alternate_mobile_number', 'source', 'medium', 'campaign',
        'secondary_source', 'secondary_medium', 'secondary_campaign',
        'tertiary_source', 'tertiary_medium', 'tertiary_campaign', 'lead_origin', 'lead_device',
        'created_at', 'updated_at', 'is_payment_done', 'payment_status', 'payment_initiated',
        'payment_mode', 'payment_method', 'form_percentage_filled', 'lead_payload', 'registered_on',
        'city', 'state', 'iso_code', 'lead_country', 'program_eligible', 'previous_lead_stage',
        'reassigned_on', 'reassigned_by', 'crisp_chat_link', 'chat_summary', 'is_chatbot_lead',
        'application_form_initiated', 'application_form_submitted', 'application_number',
        'application_stage_id', 'application_sub_stage_id', 'application_registered_on',
        'last_interacted_section', 'form_completion_date', 'applicant_status', 'is_edit_access_granted',
        'type', 'is_deleted', 'source_url', 'lead_type', 'is_enrolled', 'final_decision',
        'concat_smc', 'human_handoff', 'v1_lead_id', 'v1_application_id', 'v1_user_id',
        'is_inbound_lead', 'test_lead', 'automation_tags',
      ];
      const rows = leads.map(l => {
        const r = { ...l };
        delete r._v1;
        // an applicant's user_id is only knowable once the student row exists
        if (l.type === 'applicant' && l._v1 && l._v1.studentV1Id) {
          r.user_id = studentMap.get(l._v1.studentV1Id) ?? null;
          if (r.user_id === null) throw new Error(`applicant v1#${l.v1_lead_id} needs v1 user ${l._v1.studentV1Id} but it was not created`);
        }
        return r;
      });
      const got = await insertBatched(v2, {
        table: 'v2_leads', cols, rows, label: 'v2_leads',
        conflict: 'ON CONFLICT (v1_lead_id) WHERE v1_lead_id IS NOT NULL DO NOTHING',
        returning: 'RETURNING id, v1_lead_id',
        cast: { lead_payload: 'json', automation_tags: 'text[]', type: 'enum_v2_leads_type',
                lead_type: 'enum_v2_leads_lead_type', final_decision: 'enum_v2_leads_final_decision' },
      });
      got.forEach(r => leadMap.set(r.v1_lead_id, r.id));
      log(`  inserted ${got.length} of ${leads.length}`);
      if (got.length !== leads.length) log(`  ${leads.length - got.length} already existed (ON CONFLICT DO NOTHING)`);
      got.forEach(r => rollback.push(`DELETE FROM "v2_leads" WHERE id = ${r.id}; -- v1_lead_id ${r.v1_lead_id}`));
      // resolve the rest
      const need = leads.map(l => l.v1_lead_id).filter(id => !leadMap.has(id));
      if (need.length) {
        const { rows: ex } = await v2.query('select id, v1_lead_id from v2_leads where v1_lead_id = any($1::int[])', [need]);
        ex.forEach(r => leadMap.set(r.v1_lead_id, r.id));
      }
      if (leadMap.size !== leads.length) throw new Error(`lead map has ${leadMap.size} entries, expected ${leads.length}`);
      summary.leads = got.length;
      return leadMap;
    });

    // Same for the lead map - a resumed run needs it for every satellite phase.
    if (leads.length && leadMap.size !== leads.length) {
      for (let i = 0; i < leads.length; i += 20000) {
        const slice = leads.slice(i, i + 20000).map(l => l.v1_lead_id);
        const { rows } = await v2.query(
          'select id, v1_lead_id from v2_leads where v1_lead_id = any($1::int[])', [slice]);
        rows.forEach(r => leadMap.set(r.v1_lead_id, r.id));
      }
      log(`  (rehydrated lead map from v2: ${leadMap.size}/${leads.length})`);
      if (leadMap.size !== leads.length) {
        throw new Error(`cannot rebuild the lead map on resume: ${leadMap.size} of ${leads.length} found - re-run with --restart`);
      }
    }

    // ---------------------------------------------------------------- 3. under_graduate (lead level)
    await phase('under_graduate_lead', `under_graduate (lead-level)  (${ugLead.length})`, async () => {
      const cols = ['org_id', 'lead_id', 'v1_lead_id', 'created_at', 'updated_at', 'city', 'state', 'grade',
        'professional_qualification', 'country_of_birth'];
      const rows = ugLead.map(r => ({ ...r, lead_id: leadMap.get(r.v1_lead_id) }));
      const missing = rows.filter(r => !r.lead_id);
      if (missing.length) throw new Error(`${missing.length} under_graduate rows have no v2 lead id`);

      // Back up any row we are about to re-point, so rollback.sql can restore it.
      const { rows: pre } = await v2.query(
        'select * from under_graduate where v1_lead_id = any($1::int[])', [rows.map(r => r.v1_lead_id)]);
      if (pre.length) {
        fs.writeFileSync(path.join(RUNDIR, 'backup_under_graduate.json'), JSON.stringify(pre, null, 2));
        pre.forEach(p => {
          log(`  re-pointing under_graduate #${p.id} (v1 lead ${p.v1_lead_id}) from dead lead ${p.lead_id} -> ${leadMap.get(p.v1_lead_id)}`);
          rollback.push(`UPDATE "under_graduate" SET lead_id = ${p.lead_id === null ? 'NULL' : p.lead_id} WHERE id = ${p.id};`);
        });
      }

      // A conflict here can only be a row left behind by a HARD-deleted v2 lead
      // (a live lead with this v1_lead_id would mean the lead was never missing).
      // Re-point it rather than letting DO NOTHING strand the new lead without one.
      // The WHERE makes that explicit: never touch a row whose lead is still alive.
      const got = await insertBatched(v2, {
        table: 'under_graduate', cols, rows, label: 'under_graduate',
        conflict:
          'ON CONFLICT (v1_lead_id) WHERE v1_lead_id IS NOT NULL DO UPDATE SET ' +
          '"lead_id" = EXCLUDED."lead_id", "city" = EXCLUDED."city", "state" = EXCLUDED."state", ' +
          '"grade" = EXCLUDED."grade", "professional_qualification" = EXCLUDED."professional_qualification", ' +
          '"country_of_birth" = EXCLUDED."country_of_birth", "updated_at" = EXCLUDED."updated_at" ' +
          'WHERE NOT EXISTS (SELECT 1 FROM v2_leads l WHERE l.id = "under_graduate"."lead_id")',
        returning: 'RETURNING id, v1_lead_id',
      });
      const inserted = got.length - pre.length;
      log(`  ${inserted} inserted, ${pre.length} re-pointed, of ${ugLead.length}`);
      const preIds = new Set(pre.map(p => p.id));
      got.filter(r => !preIds.has(r.id))
        .forEach(r => rollback.push(`DELETE FROM "under_graduate" WHERE id = ${r.id}; -- v1_lead_id ${r.v1_lead_id}`));
      summary.ugLead = got.length;
      summary.ugRepointed = pre.length;
    });

    // ---------------------------------------------------------------- 4. under_graduate (applicant answers)
    await phase('under_graduate_applicant', `under_graduate (applicant form answers)  (${ugApp.length})`, async () => {
      let n = 0;
      const ugAppBackup = [];
      for (const a of ugApp) {
        const leadId = a.key.v2_lead_id || leadMap.get(a.key.v1_lead_id);
        if (!leadId) throw new Error(`applicant under_graduate row has no lead id: ${JSON.stringify(a.key)}`);
        const cols = Object.keys(a.data);
        // Read the WHOLE row first. under_graduate has NO foreign key to v2_leads, so a
        // rollback that only deletes the lead would strand this row - the exact defect
        // that produced the orphan we re-point in the previous phase. Every column we
        // are about to overwrite therefore gets an explicit restore statement.
        const { rows: ex } = await v2.query('select * from "under_graduate" where lead_id=$1 and org_id=$2', [leadId, M.ORG_V2]);
        if (ex.length) {
          ugAppBackup.push(ex[0]);
          const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
          await v2.query(`UPDATE "under_graduate" SET ${sets}, "updated_at" = now() WHERE id = $${cols.length + 1}`,
            [...cols.map(c => a.data[c]), ex[0].id]);
          rollback.push(`UPDATE "under_graduate" SET ` +
            [...cols, 'updated_at'].map(c => `"${c}" = ${sqlLit(ex[0][c], c)}`).join(', ') +
            ` WHERE id = ${ex[0].id};`);
          log(`    (pre-existing row #${ex[0].id} backed up; ${cols.length} columns restorable)`);
        } else {
          const all = ['org_id', 'lead_id', 'v1_lead_id', 'created_at', 'updated_at', ...cols];
          const vals = [M.ORG_V2, leadId, a.key.v1_lead_id ?? null, new Date(), new Date(), ...cols.map(c => a.data[c])];
          const { rows: ins } = await v2.query(
            `INSERT INTO "under_graduate" (${all.map(c => `"${c}"`).join(',')}) VALUES (${all.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals);
          rollback.push(`DELETE FROM "under_graduate" WHERE id = ${ins[0].id};`);
        }
        n++;
        log(`  lead ${leadId}: ${cols.length} form columns written`);
      }
      if (ugAppBackup.length) {
        fs.writeFileSync(path.join(RUNDIR, 'backup_under_graduate_applicant.json'), JSON.stringify(ugAppBackup, null, 2));
      }
      summary.ugApp = n;
    });

    // ---------------------------------------------------------------- 4b. under_graduate backfill (Stream F)
    // Live v2 applicants the old sync carried over WITHOUT their form answers. Purely
    // additive: a row is inserted only if the lead still has none. Nothing is ever
    // updated, and v2_leads is not touched. Every condition the export checked is
    // re-checked here against the live row, because counsellors and students are
    // using these leads right now - a student may have filled the form via the portal
    // since the export ran, and then their data wins and we skip.
    await phase('under_graduate_backfill', `under_graduate backfill for existing applicants  (${ugBackfill.length})`, async () => {
      const inserted = [], skipped = [];
      for (const b of ugBackfill) {
        const { rows: [s] } = await v2.query(
          `select l.is_deleted, l.v1_lead_id, l.v1_application_id, l.org_id,
                  (select count(*)::int from under_graduate u where u.lead_id = l.id) ug
             from v2_leads l where l.id = $1`, [b.v2_lead_id]);
        if (!s || s.is_deleted || Number(s.org_id) !== M.ORG_V2 ||
            Number(s.v1_lead_id) !== b.v1_lead_id || Number(s.v1_application_id) !== b.v1_application_id) {
          skipped.push({ v2_lead_id: b.v2_lead_id, why: 'lead deleted or changed since export' });
          log(`  SKIP lead ${b.v2_lead_id}: deleted or changed since export`);
          continue;
        }
        if (s.ug > 0) {
          skipped.push({ v2_lead_id: b.v2_lead_id, why: 'form row now exists - filled in v2 since export' });
          log(`  SKIP lead ${b.v2_lead_id}: a form row now exists (filled in v2 since export) - left as is`);
          continue;
        }
        const cols = Object.keys(b.data);
        const all = ['org_id', 'lead_id', 'v1_lead_id', 'created_at', 'updated_at', ...cols];
        const vals = [M.ORG_V2, b.v2_lead_id, b.v1_lead_id, b.created_at, new Date(), ...cols.map(c => b.data[c])];
        const { rows: ins } = await v2.query(
          `INSERT INTO "under_graduate" (${all.map(c => `"${c}"`).join(',')})
           VALUES (${all.map((_, i) => `$${i + 1}`).join(',')})
           ON CONFLICT (v1_lead_id) WHERE v1_lead_id IS NOT NULL DO NOTHING
           RETURNING id`, vals);
        if (!ins.length) {
          skipped.push({ v2_lead_id: b.v2_lead_id, why: 'v1_lead_id already has a form row' });
          log(`  SKIP lead ${b.v2_lead_id}: v1 lead ${b.v1_lead_id} already has a form row`);
          continue;
        }
        inserted.push(ins[0].id);
        rollback.push(`DELETE FROM "under_graduate" WHERE id = ${ins[0].id}; -- backfill, v2 lead ${b.v2_lead_id}`);
        log(`  lead ${b.v2_lead_id}: ${cols.length} form columns inserted (under_graduate #${ins[0].id})`);
      }
      // lead_id has no unique index. If a portal save landed between our check and our
      // insert, the lead now has two rows - refuse to commit rather than leave that.
      if (ugBackfill.length) {
        const { rows: dup } = await v2.query(
          `select lead_id, count(*)::int n from under_graduate where lead_id = any($1::bigint[])
            group by lead_id having count(*) > 1`, [ugBackfill.map(b => b.v2_lead_id)]);
        if (dup.length) throw new Error(`backfill would leave ${dup.length} lead(s) with two form rows: ${JSON.stringify(dup)} - rolled back, re-run to skip them`);
      }
      if (skipped.length) fs.writeFileSync(path.join(RUNDIR, 'backfill_skipped.json'), JSON.stringify(skipped, null, 2));
      log(`  ${inserted.length} inserted, ${skipped.length} skipped, of ${ugBackfill.length}`);
      summary.ugBackfill = inserted.length;
      summary.ugBackfillSkipped = skipped.length;
    });

    // ---------------------------------------------------------------- 5. timelines
    await phase('timelines', `timelines  (${timelines.length})`, async () => {
      const cols = ['v2_lead_id', 'v1_lead_id', 'v1_timeline_id', 'event_type', 'title', 'description',
        'metadata', 'lead_stage_id', 'template_id', 'created_by', 'v1_counsellor_id', 'org_id', 'school_id',
        'created_at', 'updated_at', 'lead_id'];
      const rows = timelines.map(t => {
        const r = { ...t };
        delete r._v1;
        r.v2_lead_id = leadMap.get(t.v1_lead_id);
        // a student author only became resolvable once its users row was created
        if (r.created_by === null && t._v1 && t._v1.authorV1 != null && studentMap.has(t._v1.authorV1)) {
          r.created_by = studentMap.get(t._v1.authorV1);
        }
        return r;
      });
      const orphan = rows.filter(r => !r.v2_lead_id);
      if (orphan.length) throw new Error(`${orphan.length} timelines have no v2 lead id`);

      // `timelines_v1_timeline_id_uniq` exists but is INVALID (indisvalid = false):
      // it is a partitioned index and timelines_p202605 is detached from the parent,
      // so it was never completed and Postgres will not accept it as an ON CONFLICT
      // arbiter. Idempotency therefore comes from an explicit pre-filter instead.
      // v1_timeline_id is still written, so this becomes a plain ON CONFLICT the day
      // the partition is re-attached and the index rebuilt.
      const { rows: idx } = await v2.query(
        `select indisvalid from pg_index ix join pg_class i on i.oid = ix.indexrelid
          where i.relname = 'timelines_v1_timeline_id_uniq'`);
      log(`  timelines_v1_timeline_id_uniq valid? ${idx.length ? idx[0].indisvalid : 'missing'} -> using a pre-filter`);

      const times = rows.map(r => new Date(r.created_at).getTime());
      const lo = new Date(Math.min(...times)); lo.setUTCDate(1); lo.setUTCHours(0, 0, 0, 0);
      const hi = new Date(Math.max(...times)); hi.setUTCMonth(hi.getUTCMonth() + 1, 1); hi.setUTCHours(0, 0, 0, 0);
      const already = new Set();
      const allIds = rows.map(r => r.v1_timeline_id);
      for (let i = 0; i < allIds.length; i += 5000) {
        const { rows: ex } = await v2.query(
          `select v1_timeline_id from timelines
            where created_at >= $2 and created_at < $3 and v1_timeline_id = any($1::bigint[])`,
          [allIds.slice(i, i + 5000), lo, hi]);
        ex.forEach(r => already.add(String(r.v1_timeline_id)));
      }
      const fresh = rows.filter(r => !already.has(String(r.v1_timeline_id)));
      if (already.size) log(`  ${already.size} timeline(s) already present - skipping them`);

      const got = await insertBatched(v2, {
        table: 'timelines', cols, rows: fresh, label: 'timelines',
        conflict: '', returning: 'RETURNING id, v1_timeline_id',
        cast: { metadata: 'jsonb', v1_timeline_id: 'bigint' },
      });
      log(`  inserted ${got.length} of ${timelines.length}`);
      const resolvedAuthors = rows.filter(r => r.created_by !== null).length;
      log(`  created_by resolved on ${resolvedAuthors} of ${rows.length}`);
      rollback.push(`DELETE FROM "timelines" WHERE v1_timeline_id = ANY(ARRAY[${timelines.map(t => t.v1_timeline_id).join(',')}]::bigint[]);`);
      summary.timelines = got.length;
    });

    // ---------------------------------------------------------------- 6. notes
    await phase('notes', `notes  (${notes.length})`, async () => {
      if (!notes.length) { summary.notes = 0; return; }
      const cols = ['v2_lead_id', 'v1_lead_id', 'v1_note_id', 'content', 'admin_id', 'v1_counsellor_id',
        'org_id', 'school_id', 'created_at', 'updated_at', 'visible', 'lead_id'];
      const rows = notes.map(n => ({ ...n, v2_lead_id: leadMap.get(n.v1_lead_id) }));
      const got = await insertBatched(v2, {
        table: 'notes', cols, rows, label: 'notes',
        conflict: 'ON CONFLICT (v1_note_id) WHERE v1_note_id IS NOT NULL DO NOTHING',
        returning: 'RETURNING id, v1_note_id',
      });
      log(`  inserted ${got.length} of ${notes.length}`);
      got.forEach(r => rollback.push(`DELETE FROM "notes" WHERE id = ${r.id}; -- v1_note_id ${r.v1_note_id}`));
      summary.notes = got.length;
    });

    // ---------------------------------------------------------------- 7. lead_tags
    await phase('lead_tags', `lead_tags  (${tags.length})`, async () => {
      if (!tags.length) { summary.tags = 0; return; }
      const cols = ['v2_lead_id', 'v1_lead_id', 'tag_id', 'org_id', 'school_id', 'created_at', 'updated_at', 'lead_id'];
      const rows = tags.map(t => ({ ...t, v2_lead_id: leadMap.get(t.v1_lead_id) }));
      const got = await insertBatched(v2, {
        table: 'lead_tags', cols, rows, label: 'lead_tags',
        conflict: 'ON CONFLICT (v2_lead_id, tag_id) WHERE v2_lead_id IS NOT NULL DO NOTHING',
        returning: 'RETURNING id, v1_lead_id',
      });
      log(`  inserted ${got.length} of ${tags.length}`);
      got.forEach(r => rollback.push(`DELETE FROM "lead_tags" WHERE id = ${r.id};`));
      summary.tags = got.length;
    });

    // ---------------------------------------------------------------- 7b. activity trackers
    await phase('activity_trackers', `ApplicationActivityTrackers  (${trackers.length} insert, ${trackerUpdates.length} update)`, async () => {
      if (trackers.length) {
        const cols = ['leadId', 'v1_leadId', 'v1_applicationId', 'applicationForm_start_date',
          'payment_Initiated_date', 'payment_last_Initiated_date', 'counsellor_first_activity_date',
          'counsellor_last_activity_date', 'application_fee_paidOn', 'application_last_activity_date',
          'lastLeadStageUpdated', 'firstLeadStageUpdated', 'applicationFormSubmittedOn',
          'createdAt', 'updatedAt'];
        const rows = trackers.map(t => ({ ...t, leadId: leadMap.get(t.v1_leadId) }));
        const orphan = rows.filter(r => !r.leadId);
        if (orphan.length) throw new Error(`${orphan.length} activity trackers have no v2 lead id`);
        const got = await insertBatched(v2, {
          table: 'ApplicationActivityTrackers', cols, rows, label: 'activity_trackers',
          conflict: 'ON CONFLICT ("v1_leadId") WHERE "v1_leadId" IS NOT NULL DO NOTHING',
          returning: 'RETURNING id, "v1_leadId"',
        });
        log(`  inserted ${got.length} of ${trackers.length}`);
        got.forEach(r => rollback.push(`DELETE FROM "ApplicationActivityTrackers" WHERE id = ${r.id}; -- v1_leadId ${r.v1_leadId}`));
        summary.trackers = got.length;
      }
      // the promoted lead already has a tracker row - refresh it from v1
      const backup = [];
      for (const u of trackerUpdates) {
        const { rows: [cur] } = await v2.query(
          'select * from "ApplicationActivityTrackers" where "leadId" = $1', [u.v2_lead_id]);
        if (!cur) {
          const cols = ['leadId', 'v1_leadId', ...Object.keys(u.after)];
          const vals = [u.v2_lead_id, u.v1_lead_id, ...Object.keys(u.after).map(c => u.after[c])];
          const { rows: ins } = await v2.query(
            `INSERT INTO "ApplicationActivityTrackers" (${cols.map(c => `"${c}"`).join(',')})
             VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})
             ON CONFLICT ("v1_leadId") WHERE "v1_leadId" IS NOT NULL DO NOTHING RETURNING id`, vals);
          if (ins.length) {
            log(`  no existing tracker for v2 lead ${u.v2_lead_id} - inserted #${ins[0].id}`);
            rollback.push(`DELETE FROM "ApplicationActivityTrackers" WHERE id = ${ins[0].id};`);
          }
          continue;
        }
        backup.push(cur);
        const cols = Object.keys(u.after);
        const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
        const res = await v2.query(
          `UPDATE "ApplicationActivityTrackers" SET ${sets} WHERE id = $${cols.length + 1}`,
          [...cols.map(c => u.after[c]), cur.id]);
        const changed = cols.filter(c => String(cur[c] instanceof Date ? cur[c].toISOString() : cur[c]) !==
                                          String(u.after[c] instanceof Date ? u.after[c].toISOString() : u.after[c]));
        log(`  refreshed tracker #${cur.id} for v2 lead ${u.v2_lead_id} from v1 row ${u.v1_tracker_id} ` +
            `[${res.rowCount} row, ${changed.length} column(s) changed: ${changed.join(', ') || 'none'}]`);
        rollback.push(`UPDATE "ApplicationActivityTrackers" SET ` +
          cols.map(c => `"${c}" = ${sqlLit(cur[c], c)}`).join(', ') + ` WHERE id = ${cur.id};`);
      }
      if (backup.length) fs.writeFileSync(path.join(RUNDIR, 'backup_activity_trackers.json'), JSON.stringify(backup, null, 2));
      summary.trackerUpdates = trackerUpdates.length;
    });

    // ---------------------------------------------------------------- 7c. lead score history
    await phase('lead_score_history', `lead score history  (${scoreHistory.length})`, async () => {
      if (!scoreHistory.length) { summary.scoreHistory = 0; return; }
      // leadScoreHistory.uuid is NOT NULL and has no default - the app supplies it.
      // Derive it deterministically from the v1 history id so a re-run produces the
      // same uuid rather than a fresh one each time.
      const cols = ['uuid', 'leadId', 'criteriaId', 'mappingId', 'mappingValue', 'delta', 'scoreBefore',
        'leadScore', 'schoolId', 'source', 'createdBy', 'createdAt', 'occurredAt', 'dedupeKey', 'metadata'];
      const rows = scoreHistory.map(r => ({
        ...r,
        leadId: leadMap.get(r.v1_lead_id),
        uuid: deterministicUuid(`ug-v1-score-history:${r.v1_history_id}`),
      }));
      const orphan = rows.filter(r => !r.leadId);
      if (orphan.length) throw new Error(`${orphan.length} score-history rows have no v2 lead id`);
      const got = await insertBatched(v2, {
        table: 'leadScoreHistory', cols, rows, label: 'lead_score_history',
        conflict: 'ON CONFLICT ("leadId", "dedupeKey") WHERE "dedupeKey" IS NOT NULL DO NOTHING',
        returning: 'RETURNING id, "dedupeKey"',
        cast: { metadata: 'jsonb' },
      });
      log(`  inserted ${got.length} of ${scoreHistory.length}`);
      got.forEach(r => rollback.push(`DELETE FROM "leadScoreHistory" WHERE id = ${r.id}; -- ${r.dedupeKey}`));
      summary.scoreHistory = got.length;
    });

    // ---------------------------------------------------------------- 8. promotions
    await phase('promotions', `lead -> applicant promotions  (${promotions.length})`, async () => {
      const backup = [];
      let done = 0, skipped = 0;
      for (const p of promotions) {
        const { rows: [cur] } = await v2.query('select * from v2_leads where id=$1', [p.v2_lead_id]);
        if (!cur) { log(`  SKIP v2#${p.v2_lead_id}: row not found`); skipped++; continue; }

        const after = { ...p.after };
        if (p._v1 && p._v1.studentV1Id) {
          after.user_id = studentMap.get(p._v1.studentV1Id) ?? null;
          if (after.user_id === null) throw new Error(`promotion v2#${p.v2_lead_id} needs v1 user ${p._v1.studentV1Id}`);
        }

        // The live v2 app can promote a lead on its own between export and apply, and
        // when it does it leaves the v1 linkage behind (no application_number, no
        // v1_application_id). Overwriting such a row wholesale would throw away what v2
        // already knows - its payment state is newer than v1's. So: only fill fields
        // that are still empty, and never touch one v2 has set.
        if (needsGapFill(cur)) {
          const plan = planGapFill(cur, after);   // scripts/lib/promotion.cjs - shared with verifier + impact report
          const fill = plan.fill;
          const kept = plan.kept.map(k => `${k.col}=${k.v2} (v1 says ${k.v1})`);
          log(`  v2#${p.v2_lead_id} (${p.registered_name}) was already promoted by v2 itself - filling gaps only`);
          if (!Object.keys(fill).length) { log('    nothing to fill; leaving the row untouched'); skipped++; continue; }
          // an application number must stay unique to this person
          if (fill.application_number) {
            const { rows: clash } = await v2.query(
              'select id from v2_leads where application_number = $1 and id <> $2', [fill.application_number, p.v2_lead_id]);
            if (clash.length) throw new Error(`application_number ${fill.application_number} already on v2 row(s) ${clash.map(c => c.id)}`);
          }
          backup.push(cur);
          const fc = Object.keys(fill);
          const res = await v2.query(
            `UPDATE v2_leads SET ${fc.map((c, i) => `"${c}" = $${i + 1}`).join(', ')} WHERE id = $${fc.length + 1}`,
            [...fc.map(c => fill[c]), p.v2_lead_id]);
          fc.forEach(c => log(`    filled  ${c.padEnd(28)} ${JSON.stringify(cur[c])} -> ${JSON.stringify(fill[c])}`));
          kept.forEach(k => log(`    kept v2 ${k}`));
          if (res.rowCount !== 1) throw new Error(`gap-fill of v2#${p.v2_lead_id} affected ${res.rowCount} rows`);
          done++; continue;
        }

        backup.push(cur);
        const cols = Object.keys(after);
        // `type` is an enum, so its placeholder carries an explicit cast.
        const sets = cols.map((c, i) => `"${c}" = $${i + 1}${c === 'type' ? '::enum_v2_leads_type' : ''}`).join(', ');
        const sql = `UPDATE v2_leads SET ${sets} ` +
          `WHERE id = $${cols.length + 1} AND "type" = 'lead' AND v1_application_id IS NULL`;
        const res = await v2.query(sql, [...cols.map(c => after[c]), p.v2_lead_id]);
        log(`  v2#${p.v2_lead_id} (${p.registered_name}) -> applicant ${after.application_number}, payment ${after.payment_status}  [${res.rowCount} row]`);
        if (res.rowCount !== 1) throw new Error(`promotion of v2#${p.v2_lead_id} affected ${res.rowCount} rows`);
        done++;
      }
      if (backup.length) {
        fs.writeFileSync(path.join(RUNDIR, 'backup_promotions.json'), JSON.stringify(backup, null, 2));
        for (const b of backup) {
          const cols = Object.keys(p0(b));
          rollback.push(`UPDATE v2_leads SET ${cols.map(c => `"${c}" = ${sqlLit(b[c], c)}`).join(', ')} WHERE id = ${b.id};`);
        }
      }
      summary.promotions = done; summary.promotionsSkipped = skipped;
    });

    // ---------------------------------------------------------------- 9. verify
    hr(`${++phaseNo}. verification`);

    // THE test that matters: did the trigger fire for OUR rows? A bare before/after
    // count cannot answer that - org 12 is a live CRM and other sessions are writing
    // throughout. Ask instead whether automation_events holds an event for any of the
    // exact v2_leads ids this run touched. Zero means the guard did its job.
    const touched = [...leadMap.values(), ...promotions.map(p => p.v2_lead_id)];
    const { rows: mine } = await v2.query(`
      select count(*)::int n from automation_events
      where id > $2::bigint and table_name = 'v2_leads' and row_id = any($1::bigint[])`, [touched, AE_BASELINE]);
    log(`  automation_events NEWER than id ${AE_BASELINE} for the ${touched.length} rows this run touched: ${mine[0].n}`);
    if (mine[0].n > 0) {
      log('  *** STOP. The automation trigger fired for rows this run wrote.');
      log('  *** Pause workflows 25 and 29 and any workflow with an email node NOW,');
      log('  *** then see incident_2026-08-18_automation_emails/README.md');
      throw new Error(`automation guard failed: ${mine[0].n} events exist for rows this run touched`);
    }
    log('  the automation guard held: not one event was emitted for our rows');

    const { rows: ae1 } = await v2.query('select count(*)::bigint n from automation_events where org_id=$1', [M.ORG_V2]);
    const delta = BigInt(ae1[0].n) - BigInt(ae0[0].n);
    log(`  org-wide automation_events: ${ae0[0].n} -> ${ae1[0].n}  (delta ${delta})`);
    log('  that delta is ordinary live CRM traffic from other sessions, not this run -');
    log('  the per-row check above is what proves this run emitted nothing.');

    {
      // On a dry run this still reports honestly: the rows exist inside the open
      // transaction, so a wrong count here means the import itself is wrong.
      const { rows: chk } = await v2.query(`
        select count(*)::int n from v2_leads where v1_lead_id = any($1::int[])`, [leads.map(l => l.v1_lead_id)]);
      log(`  v2_leads present for exported v1 ids: ${chk[0].n} / ${leads.length}`);
      const { rows: ugchk } = await v2.query(`
        select count(*)::int n from under_graduate ug join v2_leads l on l.id = ug.lead_id
        where ug.v1_lead_id = any($1::int[])`, [ugLead.map(r => r.v1_lead_id)]);
      log(`  under_graduate rows attached to a live lead: ${ugchk[0].n} / ${ugLead.length}`);
      if (ugBackfill.length) {
        const { rows: bf } = await v2.query(
          'select count(distinct lead_id)::int n from under_graduate where lead_id = any($1::bigint[])',
          [ugBackfill.map(b => b.v2_lead_id)]);
        log(`  backfilled applicants that now have a form row: ${bf[0].n} / ${ugBackfill.length}`);
      }
      if (trackers.length) {
        const { rows: tk } = await v2.query(
          'select count(*)::int n from "ApplicationActivityTrackers" where "v1_leadId" = any($1::int[])',
          [trackers.map(t => t.v1_leadId)]);
        log(`  activity trackers present: ${tk[0].n} / ${trackers.length}`);
      }
      if (timelines.length) {
        // bounded by created_at so the planner can prune the 79 GB default partition
        const times = timelines.map(t => new Date(t.created_at).getTime());
        const lo = new Date(Math.min(...times)); lo.setUTCDate(1); lo.setUTCHours(0, 0, 0, 0);
        const hi = new Date(Math.max(...times)); hi.setUTCMonth(hi.getUTCMonth() + 1, 1); hi.setUTCHours(0, 0, 0, 0);
        const { rows: tchk } = await v2.query(
          `select count(*)::int n from timelines
            where created_at >= $2 and created_at < $3 and v1_timeline_id = any($1::bigint[])`,
          [timelines.map(t => t.v1_timeline_id), lo, hi]);
        log(`  timelines present: ${tchk[0].n} / ${timelines.length}`);
      }
    }

    // close the enclosing dry-run transaction - nothing survives
    if (!APPLY) {
      await v2.query('rollback');
      log('\n  dry-run transaction ROLLED BACK - the database is unchanged');
      const { rows: post } = await v2.query(
        'select count(*)::int n from v2_leads where v1_lead_id = any($1::int[])', [leads.map(l => l.v1_lead_id)]);
      log(`  confirmed: ${post[0].n} of ${leads.length} exported leads exist in v2 after rollback (expected 0)`);
      if (post[0].n !== 0) throw new Error('rollback did not undo the dry run - investigate immediately');
    }

    // ---------------------------------------------------------------- 10. artefacts
    if (APPLY) {
      writeRollback();
      fs.writeFileSync(path.join(RUNDIR, 'summary.json'), JSON.stringify({
        runTs: RUN_TS, exportRun: runId, applied: true, summary,
        automationEventsBefore: ae0[0].n, automationEventsAfter: ae1[0].n,
      }, null, 2));
      log(`\n  run artefacts: ${RUNDIR}`);
      log('    rollback.sql, summary.json' + (fs.existsSync(path.join(RUNDIR, 'backup_promotions.json')) ? ', backup_promotions.json' : ''));
    }

    hr(APPLY ? 'IMPORT COMPLETE (COMMITTED)' : 'DRY RUN COMPLETE (nothing was committed)');
    for (const [k, v] of Object.entries(summary)) log(`  ${k.padEnd(20)} ${v}`);
    if (!APPLY) log('\n  Re-run with --apply to commit.');
  } finally {
    await v2.end();
  }
})().catch(e => { console.error('\nIMPORT FAILED:', e.message); console.error(e.stack); process.exit(1); });

/**
 * A stable UUIDv5-style value derived from a seed, so re-running the import reuses
 * the same uuid for the same v1 row instead of minting a new one.
 */
function deterministicUuid(seed) {
  const h = crypto.createHash('sha1').update(seed).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;          // version 5
  b[8] = (b[8] & 0x3f) | 0x80;          // RFC 4122 variant
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** columns worth restoring in a rollback UPDATE */
function p0(row) {
  const keys = ['type', 'v1_application_id', 'v1_user_id', 'application_number', 'application_stage_id',
    'application_form_initiated', 'application_form_submitted', 'application_registered_on',
    'last_interacted_section', 'form_completion_date', 'form_percentage_filled', 'payment_status',
    'payment_initiated', 'payment_method', 'is_payment_done', 'payment_mode', 'applicant_status',
    'user_id', 'updated_at'];
  const o = {};
  for (const k of keys) o[k] = row[k];
  return o;
}
function sqlLit(v, col) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return `'${v.toISOString()}'`;
  const s = String(v).replace(/'/g, "''");
  return col === 'type' ? `'${s}'::enum_v2_leads_type` : `'${s}'`;
}
