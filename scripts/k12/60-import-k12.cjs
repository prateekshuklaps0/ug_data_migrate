/**
 * K12 IMPORT - the only script here that writes.
 *
 *   node scripts/k12/60-import-k12.cjs             # DRY RUN (default): everything rolled back
 *   node scripts/k12/60-import-k12.cjs --apply     # commits, phase by phase
 *   node scripts/k12/60-import-k12.cjs --run <id>  # pick an export folder (default: newest)
 *   node scripts/k12/60-import-k12.cjs --restart   # ignore the checkpoint
 *
 * Safety, in order of importance:
 *  1. `SET app.skip_automation = 'true'` at SESSION level, verified to read back, before any
 *     write, and re-verified after every COMMIT. Without it the trigger on v2_leads wakes the
 *     workflow engine: workflow 82 "UG Login Cred" is published on lead_create for school 18
 *     with NO form filter, so it would email every lead this script inserts. That is the
 *     2026-08-18 incident (6,388 emails).
 *  2. Every write is idempotent through a real unique index, so a re-run inserts nothing twice:
 *       users ON CONFLICT (v1_id) · tags ON CONFLICT (org_id, name) · v2_leads ON CONFLICT
 *       (v1_lead_id) · under_graduate ON CONFLICT (v1_lead_id) · lead_tags ON CONFLICT
 *       (v2_lead_id, tag_id) · notes ON CONFLICT (v1_note_id) · ApplicationActivityTrackers
 *       ON CONFLICT (v1_leadId) · leadScoreHistory ON CONFLICT (leadId, dedupeKey) ·
 *       timelines pre-filtered on v1_timeline_id (its unique index is INVALID because
 *       timelines_p202605 is detached).
 *  3. INSERT ONLY. This script never UPDATEs or DELETEs anything, so no value a live user
 *     set can be overwritten. That is true on a re-run as well: leads already in v2 are
 *     offered only their MISSING satellites. Changing a column on a lead that is already in
 *     v2 is a different job, with different rules, and lives in 70-delta-k12.cjs.
 *  4. On --apply each phase is its own short transaction, in batches, so nothing holds locks
 *     on tables the live CRM is using. A dry run wraps every phase in ONE transaction and
 *     rolls it back, so later phases still see the ids earlier ones created.
 *  5. The leads we insert get brand-new ids, so ANY automation_events row naming one of them
 *     can only have come from this import. That count must be 0, and it is checked per phase.
 *  6. Each committed phase appends to runs/<ts>/rollback.sql and updates checkpoint.json.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { connect, armAutomationGuard } = require('../lib/db.cjs');
const { Progress } = require('../lib/progress.cjs');
const K = require('./lib-k12.cjs');
const bcrypt = require('C:/Users/Prateek/Desktop/Repos/new_crm_backend/node_modules/bcryptjs');

/** Same policy v2 enforces for an admin password: 8-16 chars, >=1 digit, >=1 upper, >=1 lower. */
const generatePassword = () => {
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', Lo = 'abcdefghijkmnopqrstuvwxyz', D = '23456789', S = '!@#$%*?';
  const pick = set => set[crypto.randomInt(set.length)];
  const chars = [pick(U), pick(Lo), pick(D), pick(S)];
  const all = U + Lo + D + S;
  while (chars.length < 14) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    const t = chars[i]; chars[i] = chars[j]; chars[j] = t;
  }
  return chars.join('');
};

const REPOS = 'C:/Users/Prateek/Desktop/Repos';
const ROOT = path.join(REPOS, 'data', 'k12');
const BATCH = 500;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const RESTART = args.includes('--restart');
const runArg = args.includes('--run') ? args[args.indexOf('--run') + 1] : null;

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(84) + '\n' + t + '\n' + '='.repeat(84));
const readNd = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const deterministicUuid = seed => {
  const h = crypto.createHash('sha1').update('k12-v1-score-history').update(seed).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
};

function insertSql(table, cols, rowCount, conflict, returning) {
  const vals = [];
  let i = 1;
  for (let r = 0; r < rowCount; r++) vals.push('(' + cols.map(() => `$${i++}`).join(',') + ')');
  return `INSERT INTO "${table}" (${cols.map(c => `"${c}"`).join(',')}) VALUES ${vals.join(',')} ${conflict} ${returning || ''}`;
}

async function insertBatched(client, { table, cols, rows, conflict, returning, label, cast = {} }) {
  const got = [];
  const p = new Progress(rows.length || 1, label);
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const binds = [];
    for (const r of chunk) for (const c of cols) binds.push(r[c] === undefined ? null : r[c]);
    const castAt = new Map();
    for (const [col, type] of Object.entries(cast)) {
      const idx = cols.indexOf(col);
      if (idx === -1) continue;
      for (let r = 0; r < chunk.length; r++) castAt.set(r * cols.length + idx + 1, type);
    }
    let sql = insertSql(table, cols, chunk.length, conflict, returning);
    if (castAt.size) sql = sql.replace(/\$(\d+)/g, (m, n) => castAt.has(Number(n)) ? `${m}::${castAt.get(Number(n))}` : m);
    const res = await client.query(sql, binds);
    if (returning) got.push(...res.rows);
    p.tick(chunk.length);
  }
  p.done();
  return got;
}

(async () => {
  if (!fs.existsSync(ROOT)) throw new Error(`no export folder at ${ROOT} - run the export first`);
  const runs = fs.readdirSync(ROOT).filter(d => fs.statSync(path.join(ROOT, d)).isDirectory()).sort();
  const runId = runArg || runs[runs.length - 1];
  if (!runId || !runs.includes(runId)) throw new Error(`export run "${runId}" not found. available: ${runs.join(', ')}`);
  const DIR = path.join(ROOT, runId);

  hr(`K12 IMPORT   ${APPLY ? '*** APPLY - this COMMITS ***' : 'DRY RUN (everything is rolled back)'}`);
  log(`  export run : ${DIR}`);

  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  let bad = 0;
  for (const [name, meta] of Object.entries(manifest.files)) {
    const f = path.join(DIR, name);
    if (!fs.existsSync(f)) { log(`  MISSING ${name}`); bad++; continue; }
    if (sha256(f) !== meta.sha256) { log(`  CHECKSUM MISMATCH ${name}`); bad++; }
  }
  if (bad) throw new Error(`${bad} export file(s) failed verification - refusing to import`);
  log(`  exported   : ${manifest.generatedAt}   checksums: all ${Object.keys(manifest.files).length} files verified`);

  const staff = readNd(path.join(DIR, 'staff.ndjson'));
  const students = readNd(path.join(DIR, 'students.ndjson'));
  const tagsCreate = readNd(path.join(DIR, 'tags_create.ndjson'));
  const leads = readNd(path.join(DIR, 'leads.ndjson'));
  // Leads the export found ALREADY in v2. This script does not touch their columns - that
  // is 70-delta-k12.cjs - but their v2 ids are needed here, because a lead migrated last
  // week can have picked up a new note, tag, timeline or score row in v1 since, and those
  // inserts have to find their lead.
  const deltaLeads = readNd(path.join(DIR, 'delta_leads.ndjson'));
  const ug = readNd(path.join(DIR, 'under_graduate.ndjson'));
  const tagLinks = readNd(path.join(DIR, 'lead_tags.ndjson'));
  const timelines = readNd(path.join(DIR, 'timelines.ndjson'));
  const notes = readNd(path.join(DIR, 'notes.ndjson'));
  const trackers = readNd(path.join(DIR, 'activity_trackers.ndjson'));
  const scoreHistory = readNd(path.join(DIR, 'lead_score_history.ndjson'));
  log(`  payload    : ${leads.length} leads, ${ug.length} form rows, ${timelines.length} timelines, ${notes.length} notes, ` +
      `${tagLinks.length} tag links, ${trackers.length} trackers, ${scoreHistory.length} score rows, ${staff.length} staff, ${students.length} students`);
  if (deltaLeads.length) {
    log(`  already in v2: ${deltaLeads.length} lead(s) - this script will only add their MISSING satellites.`);
    log('                 To update their columns, run 70-delta-k12.cjs after this.');
  }

  const RUN_TS = new Date().toISOString().replace(/[:.]/g, '-');
  const RUNDIR = path.join(DIR, 'runs', RUN_TS);
  fs.mkdirSync(RUNDIR, { recursive: true });

  const CKPT_FILE = path.join(DIR, 'checkpoint.json');
  let ckpt = { exportRun: runId, manifestSha: sha256(path.join(DIR, 'manifest.json')), phases: {} };
  if (fs.existsSync(CKPT_FILE) && !RESTART) {
    const onDisk = JSON.parse(fs.readFileSync(CKPT_FILE, 'utf8'));
    if (onDisk.manifestSha !== ckpt.manifestSha) log('  checkpoint: found one for a DIFFERENT export payload - ignoring it');
    else {
      ckpt = onDisk;
      const done = Object.keys(ckpt.phases).filter(k => ckpt.phases[k].done);
      if (done.length) {
        log(`  checkpoint: ${done.length} phase(s) already committed in an earlier run - they will be SKIPPED:`);
        done.forEach(k => log(`      ${k.padEnd(22)} at ${ckpt.phases[k].at}`));
      }
    }
  } else if (RESTART && fs.existsSync(CKPT_FILE)) log('  checkpoint: --restart given, ignoring it');

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

  const writeRollback = () => {
    if (!APPLY) return;
    fs.writeFileSync(path.join(RUNDIR, 'rollback.sql'),
      ['-- Rollback for K12 import run ' + RUN_TS,
        '-- Review before running. Execute exactly as written, in this order.',
        '-- under_graduate has NO foreign key to v2_leads, so its rows are deleted FIRST;',
        '-- timelines, notes, lead_tags, trackers and score history cascade from v2_leads,',
        '-- so their DELETEs are belt and braces.',
        "-- app.skip_automation must be set, or the deletes themselves can emit events.",
        'BEGIN;', "SET app.skip_automation = 'true';",
        ...rollback.slice().reverse(), 'COMMIT;'].join('\n') + '\n');
  };

  /** Any automation_events row naming a lead we just inserted can only be ours. */
  const assertNoEvents = async (ids, where) => {
    if (!ids.length) return 0;
    let n = 0;
    for (let i = 0; i < ids.length; i += 20000) {
      const { rows } = await v2.query(
        `select count(*)::int n from automation_events where table_name = 'v2_leads' and row_id = any($1::bigint[])`,
        [ids.slice(i, i + 20000)]);
      n += rows[0].n;
    }
    if (n > 0) throw new Error(`${n} automation_events row(s) exist for the leads this import inserted (${where}) - STOPPING. Pause workflow 82 and read incident_2026-08-18_automation_emails/README.md`);
    return n;
  };

  const phase = async (key, name, fn) => {
    phaseNo++;
    hr(`${phaseNo}. ${name}`);
    if (phaseDone(key)) { log(`  SKIPPED - committed at ${ckpt.phases[key].at}`); summary[key] = 'SKIPPED (checkpoint)'; return; }
    if (APPLY) await v2.query('begin');
    const rbMark = rollback.length;
    try {
      const out = await fn();
      if (APPLY) { await v2.query('commit'); log('  committed'); markPhase(key, { ...summary }); writeRollback(); }
      else log('  (held inside the dry-run transaction)');
      const { rows } = await v2.query(`select current_setting('app.skip_automation', true) as v`);
      if (rows[0].v !== 'true') throw new Error('app.skip_automation is no longer true - aborting');
      return out;
    } catch (e) {
      if (APPLY) await v2.query('rollback').catch(() => {});
      rollback.length = rbMark;
      writeRollback();
      if (APPLY && rollback.length) {
        log(`\n  *** ${rollback.length} statement(s) from COMMITTED phases are in ${path.join(RUNDIR, 'rollback.sql')}`);
        log('  *** Re-running --apply is safe: every write is idempotent.');
      }
      throw e;
    }
  };

  try {
    hr('0. automation guard');
    await armAutomationGuard(v2);
    const { rows: [g] } = await v2.query(`select current_setting('app.skip_automation', true) as v`);
    if (g.v !== 'true') throw new Error('could not arm the automation guard');
    const { rows: [base] } = await v2.query('select coalesce(max(id), 0)::bigint mx from automation_events');
    log(`  app.skip_automation = "${g.v}" (verified)   automation_events baseline id ${base.mx}`);
    const { rows: [wf] } = await v2.query(
      `select count(*)::int n from workflows w where w.org_id = $1 and lower(w.status) in ('active','published')
         and (w.school_id = $2 or w.school_id is null)
         and exists (select 1 from nodes n where n.workflow_id = w.id and n.type in ('email','whatsapp','sms'))`,
      [K.V2.org, K.V2.school]);
    log(`  ${wf.n} live comms workflow(s) could match these leads - the guard is what stops them`);
    if (!APPLY) await v2.query('begin');

    // ------------------------------------------------------------------ 1. staff
    const staffMap = new Map();      // v1 user id -> v2 id
    await phase('staff', 'staff accounts, through v2 own user-creation flow (' + staff.length + ')', async () => {
      const F = K.USER_FLOW;
      let createdCount = 0;
      for (const s of staff) {
        // 1. the users row. A generated strong password, hashed the way v2 hashes it
        //    (bcryptjs, 10 rounds). The v1 hash is NOT reused - different system - and the
        //    onboarding email createUser() sends is NOT sent, because we never call the API.
        //    If either person needs to sign in, set a password from User Management.
        const { rows: ex } = await v2.query(
          "select id from users where v1_id = $1 or (lower(email) = $2 and role not in ('student','super_admin')) order by (v1_id is null) limit 1",
          [s.v1_id, s.email]);
        let uid = ex.length ? Number(ex[0].id) : null;
        if (uid) log('  ' + s.email + ' already exists as v2 ' + uid + ' - reused, exactly as createUser() does');
        else {
          const hash = bcrypt.hashSync(generatePassword(), F.bcryptRounds);
          const ins = await v2.query(
            'insert into users (email, password_hash, role, status, name, phone, country_code, country_iso,'
            + ' organization_id, user_type, v1_id, login_count, created_at, updated_at)'
            + ' values ($1,$2,$3::enum_users_role,$4::enum_users_status,$5,$6,$7,$8,$9,$10::enum_users_user_type,$11,0,$12,$13)'
            + ' returning id',
            [s.email, hash, F.role, F.status, s.name, s.phone, s.country_code, F.countryIso,
              K.V2.org, F.userType, s.v1_id, s.created_at, s.updated_at]);
          uid = Number(ins.rows[0].id);
          createdCount += 1;
          rollback.push('DELETE FROM users WHERE id = ' + uid + '; -- ' + s.email);
        }
        staffMap.set(s.v1_id, uid);
        const w = s.wiring;

        // 2. organisation membership. Without this row the account does not appear in
        //    User Management at all, however correct the users row looks.
        const om = await v2.query(
          "select id from org_users where user_id = $1 and org_id = $2 and status <> 'removed'", [uid, K.V2.org]);
        if (!om.rows.length) {
          const o = await v2.query(
            'insert into org_users (org_id, user_id, org_role, features, status, display_name, display_email,'
            + " is_primary, invited_by, created_at, updated_at) values ($1,$2,$3,'{}','active',$4,$5,true,$6,now(),now())"
            + ' returning id',
            [K.V2.org, uid, w.orgRole, w.displayName, w.displayEmail, w.invitedBy]);
          rollback.push('DELETE FROM org_users WHERE id = ' + o.rows[0].id + ';');
        }

        // 3. role, school, programme and form access - each on its own unique key, so a
        //    re-run adds nothing twice. K12 is a PROGRAMME under school 18, so the account
        //    is scoped to program 123 / form 128 rather than the whole school.
        const link = async (table, keys, vals, conflict) => {
          const ph = vals.map((_, i) => '$' + (i + 1)).join(',');
          const r = await v2.query('insert into ' + table + ' (' + keys.join(',') + ', created_at, updated_at) values ('
            + ph + ', now(), now()) ' + conflict + ' returning id', vals);
          if (r.rows.length) rollback.push('DELETE FROM ' + table + ' WHERE id = ' + r.rows[0].id + ';');
        };
        for (const rid of w.roleIds) await link('user_roles', ['user_id', 'role_id', 'is_active'], [uid, rid, true], 'ON CONFLICT (user_id, role_id) DO NOTHING');
        for (const sid of w.schoolIds) await link('user_schools', ['user_id', 'school_id'], [uid, sid], 'ON CONFLICT (user_id, school_id) DO NOTHING');
        for (const pid of w.programIds) await link('user_programs', ['user_id', 'program_id', 'org_id'], [uid, pid, K.V2.org], 'ON CONFLICT (user_id, program_id) DO NOTHING');
        for (const fid of w.formIds) await link('user_application_forms', ['user_id', 'form_id', 'org_id'], [uid, fid, K.V2.org], 'ON CONFLICT (user_id, form_id) DO NOTHING');

        // 4. the audit entry createUser() writes, so the account has a provenance trail
        const al = await v2.query(
          'insert into audit_logs (actor_id, actor_email, target_type, target_id, action, after, org_id, created_at)'
          + " values ($1,$2,'user',$3,$4,$5::jsonb,$6,now()) returning id",
          [F.actorUserId, F.actorEmail, String(uid), ex.length ? 'user.attachToOrg' : 'user.create',
            JSON.stringify({ userId: uid, email: s.email, orgId: K.V2.org, roleIds: w.roleIds, schoolIds: w.schoolIds,
              programIds: w.programIds, formIds: w.formIds, managerIds: [], reusedExistingUser: ex.length > 0,
              source: 'K12 migration - scripts/k12/60-import-k12.cjs' }), K.V2.org]);
        rollback.push('DELETE FROM audit_logs WHERE id = ' + al.rows[0].id + ';');
        log('  ' + s.email + ' -> v2 ' + uid + '   role ' + w.roleIds.join(',') + ' | school ' + w.schoolIds.join(',')
          + ' | program ' + w.programIds.join(',') + ' | form ' + w.formIds.join(','));
      }
      log('  ' + createdCount + ' account(s) created, ' + (staff.length - createdCount) + ' reused. No onboarding email was sent.');
      summary.staff = createdCount;
    });

    // rebuild unconditionally, so a resumed run still has the map
    for (const s of staff) {
      const { rows } = await v2.query('select id from users where v1_id = $1 or lower(email) = lower($2) order by (v1_id is null) limit 1', [s.v1_id, s.email]);
      if (rows.length) staffMap.set(s.v1_id, Number(rows[0].id));
      else if (APPLY) throw new Error(`staff v1 ${s.v1_id} (${s.email}) is still not in v2 - cannot resolve the leads they own`);
    }
    for (const s of students) {
      const { rows } = await v2.query('select id from users where v1_id = $1 or lower(email) = lower($2) order by (v1_id is null) limit 1', [s.v1_id, s.email]);
      if (rows.length) staffMap.set(s.v1_id, Number(rows[0].id));
    }

    // ------------------------------------------------------------------ 2. tags
    const tagIdByName = new Map();
    await phase('tags', `tag names to create (${tagsCreate.length})`, async () => {
      const rows = tagsCreate.map(t => ({ ...t, created_at: new Date(), updated_at: new Date() }));
      const got = rows.length ? await insertBatched(v2, {
        table: 'tags', cols: ['org_id', 'name', 'v1_tag_id', 'created_at', 'updated_at'], rows, label: 'tags',
        conflict: 'ON CONFLICT (org_id, name) DO NOTHING', returning: 'RETURNING id, name',
      }) : [];
      got.forEach(r => rollback.push(`DELETE FROM tags WHERE id = ${r.id}; -- ${r.name}`));
      log(`  inserted ${got.length} of ${rows.length}${got.length ? ': ' + got.map(r => r.name).join(', ') : ''}`);
      summary.tags = got.length;
    });
    {
      const names = [...new Set(tagLinks.map(t => t.tag_name))];
      if (names.length) {
        const { rows } = await v2.query('select id, name from tags where org_id = $1 and lower(btrim(name)) = any($2::text[])',
          [K.V2.org, names.map(n => n.toLowerCase())]);
        rows.forEach(r => tagIdByName.set(r.name.trim().toLowerCase(), Number(r.id)));
      }
      const unresolved = names.filter(n => !tagIdByName.has(n.toLowerCase()));
      if (unresolved.length && APPLY) throw new Error(`tag name(s) still missing in v2: ${unresolved.join(', ')}`);
      if (unresolved.length) log(`  dry run: ${unresolved.length} tag name(s) would exist only after the tags phase commits`);
    }

    // ------------------------------------------------------------------ 3. leads
    const leadMap = new Map();       // v1 lead id -> v2 lead id
    let freshLeads = 0;              // how many leads THIS run inserted
    await phase('leads', `v2_leads (${leads.length})`, async () => {
      const rows = leads.map(l => {
        const r = { ...l };
        const pend = r._v1 && r._v1.counsellorPendingV1Id;
        if (!r.counsellor_id && pend) r.counsellor_id = staffMap.get(pend) ?? null;
        if (!r.user_id && r._v1 && r._v1.studentV1Id) r.user_id = staffMap.get(r._v1.studentV1Id) ?? null;
        delete r._v1;
        return r;
      });
      const cols = Object.keys(rows[0] || {});
      for (const r of rows) {
        if (r.org_id !== K.V2.org || r.school_id !== K.V2.school || r.form_id !== K.V2.form ||
            r.program_id !== K.V2.program || r.batch_id !== K.V2.batch || r.round_id !== K.V2.round) {
          throw new Error(`lead ${r.v1_lead_id} is not scoped to the agreed org/school/program/form/batch/round - refusing`);
        }
        if (r.is_deleted !== false) throw new Error(`lead ${r.v1_lead_id} is marked deleted - out of scope`);
      }
      const got = rows.length ? await insertBatched(v2, {
        table: 'v2_leads', cols, rows, label: 'v2_leads',
        conflict: 'ON CONFLICT (v1_lead_id) WHERE v1_lead_id IS NOT NULL DO NOTHING',
        returning: 'RETURNING id, v1_lead_id',
        cast: { lead_payload: 'json', automation_tags: 'text[]', type: 'enum_v2_leads_type',
          lead_type: 'enum_v2_leads_lead_type', final_decision: 'enum_v2_leads_final_decision' },
      }) : [];
      got.forEach(r => { leadMap.set(r.v1_lead_id, Number(r.id)); rollback.push(`DELETE FROM v2_leads WHERE id = ${r.id}; -- v1_lead_id ${r.v1_lead_id}`); });
      freshLeads = got.length;
      log(`  inserted ${got.length} of ${rows.length}${got.length !== rows.length ? `  (${rows.length - got.length} already existed)` : ''}`);
      const withCounsellor = rows.filter(r => r.counsellor_id).length;
      log(`  counsellor set on ${withCounsellor}, unassigned ${rows.length - withCounsellor}`);
      summary.leads = got.length;
      await assertNoEvents([...leadMap.values()], 'leads phase');
    });
    // rebuild the lead map from v2, so a resumed run can continue. Both piles go in: the
    // leads this run inserted AND the ones that were already there, re-read from v2 rather
    // than trusted from the file, so a lead deleted since the export cannot be written to.
    {
      const ids = [...leads.map(l => l.v1_lead_id), ...deltaLeads.map(l => l.v1_lead_id)];
      for (let i = 0; i < ids.length; i += 20000) {
        const { rows } = await v2.query(
          'select id, v1_lead_id from v2_leads where v1_lead_id = any($1::int[]) and is_deleted = false',
          [ids.slice(i, i + 20000)]);
        rows.forEach(r => leadMap.set(r.v1_lead_id, Number(r.id)));
      }
      const newResolved = leads.filter(l => leadMap.has(l.v1_lead_id)).length;
      log(`  lead map: ${leadMap.size} of ${ids.length} resolved (${newResolved} of ${leads.length} newly inserted` +
          (deltaLeads.length ? `, ${leadMap.size - newResolved} already in v2` : '') + ')');
      if (APPLY && newResolved !== leads.length) throw new Error('the lead map is incomplete - use --restart rather than continue with a half-built map');
    }

    // ------------------------------------------------------------------ 4. under_graduate
    await phase('under_graduate', `form table rows (${ug.length})`, async () => {
      const rows = ug.map(r => ({ ...r, lead_id: leadMap.get(r.v1_lead_id) ?? null })).filter(r => r.lead_id !== null);
      // The column list comes from the export, which decided it against LIVE v2 - the
      // lead columns (city, state, grade) plus whatever widget-answer columns exist there
      // (current_grade_class, professional_qualification, ... and school_and_city if it has
      // been created). Re-checked here, so a column dropped since the export cannot break
      // the insert.
      const cols = manifest.ugColumns ||
        ['org_id', 'lead_id', 'v1_lead_id', 'city', 'state', 'grade', 'created_at', 'updated_at'];
      {
        const live = new Set((await v2.query(
          "select column_name from information_schema.columns where table_schema = 'public' and table_name = $1",
          ['under_graduate'])).rows.map(r => r.column_name));
        const gone = cols.filter(c => !live.has(c));
        if (gone.length) throw new Error('under_graduate no longer has ' + gone.join(', ') + ' - re-run the export');
        const extra = cols.filter(c => !['org_id', 'lead_id', 'v1_lead_id', 'created_at', 'updated_at'].includes(c));
        log('  columns: ' + extra.join(', '));
        const filled = new Map();
        for (const r of rows) for (const c of extra) if (r[c] !== null && r[c] !== undefined && String(r[c]).trim() !== '') filled.set(c, (filled.get(c) || 0) + 1);
        [...filled.entries()].sort((a, b) => b[1] - a[1]).forEach(([c, n]) => log('    ' + c.padEnd(28) + String(n).padStart(6) + ' row(s) have a value'));
      }
      const got = rows.length ? await insertBatched(v2, {
        table: 'under_graduate', cols, rows, label: 'under_graduate',
        conflict: 'ON CONFLICT (v1_lead_id) WHERE v1_lead_id IS NOT NULL DO NOTHING',
        returning: 'RETURNING id, v1_lead_id',
      }) : [];
      got.forEach(r => rollback.push(`DELETE FROM under_graduate WHERE id = ${r.id}; -- v1_lead_id ${r.v1_lead_id}`));
      log(`  inserted ${got.length} of ${rows.length}`);
      summary.under_graduate = got.length;
    });

    // ------------------------------------------------------------------ 5. lead_tags
    await phase('lead_tags', `tag links (${tagLinks.length})`, async () => {
      const rows = [];
      const seen = new Set();
      let noTag = 0, noLead = 0;
      for (const t of tagLinks) {
        const v2LeadId = leadMap.get(t.v1_lead_id);
        const tagId = t.tag_id ?? tagIdByName.get(t.tag_name.toLowerCase()) ?? null;
        if (!v2LeadId) { noLead++; continue; }
        if (!tagId) { noTag++; continue; }
        const k = `${v2LeadId}|${tagId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({ v2_lead_id: v2LeadId, lead_id: null, tag_id: tagId, org_id: K.V2.org, school_id: K.V2.school,
          v1_lead_id: t.v1_lead_id, created_at: new Date(), updated_at: new Date() });
      }
      if (noTag) log(`  ${noTag} link(s) have no v2 tag yet (dry run only - the tags phase was rolled back)`);
      if (deltaLeads.length) log(`  (links for the ${deltaLeads.length} already-migrated lead(s) are offered too; ON CONFLICT drops the ones already there)`);
      if (noLead) log(`  ${noLead} link(s) point at a lead that is not in v2`);
      const cols = ['v2_lead_id', 'lead_id', 'tag_id', 'org_id', 'school_id', 'v1_lead_id', 'created_at', 'updated_at'];
      const got = rows.length ? await insertBatched(v2, {
        table: 'lead_tags', cols, rows, label: 'lead_tags',
        conflict: 'ON CONFLICT (v2_lead_id, tag_id) WHERE v2_lead_id IS NOT NULL DO NOTHING',
        returning: 'RETURNING id',
      }) : [];
      got.forEach(r => rollback.push(`DELETE FROM lead_tags WHERE id = ${r.id};`));
      log(`  inserted ${got.length} of ${rows.length}`);
      summary.lead_tags = got.length;
    });

    // ------------------------------------------------------------------ 6. timelines
    await phase('timelines', `timelines (${timelines.length})`, async () => {
      // timelines_v1_timeline_id_uniq is INVALID (timelines_p202605 is detached), so
      // ON CONFLICT cannot use it. Pre-filter instead - but ask the question the cheap
      // way round: which timelines does v2 ALREADY hold for these leads? That uses the
      // per-partition v2_lead_id index, instead of scanning the 79 GB default partition
      // for 93k v1 ids. Skipped entirely when every lead was inserted by this very run,
      // because a lead created seconds ago cannot already own a timeline.
      const already = new Set();
      const leadIdsForTl = [...leadMap.values()];
      if (freshLeads < leadIdsForTl.length) {
        for (let i = 0; i < leadIdsForTl.length; i += 2000) {
          const { rows } = await v2.query(
            `select v1_timeline_id from timelines where v2_lead_id = any($1::bigint[]) and v1_timeline_id is not null`,
            [leadIdsForTl.slice(i, i + 2000)]);
          rows.forEach(r => already.add(Number(r.v1_timeline_id)));
        }
      } else {
        log('  every lead was inserted by this run, so none of them can own a timeline yet - no duplicate check needed');
      }
      if (already.size) log(`  ${already.size} timeline(s) are already in v2 - skipping them`);
      const rows = timelines
        .filter(t => !already.has(Number(t.v1_timeline_id)))
        .map(t => ({ ...t, v2_lead_id: leadMap.get(t.v1_lead_id) ?? null }))
        .filter(t => t.v2_lead_id !== null);
      // v2.timelines is partitioned by month. Assert every row lands in an ATTACHED
      // monthly partition and never in timelines_pdefault - which is exactly what the
      // 3-month window exists to guarantee.
      const parts = (await v2.query(
        "select c.relname nm, pg_get_expr(c.relpartbound, c.oid) bound from pg_inherits i"
        + " join pg_class c on c.oid = i.inhrelid where i.inhparent = 'timelines'::regclass")).rows;
      const monthly = new Set();
      for (const p of parts) {
        const isDefault = String(p.bound || '').toUpperCase().includes('DEFAULT');
        if (!isDefault && p.nm.startsWith('timelines_p')) monthly.add(p.nm.slice(-6));
      }
      const monthOf = d => {
        const x = new Date(d);
        return String(x.getUTCFullYear()) + String(x.getUTCMonth() + 1).padStart(2, '0');
      };
      const landing = new Map();
      for (const t of rows) { const m = monthOf(t.created_at); landing.set(m, (landing.get(m) || 0) + 1); }
      const homeless = [...landing.keys()].filter(m => !monthly.has(m));
      if (homeless.length) {
        throw new Error('timelines dated ' + homeless.join(', ') + ' have no attached monthly partition, so they'
          + ' would fall into timelines_pdefault. Create the partition(s) first, or narrow the window.');
      }
      [...landing.entries()].sort().forEach(e => log('  -> timelines_p' + e[0] + ': ' + e[1] + ' row(s)'));
      const cols = ['org_id', 'school_id', 'v2_lead_id', 'lead_id', 'v1_lead_id', 'v1_timeline_id', 'event_type',
        'title', 'description', 'metadata', 'lead_stage_id', 'template_id', 'v1_counsellor_id', 'created_by', 'created_at', 'updated_at'];
      const got = rows.length ? await insertBatched(v2, {
        table: 'timelines', cols, rows, label: 'timelines', conflict: '', returning: 'RETURNING id',
        cast: { metadata: 'jsonb', v1_timeline_id: 'bigint' },
      }) : [];
      log(`  inserted ${got.length} of ${rows.length}   (authored ${rows.filter(r => r.created_by).length})`);
      if (rows.length) rollback.push(`DELETE FROM timelines WHERE v1_timeline_id = ANY(ARRAY[${rows.map(t => t.v1_timeline_id).join(',')}]::bigint[]);`);
      summary.timelines = got.length;
    });

    // ------------------------------------------------------------------ 7. notes
    await phase('notes', `notes (${notes.length})`, async () => {
      const rows = [], held = [];
      for (const n of notes) {
        const v2LeadId = leadMap.get(n.v1_lead_id);
        const admin = n.admin_id ?? (n._pendingAdminV1Id ? staffMap.get(n._pendingAdminV1Id) ?? null : null);
        if (!v2LeadId || !admin || n.content === null || n.content === '') { held.push(n.v1_note_id); continue; }
        rows.push({ org_id: n.org_id, school_id: n.school_id, v2_lead_id: v2LeadId, lead_id: null,
          v1_lead_id: n.v1_lead_id, v1_note_id: n.v1_note_id, content: n.content, admin_id: admin,
          v1_counsellor_id: n.v1_counsellor_id, created_at: n.created_at, updated_at: n.updated_at });
      }
      if (held.length) log(`  ${held.length} note(s) held back (no author, no content, or lead missing): ${held.join(',')}`);
      const cols = ['org_id', 'school_id', 'v2_lead_id', 'lead_id', 'v1_lead_id', 'v1_note_id', 'content', 'admin_id', 'v1_counsellor_id', 'created_at', 'updated_at'];
      const got = rows.length ? await insertBatched(v2, {
        table: 'notes', cols, rows, label: 'notes',
        conflict: 'ON CONFLICT (v1_note_id) WHERE v1_note_id IS NOT NULL DO NOTHING', returning: 'RETURNING id, v1_note_id',
      }) : [];
      got.forEach(r => rollback.push(`DELETE FROM notes WHERE id = ${r.id}; -- v1_note_id ${r.v1_note_id}`));
      log(`  inserted ${got.length} of ${rows.length}`);
      summary.notes = got.length;
    });

    // ------------------------------------------------------------------ 8. trackers
    await phase('trackers', `activity trackers (${trackers.length})`, async () => {
      const rows = trackers.map(t => ({ ...t, leadId: leadMap.get(t.v1_leadId) ?? null })).filter(t => t.leadId !== null);
      const cols = ['leadId', 'v1_leadId', 'v1_applicationId', 'applicationForm_start_date', 'payment_Initiated_date',
        'payment_last_Initiated_date', 'counsellor_first_activity_date', 'counsellor_last_activity_date',
        'application_fee_paidOn', 'application_last_activity_date', 'lastLeadStageUpdated', 'firstLeadStageUpdated',
        'applicationFormSubmittedOn', 'createdAt', 'updatedAt'];
      const got = rows.length ? await insertBatched(v2, {
        table: 'ApplicationActivityTrackers', cols, rows, label: 'trackers',
        conflict: 'ON CONFLICT ("v1_leadId") WHERE "v1_leadId" IS NOT NULL DO NOTHING', returning: 'RETURNING id, "v1_leadId"',
      }) : [];
      got.forEach(r => rollback.push(`DELETE FROM "ApplicationActivityTrackers" WHERE id = ${r.id}; -- v1 lead ${r.v1_leadId}`));
      log(`  inserted ${got.length} of ${rows.length}`);
      summary.trackers = got.length;
    });

    // ------------------------------------------------------------------ 9. lead score history
    await phase('score_history', `lead score history (${scoreHistory.length})`, async () => {
      const rows = scoreHistory.map(r => ({
        ...r, leadId: leadMap.get(r.v1_lead_id) ?? null, uuid: deterministicUuid(String(r.v1_history_id)),
      })).filter(r => r.leadId !== null);
      const cols = ['uuid', 'leadId', 'criteriaId', 'mappingId', 'mappingValue', 'delta', 'scoreBefore', 'leadScore',
        'schoolId', 'source', 'createdBy', 'createdAt', 'occurredAt', 'dedupeKey', 'metadata'];
      const got = rows.length ? await insertBatched(v2, {
        table: 'leadScoreHistory', cols, rows, label: 'score history',
        conflict: 'ON CONFLICT ("leadId", "dedupeKey") WHERE "dedupeKey" IS NOT NULL DO NOTHING',
        returning: 'RETURNING id, "dedupeKey"', cast: { metadata: 'jsonb' },
      }) : [];
      got.forEach(r => rollback.push(`DELETE FROM "leadScoreHistory" WHERE id = ${r.id}; -- ${r.dedupeKey}`));
      log(`  inserted ${got.length} of ${rows.length}`);
      summary.score_history = got.length;
    });

    // ------------------------------------------------------------------ verification
    hr(`${++phaseNo}. verification`);
    const allIds = [...leadMap.values()];
    const { rows: [cnt] } = await v2.query(
      `select count(*)::int leads,
         count(*) filter (where counsellor_id is not null)::int with_counsellor,
         count(*) filter (where lead_stage_id is not null)::int with_stage,
         count(*) filter (where type = 'applicant')::int applicants
       from v2_leads where id = any($1::bigint[])`, [allIds]);
    log(`  v2_leads now holding these v1 leads: ${cnt.leads} (counsellor ${cnt.with_counsellor}, stage ${cnt.with_stage}, applicants ${cnt.applicants})`);
    const { rows: [sat] } = await v2.query(
      `select (select count(*)::int from under_graduate where lead_id = any($1::bigint[])) ug,
              (select count(*)::int from timelines where v2_lead_id = any($1::bigint[])) tl,
              (select count(*)::int from notes where v2_lead_id = any($1::bigint[])) nt,
              (select count(*)::int from lead_tags where v2_lead_id = any($1::bigint[])) tg,
              (select count(*)::int from "ApplicationActivityTrackers" where "leadId" = any($1::bigint[])) tk,
              (select count(*)::int from "leadScoreHistory" where "leadId" = any($1::bigint[])) sh`, [allIds]);
    log(`  satellites: under_graduate ${sat.ug}  timelines ${sat.tl}  notes ${sat.nt}  lead_tags ${sat.tg}  trackers ${sat.tk}  score ${sat.sh}`);
    const ev = await assertNoEvents(allIds, 'final check');
    log(`  automation_events for these leads: ${ev}  (must be 0)`);
    const { rows: [g2] } = await v2.query(`select current_setting('app.skip_automation', true) as v`);
    log(`  app.skip_automation still "${g2.v}"`);
    const { rows: [after] } = await v2.query('select count(*)::int n from automation_events where id > $1', [base.mx]);
    log(`  automation_events written by the whole CRM since we started: ${after.n} (other sessions - not ours)`);

    if (!APPLY) {
      await v2.query('rollback');
      const { rows: [left] } = await v2.query('select count(*)::int n from v2_leads where v1_lead_id = any($1::int[])',
        [leads.map(l => l.v1_lead_id)]);
      hr('DRY RUN COMPLETE - rolled back');
      log(`  v1 K12 leads present in v2 after the rollback: ${left.n} (expected 0 on a first run)`);
      log(`  would insert: ${JSON.stringify(summary)}`);
      log('  Re-run with --apply to commit.');
    } else {
      fs.writeFileSync(path.join(RUNDIR, 'summary.json'), JSON.stringify(
        { runId, at: new Date().toISOString(), automationBaseline: base.mx, summary }, null, 2));
      writeRollback();
      hr('K12 IMPORT COMPLETE (COMMITTED)');
      log(`  ${JSON.stringify(summary)}`);
      log(`  artefacts: ${RUNDIR}  (rollback.sql, summary.json)`);
    }
  } finally {
    await v2.query('rollback').catch(() => {});
    await v2.end();
  }
})().catch(e => { console.error('IMPORT FAILED:', e.message); process.exit(1); });
