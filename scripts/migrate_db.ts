#!/usr/bin/env bun
/**
 * migrate_db.ts
 * Migrate production database from the old FastAPI/Python version
 * into the new Bun/Elysia version.
 *
 * Strategy:
 *   - The old and new schemas are identical (same tables, same columns).
 *   - bcrypt hashes produced by Python's bcrypt library are fully compatible
 *     with Bun.password.verify() (both use $2b$ bcrypt).
 *   - We copy the real production DB from BASE_DIR/hubjupylab.db into the
 *     repo-level hubjupylab.db (which is what the new service reads),
 *     then run initDb() to apply any missing columns/seeds without overwriting.
 *
 * Usage:
 *   bun run scripts/migrate_db.ts [--dry-run]
 */

import { Database } from "bun:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");
const BASE_DIR = Bun.env.BASE_DIR ?? "/home/hubjupylab";

// Paths
const OLD_DB = join(BASE_DIR, "hubjupylab.db");           // real production DB
const NEW_DB = join(import.meta.dir, "..", "hubjupylab.db"); // repo-root DB the service reads
const BACKUP  = join(BASE_DIR, `hubjupylab.db.backup-${Date.now()}`);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) { console.log(`[migrate] ${msg}`); }

function inspect(db: Database, label: string) {
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
  log(`${label} tables: ${tables.map(t => t.name).join(", ")}`);
  for (const { name } of tables) {
    if (name === "sqlite_sequence") continue;
    const count = db.query(`SELECT COUNT(*) as n FROM "${name}"`).get() as { n: number };
    log(`  ${name}: ${count.n} rows`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

log("=== HubJupyLab DB Migration ===");
log(`Source (old): ${OLD_DB}`);
log(`Target (new): ${NEW_DB}`);
log(`Dry run: ${DRY_RUN}`);

// 1. Verify source exists and has data
if (!existsSync(OLD_DB)) {
  console.error(`ERROR: Old DB not found at ${OLD_DB}`);
  process.exit(1);
}

const oldDbSize = Bun.file(OLD_DB).size;
if (oldDbSize === 0) {
  log("WARNING: Old DB is empty (0 bytes). Nothing to migrate.");
  process.exit(0);
}
log(`Old DB size: ${oldDbSize} bytes`);

// 2. Inspect old DB
const oldDb = new Database(OLD_DB, { readonly: true });
inspect(oldDb, "OLD");

const oldUsers = oldDb.query("SELECT id, username, password_hash, role, port, token, gpu_endpoint, gpu_token, gpu_ssh_host, gpu_ssh_port, gpu_init_status, created_at FROM users").all() as any[];
const oldGpuConfig = oldDb.query("SELECT * FROM gpu_config").all() as any[];
oldDb.close();

log(`\nUsers to migrate: ${oldUsers.length}`);
for (const u of oldUsers) {
  log(`  - ${u.username} (role=${u.role}, port=${u.port ?? "null"})`);
}
log(`GPU config rows: ${oldGpuConfig.length}`);

if (DRY_RUN) {
  log("\nDRY RUN: no changes made.");
  process.exit(0);
}

// 3. Backup existing new DB if it has data
if (existsSync(NEW_DB) && Bun.file(NEW_DB).size > 0) {
  log(`\nBacking up existing new DB to: ${BACKUP}`);
  copyFileSync(NEW_DB, BACKUP);
  log("Backup done.");
}

// 4. Open/create new DB and apply schema (same as initDb() in src/db.ts)
log("\nApplying schema to new DB...");
const newDb = new Database(NEW_DB, { create: true });
newDb.exec("PRAGMA journal_mode = WAL");

newDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    port INTEGER UNIQUE,
    token TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

const gpuCols = [
  "gpu_endpoint TEXT",
  "gpu_token TEXT",
  "gpu_ssh_host TEXT",
  "gpu_ssh_port INTEGER",
  "gpu_init_status TEXT",
];
for (const col of gpuCols) {
  try { newDb.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch (_) {}
}

newDb.exec(`
  CREATE TABLE IF NOT EXISTS gpu_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    ssh_host TEXT NOT NULL DEFAULT '',
    ssh_port INTEGER NOT NULL DEFAULT 22,
    ssh_user TEXT NOT NULL DEFAULT 'root',
    ssh_key_path TEXT NOT NULL DEFAULT '',
    remote_base_dir TEXT NOT NULL DEFAULT '/workspace'
  )
`);
newDb.exec("INSERT OR IGNORE INTO gpu_config (id) VALUES (1)");

// 5. Migrate users (INSERT OR REPLACE to handle re-runs safely)
log("\nMigrating users...");
const insertUser = newDb.prepare(`
  INSERT OR REPLACE INTO users
    (id, username, password_hash, role, port, token, gpu_endpoint, gpu_token,
     gpu_ssh_host, gpu_ssh_port, gpu_init_status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const u of oldUsers) {
  insertUser.run(
    u.id, u.username, u.password_hash, u.role, u.port, u.token,
    u.gpu_endpoint, u.gpu_token, u.gpu_ssh_host, u.gpu_ssh_port,
    u.gpu_init_status, u.created_at
  );
  log(`  ✓ Migrated user: ${u.username}`);
}

// 6. Migrate gpu_config
log("\nMigrating gpu_config...");
for (const g of oldGpuConfig) {
  newDb.query(`
    INSERT INTO gpu_config (id, ssh_host, ssh_port, ssh_user, ssh_key_path, remote_base_dir)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      ssh_host = excluded.ssh_host,
      ssh_port = excluded.ssh_port,
      ssh_user = excluded.ssh_user,
      ssh_key_path = excluded.ssh_key_path,
      remote_base_dir = excluded.remote_base_dir
  `).run(g.id, g.ssh_host, g.ssh_port, g.ssh_user, g.ssh_key_path, g.remote_base_dir);
  log(`  ✓ Migrated gpu_config id=${g.id} (host=${g.ssh_host}:${g.ssh_port})`);
}

newDb.close();

// 7. Final verification
log("\n=== Verification ===");
const verDb = new Database(NEW_DB, { readonly: true });
inspect(verDb, "NEW");
const newUsers = verDb.query("SELECT username, role, port FROM users").all() as any[];
for (const u of newUsers) {
  log(`  user: ${u.username} role=${u.role} port=${u.port ?? "null"}`);
}
verDb.close();

log("\n✅ Migration complete!");
log(`   Backup saved at: ${BACKUP}`);
log("   The new service will read the migrated DB on next start.");
