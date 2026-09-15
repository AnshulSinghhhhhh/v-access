// Postgres-backed version of the original node:sqlite db.js. Keeps the same
// db.prepare(sql).get/all/run(...params) shape the rest of the codebase
// already uses (with '?' placeholders) so call sites only need `await`
// added, not a full query rewrite. Uses a single persistent pg.Client
// (not a Pool) so the existing db.exec('BEGIN'/'COMMIT'/'ROLLBACK')
// transaction pattern in timetable/social services keeps working exactly
// as before — one connection, used serially, same as the old SQLite handle.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';
import { hashPassword } from '../lib/password.js';

const { Client } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let client;
let readyPromise;

const NOW_ISO_MS = `to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function translateSql(sql) {
  // The codebase's SQLite-era inline "now, as ISO string" idiom — swap for
  // the Postgres equivalent used in schema.postgres.sql's own defaults.
  let translated = sql.replace(/strftime\(\s*'%Y-%m-%dT%H:%M:%fZ'\s*,\s*'now'\s*\)/g, NOW_ISO_MS);
  // Postgres returns COUNT(*) as a bigint (string), unlike SQLite which
  // returns a plain number — several call sites do arithmetic/comparisons
  // on it directly, so cast it back to a real integer here in one place
  // instead of patching every call site.
  translated = translated.replace(/COUNT\(\s*(?:DISTINCT\s+)?[\w.*]*\s*\)(?!::)/gi, (m) => `${m}::int`);
  let i = 0;
  translated = translated.replace(/\?/g, () => `$${++i}`);
  return translated;
}

class Statement {
  constructor(rawSql) {
    this.rawSql = rawSql.trim();
    this.sql = translateSql(rawSql);
  }

  async get(...params) {
    const res = await client.query(this.sql, params);
    return res.rows[0];
  }

  async all(...params) {
    const res = await client.query(this.sql, params);
    return res.rows;
  }

  async run(...params) {
    let sql = this.sql;
    // Postgres has no auto lastInsertRowid — every table's PK column is
    // `id`, so append RETURNING id to plain INSERTs (that don't already
    // have one) to emulate it. Never touches UPDATE/DELETE/other statements.
    const isInsert = /^insert/i.test(this.rawSql);
    const hasReturning = /returning/i.test(this.rawSql);
    if (isInsert && !hasReturning) sql += ' RETURNING id';
    const res = await client.query(sql, params);
    return {
      changes: res.rowCount,
      lastInsertRowid: isInsert ? res.rows[0]?.id : undefined,
    };
  }
}

class DbHandle {
  prepare(sql) {
    return new Statement(sql);
  }

  async exec(sql) {
    await client.query(sql);
  }
}

const handle = new DbHandle();

async function connectAndMigrate() {
  client = new Client({
    connectionString: env.databaseUrl,
    ssl: env.databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  const schema = readFileSync(path.join(__dirname, 'schema.postgres.sql'), 'utf8');
  await client.query(schema);

  await seedRoles();
  return handle;
}

// getDb() is now async — every call site does `const db = await getDb();`.
export function getDb() {
  if (!readyPromise) readyPromise = connectAndMigrate();
  return readyPromise;
}

export async function closeDb() {
  if (client) {
    await client.end();
    client = undefined;
    readyPromise = undefined;
  }
}

async function seedRoles() {
  await handle.prepare('INSERT INTO roles (name) VALUES (?) ON CONFLICT (name) DO NOTHING').run('student');
  await handle.prepare('INSERT INTO roles (name) VALUES (?) ON CONFLICT (name) DO NOTHING').run('admin');
}

export async function ensureDefaultAdmin() {
  const db = await getDb();
  const email = process.env.DEFAULT_ADMIN_EMAIL;
  const password = process.env.DEFAULT_ADMIN_PASSWORD;
  if (!email || !password) return;

  const existing = await db
    .prepare('SELECT id FROM users WHERE email = ?')
    .get(email.toLowerCase());
  if (existing) return;

  const adminRole = await db
    .prepare('SELECT id FROM roles WHERE name = ?')
    .get('admin');
  const passwordHash = await hashPassword(password);

  await db
    .prepare(
      `INSERT INTO users (full_name, email, password_hash, role_id, is_verified, is_active)
       VALUES (?, ?, ?, ?, 1, 1)`
    )
    .run('Default Admin', email.toLowerCase(), passwordHash, adminRole.id);

  console.log(`[setup] Default admin account created for ${email}`);
}
