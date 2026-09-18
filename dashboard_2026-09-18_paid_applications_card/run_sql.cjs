// Runs a .sql file against v2 as ONE script, the way "Execute script" does in a DB client.
//
// The whole file is sent in a single round trip, so DO $$ ... $$ blocks stay intact and
// the BEGIN/COMMIT inside the file controls the transaction. If any statement raises,
// the transaction is aborted and this rolls it back before disconnecting - nothing is left
// half-applied and nothing is committed.
//
// There is no --apply flag here: this runs whatever the file says. Use it with
// apply_payment_mode_update.sql / revert_payment_mode_update.sql, which carry their own
// guards, or with the read-only verify_*.sql files.
//
// Usage:
//   node run_sql.cjs apply_payment_mode_update.sql
//   node run_sql.cjs revert_payment_mode_update.sql
// Options: --env <path>
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const argVal = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const FILE = args.find(a => !a.startsWith('--') && a !== argVal('--env'));
const BACKEND = path.join(__dirname, '..', 'new_crm_backend');
const ENV_PATH = path.resolve(argVal('--env') || path.join(BACKEND, '.env'));

if (!FILE) { console.error('Usage: node run_sql.cjs <file.sql> [--env <path>]'); process.exit(1); }
const SQL_PATH = path.resolve(FILE);
if (!fs.existsSync(SQL_PATH)) { console.error(`File not found: ${SQL_PATH}`); process.exit(1); }

require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: ENV_PATH });
const { Client } = require(path.join(BACKEND, 'node_modules', 'pg'));

const PROD_HOST = 'anandi.c1nvajieufmh.ap-south-1.rds.amazonaws.com';
const ALLOWED_HOSTS = [PROD_HOST, ...(process.env.FIX_ALLOW_TEST_HOST ? [process.env.FIX_ALLOW_TEST_HOST] : [])];

(async () => {
  const host = (process.env.DB_HOST || '').trim();
  if (!ALLOWED_HOSTS.includes(host)) {
    console.error(`\nABORTED: DB_HOST in ${ENV_PATH} is "${host}", expected v2 prod ${PROD_HOST}\nNothing was changed.`);
    process.exit(1);
  }

  const sql = fs.readFileSync(SQL_PATH, 'utf8');
  console.log(`File     : ${SQL_PATH}`);
  console.log(`Database : ${process.env.DB_USER}@${host}/${process.env.DB_NAME}`);
  console.log(`Statements are sent as one script; the file's own BEGIN/COMMIT controls the transaction.\n`);

  const c = new Client({
    host, port: Number(process.env.DB_PORT) || 5432, user: (process.env.DB_USER || '').trim(),
    password: process.env.DB_PASSWORD, database: (process.env.DB_NAME || '').trim(),
    ssl: String(process.env.DB_SSL).trim() === 'true' ? { rejectUnauthorized: false } : false,
    application_name: 'run_sql_ug',
  });
  await c.connect();

  try {
    const res = await c.query(sql);
    const results = Array.isArray(res) ? res : [res];
    for (const r of results) {
      if (r.command === 'SELECT' && r.rows && r.rows.length) {
        console.log(`--- ${r.command} (${r.rowCount} row${r.rowCount === 1 ? '' : 's'})`);
        console.table(r.rows.length > 20 ? r.rows.slice(0, 20) : r.rows);
        if (r.rows.length > 20) console.log(`    ... ${r.rows.length - 20} more rows not shown`);
      } else if (['INSERT', 'UPDATE', 'DELETE'].includes(r.command)) {
        console.log(`--- ${r.command} ${r.rowCount}`);
      } else if (r.command) {
        console.log(`--- ${r.command}`);
      }
    }
    await c.end();
    console.log('\nDone. The script committed.');
  } catch (e) {
    // The file opened its own transaction; make sure it is closed as a rollback.
    await c.query('ROLLBACK').catch(() => {});
    await c.end().catch(() => {});
    console.error(`\nABORTED: ${e.message}`);
    if (e.hint) console.error(`Hint: ${e.hint}`);
    console.error('The transaction was rolled back. Nothing was changed.');
    process.exit(1);
  }
})().catch(e => { console.error(`\nABORTED: ${e.message}\nNothing was changed.`); process.exit(1); });
