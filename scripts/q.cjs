/**
 * Read-only ad-hoc query runner.  Usage:
 *   node scripts/q.cjs v1 "select 1"
 *   node scripts/q.cjs v2 --file path/to.sql
 * Always opens the session as read-only; it cannot write.
 */
const fs = require('fs');
const { connect } = require('./lib/db.cjs');

(async () => {
  const [which, ...rest] = process.argv.slice(2);
  if (!['v1', 'v2'].includes(which)) throw new Error('first arg must be v1 or v2');
  const sql = rest[0] === '--file' ? fs.readFileSync(rest[1], 'utf8') : rest.join(' ');
  const c = await connect(which, { readOnly: true });
  try {
    const res = await c.query(sql);
    const list = Array.isArray(res) ? res : [res];
    for (const r of list) {
      if (r.rows && r.rows.length) console.log(JSON.stringify(r.rows, null, 1));
      else console.log(`-- ${r.command || 'OK'}: ${r.rowCount} row(s)`);
    }
  } finally {
    await c.end();
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
