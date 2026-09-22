/**
 * Self-test for the checkpoint machinery. Touches NO database.
 *
 * Proves: a checkpoint written for one export payload is honoured; one written for a
 * DIFFERENT payload is ignored; --restart ignores it; and the uuid derivation is stable.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
};

// ---- the exact helpers the importer uses ----------------------------------
function makeCkptHelpers({ dir, manifestSha, APPLY, RESTART, log = () => {} }) {
  const CKPT_FILE = path.join(dir, 'checkpoint.json');
  let ckpt = { exportRun: 'test', manifestSha, phases: {} };
  if (fs.existsSync(CKPT_FILE) && !RESTART) {
    const onDisk = JSON.parse(fs.readFileSync(CKPT_FILE, 'utf8'));
    if (onDisk.manifestSha !== ckpt.manifestSha) log('ignoring checkpoint for a different payload');
    else ckpt = onDisk;
  }
  const phaseDone = k => APPLY && !!(ckpt.phases[k] && ckpt.phases[k].done);
  const markPhase = (k, result) => {
    if (!APPLY) return;
    ckpt.phases[k] = { done: true, at: new Date().toISOString(), result };
    fs.writeFileSync(CKPT_FILE, JSON.stringify(ckpt, null, 2));
  };
  return { phaseDone, markPhase, CKPT_FILE, get ckpt() { return ckpt; } };
}

function deterministicUuid(seed) {
  const h = crypto.createHash('sha1').update(seed).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-test-'));
console.log('scratch dir:', dir);

console.log('\n1. a fresh apply run has no completed phases');
let h = makeCkptHelpers({ dir, manifestSha: 'AAA', APPLY: true, RESTART: false });
check('students not done', h.phaseDone('students') === false);

console.log('\n2. phases mark themselves done and survive a restart of the process');
h.markPhase('students', { studentsCreated: 1 });
h.markPhase('leads', { leads: 163 });
h = makeCkptHelpers({ dir, manifestSha: 'AAA', APPLY: true, RESTART: false });
check('students now done', h.phaseDone('students') === true);
check('leads now done', h.phaseDone('leads') === true);
check('timelines still pending', h.phaseDone('timelines') === false);
check('result payload survived', JSON.stringify(h.ckpt.phases.leads.result) === '{"leads":163}',
  JSON.stringify(h.ckpt.phases.leads.result));

console.log('\n3. a checkpoint from a DIFFERENT export payload is ignored');
h = makeCkptHelpers({ dir, manifestSha: 'BBB', APPLY: true, RESTART: false });
check('students treated as pending for the new payload', h.phaseDone('students') === false);

console.log('\n4. --restart ignores an existing checkpoint');
h = makeCkptHelpers({ dir, manifestSha: 'AAA', APPLY: true, RESTART: true });
check('students pending again under --restart', h.phaseDone('students') === false);

console.log('\n5. a DRY RUN never honours or writes the checkpoint');
h = makeCkptHelpers({ dir, manifestSha: 'AAA', APPLY: false, RESTART: false });
check('dry run runs every phase', h.phaseDone('students') === false);
const before = fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8');
h.markPhase('notes', { notes: 1 });
check('dry run wrote nothing to the checkpoint file',
  fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8') === before);

console.log('\n6. resume order: the first pending phase is the one that failed');
h = makeCkptHelpers({ dir, manifestSha: 'AAA', APPLY: true, RESTART: false });
const order = ['students', 'leads', 'under_graduate_lead', 'under_graduate_applicant',
  'timelines', 'notes', 'lead_tags', 'activity_trackers', 'lead_score_history', 'promotions'];
const firstPending = order.find(k => !h.phaseDone(k));
check('resumes at under_graduate_lead', firstPending === 'under_graduate_lead', firstPending);
check('nothing before it re-runs', order.slice(0, 2).every(k => h.phaseDone(k)));

console.log('\n7. deterministic uuid is stable across runs and unique per row');
check('stable', deterministicUuid('ug-v1-score-history:13040487') === deterministicUuid('ug-v1-score-history:13040487'));
check('unique', deterministicUuid('ug-v1-score-history:1') !== deterministicUuid('ug-v1-score-history:2'));
check('valid v5 shape', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  .test(deterministicUuid('x')), deterministicUuid('x'));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
