/**
 * The gap-fill rule for a lead the live v2 app has ALREADY promoted to applicant.
 *
 * One definition, used by the importer (which writes it), the verifier (which checks
 * it) and the impact report (which shows it to a human). Before this existed the
 * impact report printed the raw v1 values instead, and so showed columns being
 * overwritten that the importer never touches.
 *
 * Rule: only fill a column v2 left empty; never touch one v2 has set; never touch
 * the columns v2 owns once it has promoted.
 */
const EMPTY_IS_FALSE = new Set(['application_form_initiated', 'application_form_submitted', 'is_payment_done', 'payment_initiated']);
const NEVER_FILL = new Set(['type', 'updated_at']);   // v2 owns these once it has promoted

/** True when v2 has promoted the row itself, so the importer must gap-fill rather than promote. */
const needsGapFill = cur => cur.type !== 'lead' || cur.v1_application_id !== null;

/**
 * @param cur   the live v2_leads row
 * @param after the values v1 would like the row to have
 * @returns { fill: {col: value}, kept: [{col, v2, v1}] }
 */
function planGapFill(cur, after) {
  const fill = {}, kept = [];
  for (const [c, v] of Object.entries(after)) {
    if (NEVER_FILL.has(c)) continue;
    if (v === null || v === undefined) continue;                 // nothing to contribute
    const isEmpty = cur[c] === null || cur[c] === undefined
      || (EMPTY_IS_FALSE.has(c) && cur[c] === false)
      || (c === 'form_percentage_filled' && Number(cur[c]) === 0 && Number(v) > 0);
    if (isEmpty) fill[c] = v;
    else if (String(cur[c]) !== String(v)) kept.push({ col: c, v2: cur[c], v1: v });
  }
  return { fill, kept };
}

module.exports = { planGapFill, needsGapFill, EMPTY_IS_FALSE, NEVER_FILL };
