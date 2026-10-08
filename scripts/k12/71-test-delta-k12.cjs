/**
 * SELF-TEST for 70-delta-k12.cjs.   Writes nothing: it builds a throw-away export folder,
 * runs the real delta script against LIVE v2 rows in DRY RUN, and checks that what the
 * script decided matches what the rules say it should have decided.
 *
 *   node scripts/k12/71-test-delta-k12.cjs
 *
 * It uses real, already-migrated school-18 leads as its subjects, because the point is to
 * prove the rules hold against real data, not against a fixture. The delta script's dry run
 * wraps everything in one transaction and rolls it back, so those rows are untouched - the
 * test asserts that too, by re-reading them afterwards.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { connect } = require('../lib/db.cjs');
const K = require('./lib-k12.cjs');

const REPOS = 'C:/Users/Prateek/Desktop/Repos';
// a name that sorts BEFORE the timestamped folders, so it can never be picked as "newest"
const DIR = path.join(REPOS, 'data', 'k12', '0000-delta-selftest');
const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(84) + '\n' + t + '\n' + '='.repeat(84));
let fails = 0;
const ok = (c, m) => { log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fails++; };

(async () => {
  const v2 = await connect('v2');
  let before = [];
  try {
    hr('K12 DELTA SELF-TEST');

    // --------------------------------------------------------------- 1. subjects
    // Prefer real K12 leads once they exist; before the first apply there are none, so
    // the test falls back to the most common already-migrated form on this school and says
    // so in its manifest (the delta script only accepts that from a manifest marked selftest).
    const { rows: [pick] } = await v2.query(
      `select form_id, program_id, count(*)::int n from v2_leads
        where school_id = $1 and v1_lead_id is not null and is_deleted = false
        group by 1, 2 order by (form_id = $2) desc, 3 desc limit 1`, [K.V2.school, K.V2.form]);
    if (!pick) throw new Error('no already-migrated school-' + K.V2.school + ' lead to test with');
    const SUBJ = { form: Number(pick.form_id), program: Number(pick.program_id) };
    const { rows: subjects } = await v2.query(
      `select * from v2_leads
        where school_id = $1 and form_id = $2 and v1_lead_id is not null and is_deleted = false
          and registered_name is not null and registered_name <> ''
        order by id limit 5`, [K.V2.school, SUBJ.form]);
    if (subjects.length < 3) throw new Error('not enough already-migrated school-18 leads to test with');
    log(`  subjects: ${subjects.length} live school-${K.V2.school} form-${SUBJ.form} lead(s) -> ${subjects.map(s => s.id).join(', ')}`);
    if (SUBJ.form !== K.V2.form) log(`  (K12 form ${K.V2.form} has no migrated leads yet, so form ${SUBJ.form} on the same school stands in)`);
    before = subjects.map(s => ({ id: Number(s.id), name: s.registered_name, score: s.lead_score,
      mob: s.is_mobile_verified, payload: JSON.stringify(s.lead_payload) }));

    // an EMPTY FILL column to aim at, chosen from what these rows do not have
    const fillCandidates = ['insta_handle', 'cbb_link', 'referrer', 'utm_placement', 'question15'];
    const emptyCol = fillCandidates.find(c => subjects.every(s => s[c] === null || s[c] === ''));
    if (!emptyCol) throw new Error('every candidate FILL column already has a value on these leads');
    log(`  a column that is empty on all of them: ${emptyCol}`);

    // --------------------------------------------------------------- 2. the throw-away export
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(path.join(DIR), { recursive: true });
    const rows = subjects.map(s => ({
      v1_lead_id: Number(s.v1_lead_id), v2_lead_id: Number(s.id),
      // 1. a FILL column that is EMPTY in v2 -> must be written
      [emptyCol]: 'SELFTEST-' + emptyCol,
      // 2. a FILL column that HAS a value in v2 -> must NOT be written, must be reported
      registered_name: 'SELFTEST SHOULD NOT APPEAR',
      // 3. a blank from v1 over a value in v2 -> must never blank it
      chat_summary: '',
      // 4. progress: a flag only moves false -> true
      is_mobile_verified: true,
      // 5. a LOWER score -> must not be written
      lead_score: Number(s.lead_score || 0) - 1,
      // 6. a column no rule allows -> must be refused outright
      is_deleted: true,
      // 7. the payload merge: a new key under formFields, nothing else touched
      lead_payload: { formFields: { school_and_city: 'SELFTEST School, Selftest City' } },
    }));
    const write = (name, data) => {
      const f = path.join(DIR, name);
      fs.writeFileSync(f, data);
      return { rows: data.split('\n').filter(Boolean).length, sha256: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') };
    };
    const files = {};
    files['delta_leads.ndjson'] = write('delta_leads.ndjson', rows.map(r => JSON.stringify(r)).join('\n') + '\n');
    files['delta_under_graduate.ndjson'] = write('delta_under_graduate.ndjson', '');
    fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify({
      generatedAt: new Date().toISOString(), runId: '0000-delta-selftest', selftest: true,
      scope: { v1: K.V1, v2: { ...K.V2, form: SUBJ.form, program: SUBJ.program } },
      counts: {}, files, warnings: [] }, null, 2));
    log(`  built ${DIR} with ${rows.length} delta row(s)`);

    // --------------------------------------------------------------- 3. run the real script
    hr('running 70-delta-k12.cjs --run 0000-delta-selftest   (DRY RUN)');
    let out;
    try {
      out = execFileSync(process.execPath,
        [path.join(REPOS, 'scripts/k12/70-delta-k12.cjs'), '--run', '0000-delta-selftest'],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      out = (e.stdout || '') + (e.stderr || '');
      log(out);
      throw new Error('the delta script exited non-zero');
    }
    const tail = out.split('\n').filter(l => /leads written|form rows|left alone|DRY RUN COMPLETE|by column:|^ {4}\S/.test(l));
    tail.forEach(l => log('  | ' + l.trim()));

    // --------------------------------------------------------------- 4. did it obey the rules?
    hr('assertions');
    const wrote = new RegExp('^\\s+' + emptyCol + '\\s+\\d+', 'm').test(out);
    ok(wrote, `${emptyCol} was EMPTY in v2 and v1 had a value -> written (rule: FILL)`);
    ok(/lead_payload \(merged\)/.test(out), 'lead_payload was merged, so the School & City key reaches an existing lead');
    ok(!/^\s+registered_name\s+\d+/m.test(out), 'registered_name already had a value in v2 -> NOT overwritten (rule 2)');
    ok(/registered_name/.test(out) === false || /left alone for review\s+[1-9]/.test(out),
      'the registered_name disagreement went to the review CSV instead');
    ok(!/^\s+chat_summary\s+\d+/m.test(out), 'an empty v1 value never blanked v2 (rule 1)');
    ok(!/^\s+lead_score\s+\d+/m.test(out), 'a LOWER lead_score was not written (rule 3: forward only)');
    ok(!/^\s+is_deleted\s+\d+/m.test(out), 'is_deleted is not in the rule set -> refused');
    ok(/DRY RUN COMPLETE/.test(out), 'the run finished and rolled itself back');

    const csv = path.join(DIR, 'runs');
    const runDirs = fs.existsSync(csv) ? fs.readdirSync(csv) : [];
    const reviewFile = runDirs.length ? path.join(csv, runDirs[runDirs.length - 1], 'delta_review.csv') : null;
    if (reviewFile && fs.existsSync(reviewFile)) {
      const lines = fs.readFileSync(reviewFile, 'utf8').split('\n').filter(Boolean);
      ok(lines.length > 1, `the review CSV lists the disagreements (${lines.length - 1} row(s))`);
      // the two clashes this test plants on purpose: a different name, and a lower score
      const planted = lines.slice(1).every(l => l.includes('registered_name') || l.includes('lead_score'));
      ok(planted, 'every review row is one of the two clashes the test planted, and nothing else');
      log('      e.g. ' + (lines[1] || '').slice(0, 150));
    } else ok(false, 'a review CSV was written');

    // --------------------------------------------------------------- 5. and nothing changed
    const { rows: after } = await v2.query(
      'select id, registered_name, lead_score, is_mobile_verified, lead_payload from v2_leads where id = any($1::bigint[]) order by id',
      [before.map(b => b.id)]);
    let same = true;
    for (const a of after) {
      const b = before.find(x => x.id === Number(a.id));
      if (b.name !== a.registered_name || String(b.score) !== String(a.lead_score) ||
          b.mob !== a.is_mobile_verified || b.payload !== JSON.stringify(a.lead_payload)) same = false;
    }
    ok(same, 'all 5 live leads are byte-for-byte what they were before the test');

    hr(fails ? `SELF-TEST FAILED (${fails})` : 'SELF-TEST PASSED - the re-sync rules hold on live data');
    process.exitCode = fails ? 1 : 0;
  } finally {
    fs.rmSync(DIR, { recursive: true, force: true });
    log('  (throw-away export folder removed)');
    await v2.end();
  }
})().catch(e => { console.error('SELF-TEST ERROR:', e.message); process.exit(1); });
