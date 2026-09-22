/**
 * Read-only. Derive the v1 manageLeads -> v2_leads field mapping EMPIRICALLY,
 * from leads the previous migration already copied, restricted to the same
 * vendor sources as the 165 rows we need to insert.
 *
 * For every v2_leads column we ask: which v1 column does it always equal?
 * and how often is it just a constant / always null?
 */
const { connect } = require('./lib/db.cjs');
const SOURCES = ['Collegewollege','Dekhocampus','collegedekho','Getmyuni','Shiksha','Kollegeapply','Zollege','whatsapp'];
const SAMPLE = 4000;

const norm = v => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
};

(async () => {
  const v1 = await connect('v1');
  const v2 = await connect('v2');
  try {
    // v2 rows: migrated, plain leads, no application, from our vendor sources
    const { rows: v2Rows } = await v2.query(`
      select * from v2_leads
      where org_id=12 and school_id=18 and form_id in (104,105)
        and v1_lead_id is not null and type='lead' and v1_application_id is null
        and source = any($1::text[])
      order by v1_lead_id desc limit ${SAMPLE}`, [SOURCES]);
    console.log('v2 sample rows:', v2Rows.length);
    if (!v2Rows.length) throw new Error('no sample');

    const ids = v2Rows.map(r => r.v1_lead_id);
    const { rows: v1Rows } = await v1.query(`select * from "manageLeads" where id = any($1::int[])`, [ids]);
    const v1By = new Map(v1Rows.map(r => [r.id, r]));
    console.log('v1 matched rows :', v1Rows.length);

    const { rows: ugRows } = await v2.query(`select * from under_graduate where lead_id = any($1::int[])`, [v2Rows.map(r=>r.id)]);
    const ugBy = new Map(ugRows.map(r => [r.lead_id, r]));
    console.log('under_graduate rows for sample:', ugRows.length, `(${(100*ugRows.length/v2Rows.length).toFixed(1)}%)`);

    const v1Cols = Object.keys(v1Rows[0]);
    const v2Cols = Object.keys(v2Rows[0]);

    const report = [];
    for (const c2 of v2Cols) {
      const vals = v2Rows.map(r => norm(r[c2]));
      const distinct = new Set(vals);
      const nullCount = vals.filter(v => v === null).length;

      // find v1 columns that match on every row
      const matches = [];
      for (const c1 of v1Cols) {
        let ok = true, nonNull = 0;
        for (const r of v2Rows) {
          const src = v1By.get(r.v1_lead_id);
          if (!src) { ok = false; break; }
          const a = norm(src[c1]), b = norm(r[c2]);
          if (a !== b) { ok = false; break; }
          if (a !== null) nonNull++;
        }
        if (ok && nonNull > 0) matches.push(`${c1}(${nonNull})`);
      }

      let verdict;
      if (matches.length) verdict = 'MAPS FROM ' + matches.join(', ');
      else if (nullCount === vals.length) verdict = 'ALWAYS NULL';
      else if (distinct.size === 1) verdict = 'CONSTANT ' + [...distinct][0];
      else if (distinct.size <= 6) verdict = 'SMALL SET ' + JSON.stringify([...distinct].slice(0,6)) + ` nulls=${nullCount}`;
      else verdict = `VARIES (${distinct.size} distinct, nulls=${nullCount}) e.g. ` + JSON.stringify(vals.filter(v=>v!==null).slice(0,3));
      report.push([c2, verdict]);
    }
    console.log('\n=============== v2_leads COLUMN MAPPING ===============');
    for (const [c, v] of report) console.log(c.padEnd(32), v);

    // under_graduate: which columns are ever populated for these vendor leads?
    if (ugRows.length) {
      console.log('\n=============== under_graduate POPULATED COLUMNS (vendor leads) ===============');
      const ugCols = Object.keys(ugRows[0]);
      for (const c of ugCols) {
        const vals = ugRows.map(r => norm(r[c]));
        const nn = vals.filter(v => v !== null).length;
        if (nn === 0) continue;
        const matches = [];
        for (const c1 of v1Cols) {
          let ok = true, cnt = 0;
          for (const r of ugRows) {
            const lead = v2Rows.find(x => x.id === r.lead_id);
            const src = lead && v1By.get(lead.v1_lead_id);
            if (!src) { ok = false; break; }
            const a = norm(src[c1]), b = norm(r[c]);
            if (a !== b) { ok = false; break; }
            if (a !== null) cnt++;
          }
          if (ok && cnt > 0) matches.push(`${c1}(${cnt})`);
        }
        console.log(c.padEnd(40), `nonnull=${nn}/${ugRows.length}`.padEnd(18),
          matches.length ? 'MAPS FROM '+matches.join(', ') : 'e.g. '+JSON.stringify(vals.filter(v=>v!==null).slice(0,3)).slice(0,120));
      }
    }
  } finally { await v1.end(); await v2.end(); }
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
