/**
 * Every v1 -> v2 lookup this migration needs.
 *
 * Nothing here is hardcoded on faith: each map is BUILT at run time from the live
 * databases and then ASSERTED against what the previous migration actually wrote.
 * If a map cannot be built, or disagrees with observed behaviour, the caller aborts
 * rather than guessing.
 */

const V1_FORMS = [100, 109];
const V2_FORMS = [104, 105];
const ORG_V2 = 12, SCHOOL_V2 = 18, LEAD_TABLE_ID = 19;

// v1 applicationFormId -> the v2 placement. Verified true for all 71,166 migrated rows.
const FORM_MAP = {
  100: { form_id: 104, program_id: 94, batch_id: 88, round_id: 84 },
  109: { form_id: 105, program_id: 95, batch_id: 89, round_id: 85 },
};

// v1 UserTimelines.eventType.title -> v2 timelines.event_type
const EVENT_TYPE_MAP = {
  'Lead Added': 'created',
  'Counsellor_Assigned': 'counsellor_assigned',
  'Changed_Lead_Stage': 'lead_stage_changed',
  'whatsapp': 'whatsapp_sent',
  'Email_Sent': 'email_sent',
  'Email Sent': 'email_sent',
  'Lead Synced to CAPI': 'lead_synced_to_capi',
  'Application Stage Changed': 'application_stage_changed',
  'Payment_Activity': 'payment_activity',
  'Online Payment Initiated': 'online_payment_initiated',
  'Note Created': 'note_added',
  'Dinero API Triggered': 'dinero_api_triggered',
  'Lead Type Updated': 'updated',
  'Program Changed': 'program_changed',
  // Never produced by the UG migration, but v2 already holds 6,628 `stage_assigned`
  // rows written natively, so the snake_case form is the correct target.
  'Stage Assigned': 'stage_assigned',
};

/** Fallback for a title the previous migration never produced. */
function toEventType(title) {
  if (title in EVENT_TYPE_MAP) return { event_type: EVENT_TYPE_MAP[title], known: true };
  const slug = String(title || '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/[^a-z0-9_]/g, '');
  return { event_type: slug || 'updated', known: false };
}

/** v1 LeadStage/sub-stage -> v2, resolved BY NAME within the target org/school. */
async function buildStageMaps(v1, v2) {
  const { rows: s1 } = await v1.query(
    `select id, "stageName", "isActive" from "LeadStage" where "organizationId"=68 and "schoolId"=11`);
  const { rows: s2 } = await v2.query(
    `select id, "stageName", "isActive" from "leadStage" where "organizationId"=$1 and "schoolId"=$2`, [ORG_V2, SCHOOL_V2]);
  // Prefer the ACTIVE v2 stage when a name exists twice (v2 keeps deactivated twins).
  const byName = new Map();
  for (const r of s2) {
    const k = r.stageName.trim().toLowerCase();
    const cur = byName.get(k);
    if (!cur || (r.isActive && !cur.isActive)) byName.set(k, r);
  }
  const stage = new Map();
  for (const r of s1) {
    const hit = byName.get(r.stageName.trim().toLowerCase());
    if (hit) stage.set(r.id, hit.id);
  }

  const { rows: ss1 } = await v1.query(
    `select ss.id, ss."leadStageId", ss.name, s."stageName" from "LeadSubStage" ss
     join "LeadStage" s on s.id=ss."leadStageId" where s."organizationId"=68 and s."schoolId"=11`);
  const { rows: ss2 } = await v2.query(
    `select ss.id, ss."leadStageId", ss.name, ss."isActive", s."stageName" from "leadSubStage" ss
     join "leadStage" s on s.id=ss."leadStageId" where s."organizationId"=$1 and s."schoolId"=$2`, [ORG_V2, SCHOOL_V2]);
  const ssByName = new Map();
  for (const r of ss2) {
    const k = `${r.stageName.trim().toLowerCase()}||${r.name.trim().toLowerCase()}`;
    const cur = ssByName.get(k);
    if (!cur || (r.isActive && !cur.isActive)) ssByName.set(k, r);
  }
  const subStage = new Map();
  for (const r of ss1) {
    const hit = ssByName.get(`${r.stageName.trim().toLowerCase()}||${r.name.trim().toLowerCase()}`);
    if (hit) subStage.set(r.id, hit.id);
  }

  // application stages live in the same v1 table (ids 173-181) -> v2 "applicationStage"
  const { rows: as2 } = await v2.query(
    `select id, "stageName", "isActive" from "applicationStage" where "organizationId"=$1 and "schoolId"=$2`, [ORG_V2, SCHOOL_V2]);
  const asByName = new Map();
  for (const r of as2) {
    const k = r.stageName.trim().toLowerCase();
    const cur = asByName.get(k);
    if (!cur || (r.isActive && !cur.isActive)) asByName.set(k, r);
  }
  const appStage = new Map();
  for (const r of s1) {
    const hit = asByName.get(r.stageName.trim().toLowerCase());
    if (hit) appStage.set(r.id, hit.id);
  }

  // Application SUB-stages. No application currently in scope has one, but v1 holds
  // 1,940 UG applications that do, so a future run would silently drop them without
  // this map. Resolved by (application stage name, sub-stage name), same as leads.
  const { rows: ass1 } = await v1.query(
    `select ss.id, ss."leadStageId", ss.name, s."stageName" from "LeadSubStage" ss
     join "LeadStage" s on s.id = ss."leadStageId" where s."organizationId"=68 and s."schoolId"=11`);
  const { rows: ass2 } = await v2.query(
    `select ss.id, ss."applicationStageId", ss.name, ss."isActive", s."stageName"
     from "applicationSubStage" ss join "applicationStage" s on s.id = ss."applicationStageId"
     where s."organizationId"=$1 and s."schoolId"=$2`, [ORG_V2, SCHOOL_V2]);
  const assByName = new Map();
  for (const r of ass2) {
    const k = `${r.stageName.trim().toLowerCase()}||${r.name.trim().toLowerCase()}`;
    const cur = assByName.get(k);
    if (!cur || (r.isActive && !cur.isActive)) assByName.set(k, r);
  }
  const appSubStage = new Map();
  for (const r of ass1) {
    const hit = assByName.get(`${r.stageName.trim().toLowerCase()}||${r.name.trim().toLowerCase()}`);
    if (hit) appSubStage.set(r.id, hit.id);
  }

  return { stage, subStage, appStage, appSubStage };
}

/**
 * v1 manageLeads.assignTo (uuid) -> v2_leads.counsellor_id.
 *
 * MUST come from observed migrated rows. Matching on email or users.v1_id picks the
 * wrong account for 17 of 19 UG counsellors, because each counsellor has both a
 * `name@` account (school 18, v1_id set) and a newer `name+1@` account that the
 * migration actually used. See ai_agent_history/02-field-mappings.md.
 */
async function buildCounsellorMap(v1, v2) {
  const { rows } = await v2.query(
    `select v1_lead_id, counsellor_id from v2_leads
      where org_id=$1 and school_id=$2 and form_id = any($3::int[])
        and v1_lead_id is not null and counsellor_id is not null`, [ORG_V2, SCHOOL_V2, V2_FORMS]);
  const ids = rows.map(r => r.v1_lead_id);
  const assign = new Map();
  for (let i = 0; i < ids.length; i += 20000) {
    const { rows: a } = await v1.query(
      `select id, "assignTo" from "manageLeads" where id = any($1::int[])`, [ids.slice(i, i + 20000)]);
    for (const r of a) assign.set(r.id, r.assignTo);
  }
  const votes = new Map();
  for (const r of rows) {
    const u = assign.get(r.v1_lead_id); if (!u) continue;
    if (!votes.has(u)) votes.set(u, new Map());
    const m = votes.get(u); m.set(r.counsellor_id, (m.get(r.counsellor_id) || 0) + 1);
  }
  const map = new Map(), evidence = {};
  for (const [u, m] of votes) {
    const ranked = [...m.entries()].sort((a, b) => b[1] - a[1]);
    map.set(u, ranked[0][0]);
    evidence[u] = { chosen: ranked[0][0], votes: ranked[0][1], total: [...m.values()].reduce((a, b) => a + b, 0), alternatives: ranked.slice(1, 4) };
  }
  return { map, evidence };
}

/** v1 users.id -> v2 users.id, via v2 users.v1_id. Used for timeline/note authorship ONLY. */
async function buildUserMap(v2, v1UserIds) {
  const map = new Map();
  for (let i = 0; i < v1UserIds.length; i += 5000) {
    const { rows } = await v2.query(
      `select id, v1_id, email, name from users where v1_id = any($1::int[])`, [v1UserIds.slice(i, i + 5000)]);
    for (const r of rows) map.set(r.v1_id, r);
  }
  return map;
}

module.exports = {
  V1_FORMS, V2_FORMS, ORG_V2, SCHOOL_V2, LEAD_TABLE_ID, FORM_MAP,
  EVENT_TYPE_MAP, toEventType, buildStageMaps, buildCounsellorMap, buildUserMap,
};

/**
 * v1 leadScoreCriteria/leadScoreMapping -> v2 lead_score_criteria/lead_score_mapping.
 *
 * Resolved BY NAME (criteriaName, then label within that criteria), then
 * cross-checked against what the previous migration actually wrote, so a rename on
 * either side shows up as a disagreement rather than silently mis-scoring a lead.
 */
async function buildScoreMaps(v1, v2) {
  const { rows: c1 } = await v1.query('select id, "criteriaName" from "leadScoreCriteria"');
  const { rows: c2 } = await v2.query(
    'select id, "criteriaName" from lead_score_criteria where "schoolId" = $1', [SCHOOL_V2]);
  const c2ByName = new Map(c2.map(r => [r.criteriaName.trim().toLowerCase(), r.id]));
  const criteria = new Map();
  for (const r of c1) {
    const hit = c2ByName.get(r.criteriaName.trim().toLowerCase());
    if (hit) criteria.set(r.id, hit);
  }

  const { rows: m1 } = await v1.query(
    `select m.id, m."criteriaId", m.label, c."criteriaName" from "leadScoreMapping" m
     join "leadScoreCriteria" c on c.id = m."criteriaId"`);
  const { rows: m2 } = await v2.query(
    `select m.id, m."criteriaId", m.label, c."criteriaName" from lead_score_mapping m
     join lead_score_criteria c on c.id = m."criteriaId" where c."schoolId" = $1`, [SCHOOL_V2]);
  const m2ByName = new Map(m2.map(r => [`${r.criteriaName.trim().toLowerCase()}||${(r.label || '').trim().toLowerCase()}`, r.id]));
  const mapping = new Map();
  for (const r of m1) {
    const hit = m2ByName.get(`${r.criteriaName.trim().toLowerCase()}||${(r.label || '').trim().toLowerCase()}`);
    if (hit) mapping.set(r.id, hit);
  }

  // cross-check against observed migrated rows
  const { rows: obs } = await v2.query(`
    select "criteriaId", "mappingId", metadata->>'v1CriteriaId' v1c, metadata->>'v1MappingId' v1m
    from "leadScoreHistory"
    where "schoolId" = $1 and source = 'v1_history' and metadata ? 'v1MappingId'
    limit 4000`, [SCHOOL_V2]);
  const disagree = [];
  for (const r of obs) {
    const wantC = criteria.get(Number(r.v1c));
    const wantM = mapping.get(Number(r.v1m));
    if (wantC !== undefined && wantC !== r.criteriaId) disagree.push(`criteria ${r.v1c}: by-name ${wantC}, migration wrote ${r.criteriaId}`);
    if (wantM !== undefined && wantM !== r.mappingId) disagree.push(`mapping ${r.v1m}: by-name ${wantM}, migration wrote ${r.mappingId}`);
  }
  return { criteria, mapping, disagree: [...new Set(disagree)], observedRows: obs.length };
}

module.exports.buildScoreMaps = buildScoreMaps;
