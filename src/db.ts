import { Database } from "bun:sqlite";
import { join } from "node:path";
import { BASE_DIR, ADMIN_USER, ADMIN_PASS } from "./config";

const DB_PATH = process.env.DB_PATH || Bun.env.DB_PATH || join(BASE_DIR, "hubjupylab.db");
const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  port: number | null;
  token: string | null;
  created_at: string;
  gpu_endpoint: string | null;
  gpu_token: string | null;
  gpu_ssh_host: string | null;
  gpu_ssh_port: number | null;
  gpu_init_status: string | null;
}

export interface GpuConfig {
  id: number;
  ssh_host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_key_path: string;
  remote_base_dir: string;
}

export async function initDb(): Promise<void> {
  db.exec(`
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

  // Add GPU columns if missing
  const gpuCols = [
    "gpu_endpoint TEXT",
    "gpu_token TEXT",
    "gpu_ssh_host TEXT",
    "gpu_ssh_port INTEGER",
    "gpu_init_status TEXT",
  ];
  for (const col of gpuCols) {
    try {
      db.exec(`ALTER TABLE users ADD COLUMN ${col}`);
    } catch (_) {
      // Column already exists
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS gpu_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ssh_host TEXT NOT NULL DEFAULT '',
      ssh_port INTEGER NOT NULL DEFAULT 22,
      ssh_user TEXT NOT NULL DEFAULT 'root',
      ssh_key_path TEXT NOT NULL DEFAULT '/home/hubjupylab/.ssh/id_ed25519',
      remote_base_dir TEXT NOT NULL DEFAULT '/workspace'
    )
  `);
  db.exec("INSERT OR IGNORE INTO gpu_config (id, ssh_user, ssh_key_path, remote_base_dir) VALUES (1, 'root', '/home/hubjupylab/.ssh/id_ed25519', '/workspace')");

  // Seed admin if none exists
  const adminRow = db.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!adminRow) {
    const hash = await Bun.password.hash(ADMIN_PASS, "bcrypt");
    db.query("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(
      ADMIN_USER,
      hash
    );
  }
}

export async function createUser(
  username: string,
  password: string,
  role: string = "user",
  port: number | null = null
): Promise<boolean> {
  const hash = await Bun.password.hash(password, "bcrypt");
  try {
    db.query("INSERT INTO users (username, password_hash, role, port) VALUES (?, ?, ?, ?)").run(
      username,
      hash,
      role,
      port
    );
    return true;
  } catch (_) {
    return false; // IntegrityError (duplicate)
  }
}

export function deleteUser(username: string): void {
  db.query("DELETE FROM users WHERE username = ?").run(username);
}

export function getUserByUsername(username: string): User | null {
  return db.query("SELECT * FROM users WHERE username = ?").get(username) as User | null;
}

export function listUsers(): User[] {
  return db.query("SELECT * FROM users WHERE role != 'admin' ORDER BY port ASC").all() as User[];
}

export function updateToken(username: string, token: string | null): void {
  db.query("UPDATE users SET token = ? WHERE username = ?").run(token, username);
}

export function getUsedPorts(): number[] {
  const rows = db.query("SELECT port FROM users WHERE port IS NOT NULL").all() as { port: number }[];
  return rows.map((r) => r.port);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash);
}

export function getGpuConfig(): GpuConfig {
  const row = db.query("SELECT * FROM gpu_config WHERE id = 1").get() as GpuConfig | null;
  return row ?? {
    id: 1,
    ssh_host: "",
    ssh_port: 22,
    ssh_user: "root",
    ssh_key_path: "",
    remote_base_dir: "/workspace",
  };
}

export function saveGpuConfig(
  ssh_host: string,
  ssh_port: number,
  ssh_user: string,
  ssh_key_path: string,
  remote_base_dir: string
): void {
  db.query(`
    INSERT INTO gpu_config (id, ssh_host, ssh_port, ssh_user, ssh_key_path, remote_base_dir)
    VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      ssh_host = excluded.ssh_host,
      ssh_port = excluded.ssh_port,
      ssh_user = excluded.ssh_user,
      ssh_key_path = excluded.ssh_key_path,
      remote_base_dir = excluded.remote_base_dir
  `).run(ssh_host, ssh_port, ssh_user, ssh_key_path, remote_base_dir);
}

export function assignGpu(
  username: string,
  gpu_endpoint: string,
  gpu_token: string,
  gpu_ssh_host: string,
  gpu_ssh_port: number
): void {
  const user = getUserByUsername(username);
  let newStatus = "pending";
  if (user && user.gpu_ssh_host === gpu_ssh_host && user.gpu_ssh_port === gpu_ssh_port && user.gpu_init_status) {
    newStatus = user.gpu_init_status;
  }
  db.query(
    "UPDATE users SET gpu_endpoint = ?, gpu_token = ?, gpu_ssh_host = ?, gpu_ssh_port = ?, gpu_init_status = ? WHERE username = ?"
  ).run(gpu_endpoint, gpu_token, gpu_ssh_host, gpu_ssh_port, newStatus, username);
}

export function unassignGpu(username: string): void {
  db.query(
    "UPDATE users SET gpu_endpoint = NULL, gpu_token = NULL, gpu_ssh_host = NULL, gpu_ssh_port = NULL, gpu_init_status = NULL WHERE username = ?"
  ).run(username);
}

export function updateGpuInitStatus(username: string, status: string | null): void {
  db.query("UPDATE users SET gpu_init_status = ? WHERE username = ?").run(status, username);
}
