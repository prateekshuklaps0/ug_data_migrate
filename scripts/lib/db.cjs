/**
 * Shared DB access for the UG v1->v2 migration.
 *
 * Credentials are read from the two backend .env files - never hardcoded here.
 *   v1 (source, READ ONLY)  : old_crm_backend/.env  -> LeadsRDS
 *   v2 (target, prod)       : new_crm_backend/.env  -> anandi
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('C:/Users/Prateek/Desktop/Repos/new_crm_backend/node_modules/pg');

const REPOS = 'C:/Users/Prateek/Desktop/Repos';

function parseEnv(file) {
  const out = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in out)) out[key] = val;   // first non-commented wins, like dotenv
  }
  return out;
}

const V1_ENV = parseEnv(path.join(REPOS, 'old_crm_backend', '.env'));
const V2_ENV = parseEnv(path.join(REPOS, 'new_crm_backend', '.env'));

function v1Config() {
  return {
    host: V1_ENV.DB_READ_HOST || V1_ENV.DB_WRITE_HOST,
    port: Number(V1_ENV.DB_PORT || 5432),
    database: V1_ENV.DB_NAME,
    user: V1_ENV.DB_USER,
    password: V1_ENV.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
    application_name: 'ug-migration-audit-v1',
    statement_timeout: 600000,
  };
}

function v2Config() {
  return {
    host: V2_ENV.DB_HOST,
    port: Number(V2_ENV.DB_PORT || 5432),
    database: V2_ENV.DB_NAME,
    user: V2_ENV.DB_USER,
    password: V2_ENV.DB_PASSWORD,
    ssl: String(V2_ENV.DB_SSL) === 'true' ? { rejectUnauthorized: false } : false,
    application_name: 'ug-migration-audit-v2',
    statement_timeout: 600000,
  };
}

async function connect(which, { readOnly = true } = {}) {
  const client = new Client(which === 'v1' ? v1Config() : v2Config());
  await client.connect();
  if (readOnly) {
    await client.query('set default_transaction_read_only = on');
  }
  return client;
}

/**
 * The 2026-08-18 lesson: v2_leads carries trg_automation_v2_leads, which fires
 * for whoever does the INSERT/UPDATE and blasts real applicants with email/SMS.
 * Any session that writes to v2 MUST set this, at SESSION level (SET LOCAL is
 * discarded at each COMMIT), and MUST verify it read back.
 */
async function armAutomationGuard(client) {
  await client.query(`set app.skip_automation = 'true'`);
  const { rows } = await client.query(`select current_setting('app.skip_automation', true) as v`);
  if (rows[0].v !== 'true') {
    throw new Error(
      `FATAL: app.skip_automation did not read back as 'true' (got ${JSON.stringify(rows[0].v)}). ` +
      `Refusing to write - see incident_2026-08-18_automation_emails/README.md`
    );
  }
  return true;
}

module.exports = { connect, armAutomationGuard, v1Config, v2Config, REPOS };
