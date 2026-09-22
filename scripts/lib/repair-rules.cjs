/**
 * REPAIR RULES for rows that already exist in v2 (Streams G/H).
 *
 * The user's rules (2026-09-22, clarified):
 *   1. A value in v2 must NEVER become blank because v1 is blank.
 *   2. v2 is the SOURCE OF TRUTH for CONTENT: if v2 has a value (a city, an answer, a
 *      date, a partner...) it is never overwritten with a different v1 value.
 *   3. But PROGRESS must not be lost: if the student is further along in v1 (paid,
 *      submitted, more of the form filled, later activity), v2 moves forward to match.
 *      Progress only ever moves forward - never back, never blank.
 *
 * Every column a repair may write belongs to exactly ONE class:
 *
 *   FILL          written only if v2 is EMPTY (NULL / blank text)          -> rules 1 + 2
 *   FWD_BOOL      false/NULL -> true only                                  -> rule 3
 *   FWD_PAID      payment_status -> 'completed' only (needs a PAID v1 fee record)
 *   FWD_NUM       a number only ever goes UP (form %, section)
 *   FWD_DATE      a "last ..." date only ever moves LATER
 *
 * The importer re-applies these to the LIVE row (locked) and ALSO enforces the class
 * inside the SQL (guardSql), so even a bug in the JavaScript cannot break the rules.
 */

const isEmpty = v => v === null || v === undefined || (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);
const ms = v => (v == null ? null : new Date(v).getTime());

// ------------------------------------------------------------------ column classes
const CLASSES = {
  v2_leads: {
    FWD_BOOL: ['application_form_initiated', 'application_form_submitted', 'payment_initiated', 'is_payment_done'],
    FWD_PAID: ['payment_status'],
    FWD_NUM: ['form_percentage_filled', 'last_interacted_section'],
    FWD_DATE: [],
    FILL: ['payment_completed_at', 'payment_first_initiated_at', 'payment_last_initiated_at', 'payment_partner',
      'payment_mode', 'payment_method', 'application_registered_on', 'form_completion_date', 'lead_stage_date',
      'application_stage_date', 'secondary_source', 'secondary_medium', 'secondary_campaign', 'tertiary_source',
      'tertiary_medium', 'tertiary_campaign', 'widget_id', 'grade', 'alternate_mobile_number'],
  },
  '"ApplicationActivityTrackers"': {
    FWD_BOOL: [], FWD_PAID: [], FWD_NUM: [],
    FWD_DATE: ['payment_last_Initiated_date', 'application_last_activity_date'],
    FILL: ['applicationForm_start_date', 'payment_Initiated_date', 'application_fee_paidOn', 'applicationFormSubmittedOn',
      'counsellor_first_activity_date', 'counsellor_last_activity_date', 'firstLeadStageUpdated', 'lastLeadStageUpdated',
      'v1_applicationId'],
  },
};
const classOf = (table, col) => {
  const t = CLASSES[table];
  if (!t) return 'FILL';                         // under_graduate: every form column is FILL
  for (const [k, cols] of Object.entries(t)) if (cols.includes(col)) return k;
  return null;                                   // not a column a repair may touch
};

/** Given the LIVE row and what v1 wants, the writes the rules allow. */
function plan(table, live, want) {
  const set = {};
  for (const [c, v] of Object.entries(want)) {
    if (isEmpty(v)) continue;                                 // rule 1: never write a blank
    const k = classOf(table, c);
    const b = live[c];
    if (k === 'FILL') { if (isEmpty(b)) set[c] = v; }
    else if (k === 'FWD_BOOL') { if (v === true && b !== true) set[c] = true; }
    else if (k === 'FWD_PAID') { if (v === 'completed' && b !== 'completed') set[c] = 'completed'; }
    else if (k === 'FWD_NUM') { if (isEmpty(b) || Number(v) > Number(b)) set[c] = v; }
    else if (k === 'FWD_DATE') { if (isEmpty(b) || ms(v) > ms(b)) set[c] = v; }
  }
  return set;
}

/** Throws unless every planned write obeys its column class. */
function assertAllowed(label, table, live, set) {
  for (const [c, v] of Object.entries(set)) {
    const k = classOf(table, c), b = live[c];
    if (isEmpty(v)) throw new Error(`${label}: ${c} would be written BLANK - refused (rule 1)`);
    if (!k) throw new Error(`${label}: ${c} is not a column a repair may write - refused`);
    if (k === 'FILL' && !isEmpty(b)) throw new Error(`${label}: ${c} already has ${JSON.stringify(b)} in v2 - refused (rule 2)`);
    if (k === 'FWD_BOOL' && (v !== true || b === true)) throw new Error(`${label}: ${c} ${b} -> ${v} is not false->true`);
    if (k === 'FWD_PAID' && (v !== 'completed' || b === 'completed')) throw new Error(`${label}: ${c} ${b} -> ${v} is not pending->completed`);
    if (k === 'FWD_NUM' && !(isEmpty(b) || Number(v) > Number(b))) throw new Error(`${label}: ${c} ${b} -> ${v} would not increase`);
    if (k === 'FWD_DATE' && !(isEmpty(b) || ms(v) > ms(b))) throw new Error(`${label}: ${c} ${b} -> ${v} would not move later`);
  }
}

/**
 * The rules as a SQL expression: `cur` is the live column, `val` the proposed value.
 * A NULL `val` always keeps `cur` (rule 1 - a repair never writes a blank).
 */
function guardExpr(table, c, cur, val) {
  const k = classOf(table, c);
  let ok;
  if (k === 'FWD_BOOL') ok = `${cur} IS NOT TRUE AND ${val} IS TRUE`;
  else if (k === 'FWD_PAID') ok = `${cur} IS DISTINCT FROM 'completed' AND ${val} = 'completed'`;
  else if (k === 'FWD_NUM' || k === 'FWD_DATE') ok = `(${cur} IS NULL OR ${cur} < ${val})`;
  else ok = `(${cur} IS NULL OR btrim(${cur}::text) = '')`;                                   // FILL
  return `CASE WHEN ${val} IS NOT NULL AND ${ok} THEN ${val} ELSE ${cur} END`;
}
/** The same rules for a single-row UPDATE with a bind parameter. */
const guardSql = (table, c, n) => `"${c}" = ${guardExpr(table, c, `"${c}"`, `$${n}`)}`;

/** v2's spelling of payment partners (Razorpay, Cashfree, Coupon). */
const PARTNER = { razorpay: 'Razorpay', cashfree: 'Cashfree', coupon: 'Coupon' };
const normPartner = p => (isEmpty(p) ? null : PARTNER[String(p).trim().toLowerCase()] || String(p).trim());

// back-compat for the Stream G scripts and the self-test
const ugFill = (live, want, validCols) => {
  const w = Object.fromEntries(Object.entries(want).filter(([c]) => validCols.has(c)));
  return plan('under_graduate', live, w);
};
const fillOnlySql = (c, n) => guardSql('under_graduate', c, n);
const assertFillOnly = (label, live, set) => assertAllowed(label, 'under_graduate', live, set);

module.exports = { isEmpty, ms, CLASSES, classOf, plan, assertAllowed, guardSql, guardExpr, normPartner,
  ugFill, fillOnlySql, assertFillOnly };
