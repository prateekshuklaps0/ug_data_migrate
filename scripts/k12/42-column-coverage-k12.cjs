/**
 * K12 COLUMN COVERAGE - READ ONLY.
 *
 *   node scripts/k12/42-column-coverage-k12.cjs [--run <export id>]
 *
 * Answers "does EVERY v1 column that holds K12 data reach a v2 column?" by evidence, not
 * by a hand-written list: for a sample of in-scope rows it takes each populated v1 column
 * and searches the exported v2 row for a field holding the same value. Anything populated
 * in v1 that lands nowhere, and is not on the DECLARED list of deliberate drops below,
 * is reported as UNACCOUNTED and fails the run.
 *
 * Covers manageLeads, UserTimelines, Notes, applicationActivityTracker and
 * LeadScoreHistories.
 */
const fs = require('fs');
const path = require('path');
const { connect } = require('../lib/db.cjs');
const K = require('./lib-k12.cjs');

const ROOT = 'C:/Users/Prateek/Desktop/Repos/data/k12';
const args = process.argv.slice(2);
const runArg = args.includes('--run') ? args[args.indexOf('--run') + 1] : null;
const SAMPLE = 300;

const log = (...a) => console.log(...a);
const hr = t => log('\n' + '='.repeat(92) + '\n' + t + '\n' + '='.repeat(92));
let fail = 0;

/** v1 columns that deliberately do NOT become a same-valued v2 column, and why. */
const DECLARED = {
  manageLeads: {
    id: 'becomes v1_lead_id (and the new v2 id)',
    uuid: 'v2 mints its own uuid - the previous migration did too (0 of 200 sampled rows reuse v1 uuid)',
    organizationId: 'scope constant: org_id 12',
    schoolId: 'scope constant: school_id 18 (K12 is a PROGRAMME there, not a school)',
    programId: 'scope constant: program_id 123',
    applicationFormId: 'scope constant: form_id 128',
    cohortId: 'scope constant: batch_id 192',
    roundId: 'scope constant: round_id 216',
    assignTo: 'uuid resolved to counsellor_id (a v2 user id)',
    userId: 'resolved to user_id; the raw id is kept in v1_user_id',
    leadStageId: 'resolved by name to lead_stage_id',
    leadSubStageId: 'resolved by name to lead_sub_stage_id',
    previousLeadStage: 'resolved by name to previous_lead_stage',
    applicationManagerId: 'no applications exist for this form (0 ApplicationManager rows)',
    reassignedBy: 'resolved to a v2 user id in reassigned_by',
    tags: 'modelled relationally in v2: one lead_tags row per tag, pointing at a tags row',
    isLeadDeleted: 'only live leads are migrated (user decision 2026-10-08)',
    widgetId: 'written NULL on purpose: a v1 widget id means another widget in v2',
    totalFormsInitiated: 'v1 counter with no v2 column; always 1, so not even stashed',
  },
  UserTimelines: {
    id: 'becomes v1_timeline_id',
    leadId: 'becomes v1_lead_id, and v2_lead_id after the lead is inserted',
    eventType: 'flattened: title -> title, and mapped to event_type',
    message: 'becomes description',
    payload: 'becomes metadata (jsonb)',
    leadStageId: 'resolved by name to lead_stage_id',
    userId: 'kept as v1_counsellor_id, resolved to created_by where the actor exists in v2',
    templateId: 'v1 template ids point at v1 templates; v2 timelines.template_id is an FK to v2 templates, so NULL (as all 17,903 previously-copied rows have)',
    uuid: 'v2 timelines has no uuid column; provenance is v1_timeline_id, which is also the dedup key',
    date: 'the date part of createdAt (verified on a sample), which is migrated in full as created_at - and v1 keeps it inside payload too',
    time: 'the HH:MM part of createdAt (verified on a sample), already carried by created_at',
    isDeleted: 'false on all 1,187 in-scope rows and v2 timelines has no such column; the export also filters deleted rows out',
  },
  Notes: {
    id: 'becomes v1_note_id',
    leadId: 'becomes v1_lead_id / v2_lead_id',
    message: 'becomes content (trimmed)',
    userId: 'kept as v1_counsellor_id, resolved to admin_id',
    uuid: 'v2 notes has no uuid column; provenance is v1_note_id, which is also the dedup key',
  },
  applicationActivityTracker: {
    id: 'v2 mints its own id',
    leadId: 'becomes v1_leadId, and leadId after the lead is inserted',
    applicationId: 'becomes v1_applicationId',
    offerLetterStatus: "no v2 column; it is the constant 'pending' on all 6,186 in-scope rows - dropped exactly as the UG migration dropped it",
    tetrTrialStarted: 'no v2 column; false on all 6,186 in-scope rows (every other tetr* column is empty)',
  },
  LeadScoreHistories: {
    id: 'becomes v1_history_id and the dedupeKey',
    leadId: 'becomes leadId after the lead is inserted',
    criteriaId: 'resolved by name to criteriaId',
    mappingId: 'resolved by name to mappingId',
    score: 'becomes delta and mappingValue; the running total becomes scoreBefore / leadScore',
    createdBy: 'kept in metadata.v1CreatedBy; createdBy is NULL (no v2 actor for a migration)',
    uuid: 'leadScoreHistory.uuid is derived deterministically from the v1 history id - the previous migration also minted its own (0 of 20 sampled rows reuse the v1 uuid), so this matches',
    updatedAt: 'v2 has no updatedAt here; createdAt / occurredAt carry the time',
  },
};

const norm = v => {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return String(v.getTime());
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  let s = String(v).trim();
  // an ISO timestamp and a Date must compare equal
  const t = Date.parse(s);
  if (!Number.isNaN(t) && /\d{4}-\d{2}-\d{2}/.test(s)) return String(t);
  // "+91" and "91" are the same dialling code. v2 keeps it without the plus (80,994
  // school-18 rows to 335), and stripOnPlus in lib-k12.cjs removes it deliberately.
  if (/^\+\d+$/.test(s)) s = s.slice(1);
  return s.toLowerCase();
};

/** Where in the exported row does this v1 value appear? */
function findDest(v1Value, exportedRow) {
  const want = norm(v1Value);
  if (want === null) return null;
  const hits = [];
  for (const [k, v] of Object.entries(exportedRow)) {
    if (k === '_v1') continue;
    if (norm(v) === want) hits.push(k);
  }
  // The whole v1 JSON blob landing in lead_payload / metadata counts as carried, even
  // though the export ADDS keys to it: __legacy (a v1 column with no v2 column),
  // formFields (the widget answers, keyed the way v2's own widget keys them) and
  // __v1_answers (an answer v2 has no column for). Take those three away and what is
  // left must be the v1 blob, byte for byte - including every key that was already
  // inside formFields.
  const ADDED = ['__legacy', 'formFields', '__v1_answers'];
  for (const container of ['lead_payload', 'metadata']) {
    const c = exportedRow[container];
    if (c && typeof c === 'object' && typeof v1Value === 'object' && v1Value) {
      const shrunk = { ...c };
      ADDED.forEach(k => delete shrunk[k]);
      if (norm(shrunk) === want) hits.push(container);
      // v1 already had a formFields of its own: keep it, but only the keys v1 had
      if (!hits.length && v1Value.formFields && c.formFields) {
        const back = { ...shrunk, formFields: Object.fromEntries(
          Object.keys(v1Value.formFields).map(k => [k, c.formFields[k]])) };
        if (norm(back) === want) hits.push(container);
      }
    }
  }
  if (hits.length) return hits;
  // inside the payload / metadata / legacy stash?
  for (const container of ['lead_payload', 'metadata']) {
    const c = exportedRow[container];
    if (c && typeof c === 'object') {
      if (c.__legacy && Object.values(c.__legacy).some(x => norm(x) === want)) return [container + '.__legacy'];
      if (Object.values(c).some(x => norm(x) === want)) return [container];
    }
  }
  return null;
}

function report(table, v1Rows, exported, keyOf) {
  hr(table);
  const declared = DECLARED[table] || {};
  const cols = Object.keys(v1Rows[0] || {});
  const rows = [];
  for (const c of cols) {
    let populated = 0, matched = 0;
    const dests = new Map();
    for (const r of v1Rows) {
      if (r[c] === null || r[c] === undefined || r[c] === '') continue;
      populated++;
      const e = exported.get(keyOf(r));
      if (!e) continue;
      const d = findDest(r[c], e);
      if (d) { matched++; d.forEach(x => dests.set(x, (dests.get(x) || 0) + 1)); }
    }
    if (!populated) continue;
    const snake = c.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const best = [...dests.entries()].sort((a, b) => {
      if (a[0] === snake && b[0] !== snake) return -1;
      if (b[0] === snake && a[0] !== snake) return 1;
      return b[1] - a[1];
    });
    rows.push({ c, populated, matched, dest: best.length ? best[0][0] : null, alts: best.slice(1, 3).map(x => x[0]) });
  }
  const ok = [], viaLegacy = [], dropped = [], unaccounted = [];
  for (const r of rows) {
    if (declared[r.c]) dropped.push(r);                       // a declared reason wins
    else if (r.dest && r.dest.endsWith('__legacy')) viaLegacy.push(r);
    else if (r.dest) ok.push(r);
    else unaccounted.push(r);
  }
  log(`  sampled ${v1Rows.length} row(s); ${rows.length} v1 column(s) hold data`);
  log(`\n  CARRIED (${ok.length}):`);
  ok.sort((a, b) => b.populated - a.populated).forEach(r =>
    log(`    ${r.c.padEnd(26)} ${String(r.populated).padStart(4)} value(s) -> ${r.dest}${r.alts.length ? ' (also ' + r.alts.join(', ') + ')' : ''}` +
      (r.matched < r.populated ? `   [${r.populated - r.matched} value(s) did not match - check]` : '')));
  if (viaLegacy.length) {
    log(`\n  KEPT IN lead_payload.__legacy (${viaLegacy.length}) - no v2 column exists:`);
    viaLegacy.forEach(r => log(`    ${r.c.padEnd(26)} ${String(r.populated).padStart(4)} value(s)`));
  }
  log(`\n  DELIBERATELY TRANSFORMED OR DROPPED (${dropped.length}):`);
  dropped.sort((a, b) => b.populated - a.populated).forEach(r =>
    log(`    ${r.c.padEnd(26)} ${String(r.populated).padStart(4)} value(s) - ${declared[r.c]}`));
  if (unaccounted.length) {
    fail += unaccounted.length;
    log(`\n  *** UNACCOUNTED (${unaccounted.length}) - populated in v1, lands nowhere, no declared reason:`);
    unaccounted.sort((a, b) => b.populated - a.populated).forEach(r =>
      log(`    FAIL  ${r.c.padEnd(26)} ${String(r.populated).padStart(4)} value(s)`));
  } else log(`\n  no unaccounted column: every populated v1 column either lands in v2 or has a declared reason`);
}

(async () => {
  const runs = fs.readdirSync(ROOT).filter(d => /^\d{4}-/.test(d)).sort();
  const runId = runArg || runs[runs.length - 1];
  const DIR = path.join(ROOT, runId);
  const rd = f => fs.existsSync(path.join(DIR, f))
    ? fs.readFileSync(path.join(DIR, f), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  hr(`K12 COLUMN COVERAGE   export ${runId}`);

  const leads = rd('leads.ndjson');
  const tl = rd('timelines.ndjson');
  const nt = rd('notes.ndjson');
  const tk = rd('activity_trackers.ndjson');
  const sh = rd('lead_score_history.ndjson');
  const ug = rd('under_graduate.ndjson');
  log(`  payload: ${leads.length} leads, ${tl.length} timelines, ${nt.length} notes, ${tk.length} trackers, ${sh.length} score rows`);

  const v1 = await connect('v1');
  try {
    // leads: a spread across the export, plus the form-table row merged in, because
    // city / state / grade legitimately land in under_graduate rather than v2_leads
    const step = Math.max(1, Math.floor(leads.length / SAMPLE));
    const picked = leads.filter((_, i) => i % step === 0).slice(0, SAMPLE);
    const ugBy = new Map(ug.map(r => [r.v1_lead_id, r]));
    const leadsBy = new Map(picked.map(r => {
      const merged = { ...r };
      const u = ugBy.get(r.v1_lead_id);
      if (u) for (const [k, v] of Object.entries(u)) if (merged[k] === undefined || merged[k] === null) merged['under_graduate.' + k] = v;
      return [r.v1_lead_id, merged];
    }));
    const { rows: v1Leads } = await v1.query('select * from "manageLeads" where id = any($1::int[])', [picked.map(r => r.v1_lead_id)]);
    report('manageLeads', v1Leads, leadsBy, r => r.id);

    const tlPick = tl.filter((_, i) => i % Math.max(1, Math.floor(tl.length / SAMPLE)) === 0).slice(0, SAMPLE);
    const { rows: v1Tl } = await v1.query('select * from "UserTimelines" where id = any($1::bigint[])', [tlPick.map(r => r.v1_timeline_id)]);
    report('UserTimelines', v1Tl, new Map(tlPick.map(r => [Number(r.v1_timeline_id), r])), r => Number(r.id));

    if (nt.length) {
      const { rows: v1Nt } = await v1.query('select * from "Notes" where id = any($1::int[])', [nt.map(r => r.v1_note_id)]);
      report('Notes', v1Nt, new Map(nt.map(r => [r.v1_note_id, r])), r => r.id);
    }

    const tkPick = tk.filter((_, i) => i % Math.max(1, Math.floor(tk.length / SAMPLE)) === 0).slice(0, SAMPLE);
    const { rows: v1Tk } = await v1.query('select * from "applicationActivityTracker" where "leadId" = any($1::int[])', [tkPick.map(r => r.v1_leadId)]);
    report('applicationActivityTracker', v1Tk, new Map(tkPick.map(r => [r.v1_leadId, r])), r => r.leadId);

    if (sh.length) {
      const shPick = sh.slice(0, SAMPLE);
      const { rows: v1Sh } = await v1.query('select * from "LeadScoreHistories" where id = any($1::int[])', [shPick.map(r => r.v1_history_id)]);
      report('LeadScoreHistories', v1Sh, new Map(shPick.map(r => [r.v1_history_id, r])), r => r.id);
    }

    hr(fail ? `${fail} UNACCOUNTED COLUMN(S) - decide where each one goes before applying` : 'EVERY POPULATED v1 COLUMN IS ACCOUNTED FOR');
    if (fail) process.exitCode = 1;
  } finally { await v1.end(); }
})().catch(e => { console.error('COVERAGE CHECK FAILED TO RUN:', e.message); process.exit(1); });
