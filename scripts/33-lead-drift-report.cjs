/**
 * READ-ONLY. Stream E - leads already in v2 whose v1 row was edited AFTER the copy,
 * in a field worth keeping in step. Writes a CSV a human can open in Excel.
 *
 * Stage and counsellor are deliberately NOT compared: counsellors work in v2, so v2
 * is the system of record for those and v1 changes must never be pushed back.
 *
 *   node scripts/33-lead-drift-report.cjs
 *   -> data/review/stream_e_lead_drift.csv
 */
const fs = require('fs');
const path = require('path');
const { connect } = require('./lib/db.cjs');
const M = require('./lib/maps.cjs');

const log = (...a) => console.log(...a);
const OUT = 'C:/Users/Prateek/Desktop/Repos/data/review';

// field -> [v1 column, v2 column, what it means in plain words]
const FIELDS = [
  ['registeredMobile', 'registered_mobile', 'phone number - counsellors call this'],
  ['registeredEmail', 'registered_email', 'email - where emails go'],
  ['source', 'source', 'which vendor / campaign the lead came from'],
  ['medium', 'medium', 'marketing medium'],
  ['campaign', 'campaign', 'marketing campaign'],
  ['leadType', 'lead_type', 'primary / secondary lead'],
];
const same = (a, b) => (a == null || String(a).trim() === '' ? null : String(a).trim()) ===
                       (b == null || String(b).trim() === '' ? null : String(b).trim());

(async () => {
  const v1 = await connect('v1'); const v2 = await connect('v2');
  try {
    const { rows: v2Rows } = await v2.query(`
      select id, v1_lead_id, registered_name, updated_at, is_deleted, type,
             ${FIELDS.map(f => f[1]).join(', ')}
      from v2_leads where org_id = $1 and school_id = $2 and form_id = any($3::int[]) and v1_lead_id is not null`,
      [M.ORG_V2, M.SCHOOL_V2, M.V2_FORMS]);
    const by = new Map();
    const ids = v2Rows.map(r => Number(r.v1_lead_id));
    for (let i = 0; i < ids.length; i += 20000) {
      const { rows } = await v1.query(`
        select id, "updatedAt", "isLeadDeleted", ${FIELDS.map(f => `"${f[0]}"`).join(', ')}
        from "manageLeads" where id = any($1::int[])`, [ids.slice(i, i + 20000)]);
      rows.forEach(r => by.set(r.id, r));
    }

    const out = [], perField = new Map(), leads = new Set();
    let newer = 0;
    for (const r of v2Rows) {
      if (r.is_deleted) continue;
      const a = by.get(Number(r.v1_lead_id)); if (!a) continue;
      if (!(new Date(a.updatedAt) > new Date(r.updated_at))) continue;   // v2 edited last -> v2 wins
      newer++;
      for (const [c1, c2, meaning] of FIELDS) {
        if (same(a[c1], r[c2])) continue;
        // case-only email difference is not a real change
        if (c1 === 'registeredEmail' && String(a[c1] || '').toLowerCase() === String(r[c2] || '').toLowerCase()) continue;
        out.push({ v2_lead_id: r.id, v1_lead_id: r.v1_lead_id, name: r.registered_name, type: r.type,
          field: c2, meaning, v1_value: a[c1], v2_value: r[c2],
          v1_edited_at: new Date(a.updatedAt).toISOString(), v2_edited_at: new Date(r.updated_at).toISOString() });
        perField.set(c2, (perField.get(c2) || 0) + 1);
        leads.add(r.id);
      }
    }

    log(`migrated UG leads (live)                       : ${v2Rows.filter(r => !r.is_deleted).length}`);
    log(`v1 edited AFTER v2 last changed the lead       : ${newer}`);
    log(`...of which a tracked field actually differs   : ${leads.size} leads, ${out.length} field differences`);
    log('\nby field:');
    for (const [c1, c2, meaning] of FIELDS) if (perField.get(c2)) log(`  ${String(perField.get(c2)).padStart(4)}  ${c2.padEnd(18)} ${meaning}`);

    log('\nexamples:');
    for (const f of FIELDS.map(x => x[1])) {
      out.filter(o => o.field === f).slice(0, 3).forEach(o =>
        log(`  ${f.padEnd(18)} lead ${String(o.v2_lead_id).padEnd(8)} ${String(o.name).slice(0, 22).padEnd(22)} v1 ${JSON.stringify(o.v1_value)}  |  v2 ${JSON.stringify(o.v2_value)}`));
    }

    fs.mkdirSync(OUT, { recursive: true });
    const cols = Object.keys(out[0] || { v2_lead_id: '' });
    const esc = v => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const file = path.join(OUT, 'stream_e_lead_drift.csv');
    fs.writeFileSync(file, [cols.join(','), ...out.map(o => cols.map(c => esc(o[c])).join(','))].join('\n') + '\n');
    log(`\nwritten: ${file}`);
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
