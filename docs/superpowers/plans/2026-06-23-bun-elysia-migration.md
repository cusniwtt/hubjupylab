# HubJupyLab Bun + Elysia Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate HubJupyLab from Python/FastAPI to TypeScript/Bun/Elysia JS, fixing subprocess blocking and adding responsive mobile CSS.

**Architecture:** Bun runtime with Elysia JS framework, `bun:sqlite` for database, `Bun.spawn` for async subprocess control (tmux, SSH, rsync), Nunjucks for rendering existing Jinja2 templates, and responsive CSS media queries.

**Tech Stack:** Bun, Elysia JS, `bun:sqlite`, Nunjucks, HTMX, Alpine.js, vanilla CSS

## Global Constraints

- Bun >= 1.1 (native `bun:sqlite`, `Bun.spawn`, `Bun.password`, `Bun.env`)
- All source files under `src/` directory
- Existing `templates/` and `static/` directories reused in-place (not moved)
- Existing `.env` file format unchanged
- SQLite database `hubjupylab.db` schema unchanged (backward compatible)
- All subprocess calls must be async (`Bun.spawn` + `await proc.exited`)
- No Python dependencies in new stack

---

### Task 1: Project Scaffold & Dependencies

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Modify: `.gitignore` (add `node_modules/`, `bun.lock`)

**Interfaces:**
- Produces: Working `bun install` with all dependencies available for import

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "hubjupylab",
  "version": "2.0.0",
  "description": "Lightweight JupyterLab Hub using tmux — Bun + Elysia",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts"
  },
  "dependencies": {
    "elysia": "^1.2",
    "@elysiajs/static": "^1.2",
    "nunjucks": "^3.2"
  },
  "devDependencies": {
    "@types/nunjucks": "^3.2"
  }
}
```

Create file at `package.json`.

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "esModuleInterop": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Update .gitignore**

Append to existing `.gitignore`:

```
node_modules/
bun.lock
dist/
```

- [ ] **Step 4: Install dependencies**

Run: `bun install`
Expected: `node_modules/` created, `bun.lock` generated, no errors.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json .gitignore bun.lock
git commit -m "feat: scaffold Bun + Elysia project"
```

---

### Task 2: Configuration Module (`src/config.ts`)

**Files:**
- Create: `src/config.ts`

**Interfaces:**
- Consumes: `.env` file (loaded automatically by Bun)
- Produces: Named exports `ADMIN_USER`, `ADMIN_PASS`, `SECRET_KEY`, `HUB_PORT`, `HOST_IP`, `BASE_DIR`, `JUPYTERLAB_VERSION`, `PYTHON_VERSION`, `JUPYTER_PORT_START`, `JUPYTER_PORT_END`, `SSH_KEY_PATH`, `SSH_USER`, `REMOTE_BASE_DIR`

- [ ] **Step 1: Write config.ts**

```typescript
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const ADMIN_USER = Bun.env.ADMIN_USER ?? "admin";
export const ADMIN_PASS = Bun.env.ADMIN_PASS ?? "admin";
export const SECRET_KEY = Bun.env.SECRET_KEY ?? "dev-secret-key-please-change-in-prod";
export const HUB_PORT = parseInt(Bun.env.HUB_PORT ?? "8080", 10);
export const HOST_IP = Bun.env.HOST_IP?.trim() ?? "";
export const BASE_DIR = Bun.env.BASE_DIR ?? "/home/hubjupylab";
export const JUPYTERLAB_VERSION = Bun.env.JUPYTERLAB_VERSION ?? "4.4.1";
export const PYTHON_VERSION = Bun.env.PYTHON_VERSION ?? "3.14";

export const JUPYTER_PORT_START = 8081;
export const JUPYTER_PORT_END = 8089;

export const SSH_KEY_PATH = "/home/hubjupylab/.ssh/id_ed25519";
export const SSH_USER = "root";
export const REMOTE_BASE_DIR = "/workspace";

// Ensure BASE_DIR exists
mkdirSync(BASE_DIR, { recursive: true });
```

- [ ] **Step 2: Verify config loads**

Run: `bun run -e "import * as c from './src/config'; console.log(c.ADMIN_USER, c.HUB_PORT, c.BASE_DIR)"`
Expected: Prints `admin 8080 /home/hubjupylab`

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add config module reading .env"
```

---

### Task 3: Database Module (`src/db.ts`)

**Files:**
- Create: `src/db.ts`

**Interfaces:**
- Consumes: `src/config.ts` (`BASE_DIR`, `ADMIN_USER`, `ADMIN_PASS`)
- Produces: `initDb()`, `createUser(username, password, role?, port?)`, `deleteUser(username)`, `getUserByUsername(username)`, `listUsers()`, `updateToken(username, token)`, `getUsedPorts()`, `getGpuConfig()`, `saveGpuConfig(...)`, `assignGpu(...)`, `unassignGpu(username)`, `updateGpuInitStatus(username, status)`, `verifyPassword(password, hash)` — all exported functions. Also exports `User` and `GpuConfig` types.

- [ ] **Step 1: Write db.ts with types and connection**

```typescript
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { BASE_DIR, ADMIN_USER, ADMIN_PASS } from "./config";

const DB_PATH = join(BASE_DIR, "hubjupylab.db");
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
```

- [ ] **Step 2: Write initDb function**

```typescript
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
      ssh_key_path TEXT NOT NULL DEFAULT '',
      remote_base_dir TEXT NOT NULL DEFAULT '/workspace'
    )
  `);
  db.exec("INSERT OR IGNORE INTO gpu_config (id) VALUES (1)");

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
```

- [ ] **Step 3: Write CRUD functions**

```typescript
export async function createUser(
  username: string,
  password: string,
  role: string = "user",
  port: number | null = null
): Promise<boolean> {
  const hash = await Bun.password.hash(password, "bcrypt");
  try {
    db.query("INSERT INTO users (username, password_hash, role, port) VALUES (?, ?, ?, ?)").run(
      username, hash, role, port
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
```

- [ ] **Step 4: Write GPU config functions**

```typescript
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
  ssh_host: string, ssh_port: number, ssh_user: string,
  ssh_key_path: string, remote_base_dir: string
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
  username: string, gpu_endpoint: string, gpu_token: string,
  gpu_ssh_host: string, gpu_ssh_port: number
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
```

- [ ] **Step 5: Verify db module**

Run: `bun run -e "import { initDb, getUserByUsername } from './src/db'; await initDb(); console.log(getUserByUsername('admin'))"`
Expected: Prints admin user object with `role: 'admin'`.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts
git commit -m "feat: add database module with bun:sqlite"
```

---

### Task 4: Local Spawner Module (`src/spawner.ts`)

**Files:**
- Create: `src/spawner.ts`

**Interfaces:**
- Consumes: `src/config.ts` (`BASE_DIR`, `PYTHON_VERSION`, `JUPYTERLAB_VERSION`, `JUPYTER_PORT_START`, `JUPYTER_PORT_END`), `src/db.ts` (`listUsers`, `updateToken`, `getUsedPorts`)
- Produces: `setupUserEnv(username)`, `isSessionRunning(username)`, `spawnSession(username, port, token)`, `stopSession(username)`, `cleanupUserFiles(username)`, `getNextPort()`, `syncSessions()`, `getUserDir(username)`

- [ ] **Step 1: Write spawner.ts**

```typescript
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BASE_DIR, PYTHON_VERSION, JUPYTERLAB_VERSION, JUPYTER_PORT_START, JUPYTER_PORT_END } from "./config";
import { listUsers, updateToken, getUsedPorts } from "./db";

export function getUserDir(username: string): string {
  return join(BASE_DIR, username);
}

export async function setupUserEnv(username: string): Promise<boolean> {
  const userDir = getUserDir(username);
  mkdirSync(userDir, { recursive: true });

  const venvDir = join(userDir, ".venv");
  if (!existsSync(venvDir)) {
    // Create venv
    const venvProc = Bun.spawn(["uv", "venv", "--python", PYTHON_VERSION, venvDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await venvProc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(venvProc.stderr).text();
      console.error(`Error creating venv for ${username}: ${stderr}`);
      return false;
    }

    // Install jupyterlab
    const pythonBin = join(venvDir, "bin", "python");
    const installProc = Bun.spawn(
      ["uv", "pip", "install", `jupyterlab==${JUPYTERLAB_VERSION}`, "--python", pythonBin],
      { stdout: "pipe", stderr: "pipe" }
    );
    const installExit = await installProc.exited;
    if (installExit !== 0) {
      const stderr = await new Response(installProc.stderr).text();
      console.error(`Error installing jupyterlab for ${username}: ${stderr}`);
      return false;
    }
  }
  return true;
}

function getSessionName(username: string): string {
  return `hub_${username}`;
}

export async function isSessionRunning(username: string): Promise<boolean> {
  const proc = Bun.spawn(["tmux", "has-session", "-t", getSessionName(username)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
}

export async function spawnSession(username: string, port: number, token: string): Promise<boolean> {
  if (!(await setupUserEnv(username))) return false;

  if (await isSessionRunning(username)) {
    await stopSession(username);
  }

  const sessionName = getSessionName(username);
  const userDir = getUserDir(username);
  const jupyterBin = join(userDir, ".venv", "bin", "jupyter");

  const jupyterCmd = `cd ${userDir} && exec ${jupyterBin} lab --ip=0.0.0.0 --port=${port} --IdentityProvider.token=${token} --no-browser --notebook-dir=${userDir}`;

  const proc = Bun.spawn(["tmux", "new-session", "-d", "-s", sessionName, jupyterCmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(`Error spawning tmux session for ${username}: ${stderr}`);
    return false;
  }
  return true;
}

export async function stopSession(username: string): Promise<boolean> {
  if (!(await isSessionRunning(username))) return true;
  const proc = Bun.spawn(["tmux", "kill-session", "-t", getSessionName(username)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
}

export function cleanupUserFiles(username: string): void {
  const userDir = getUserDir(username);
  if (existsSync(userDir)) {
    rmSync(userDir, { recursive: true, force: true });
  }
}

export function getNextPort(): number | null {
  const used = new Set(getUsedPorts());
  for (let port = JUPYTER_PORT_START; port <= JUPYTER_PORT_END; port++) {
    if (!used.has(port)) return port;
  }
  return null;
}

export async function syncSessions(): Promise<void> {
  const users = listUsers();
  for (const user of users) {
    if (!(await isSessionRunning(user.username)) && user.token !== null) {
      updateToken(user.username, null);
    }
  }
}
```

- [ ] **Step 2: Verify spawner compiles**

Run: `bun run -e "import { getNextPort, getUserDir } from './src/spawner'; import { initDb } from './src/db'; await initDb(); console.log('nextPort:', getNextPort()); console.log('dir:', getUserDir('testuser'))"`
Expected: Prints a port number and a path.

- [ ] **Step 3: Commit**

```bash
git add src/spawner.ts
git commit -m "feat: add spawner module with async Bun.spawn"
```

---

### Task 5: GPU VM Manager Module (`src/gpu.ts`)

**Files:**
- Create: `src/gpu.ts`

**Interfaces:**
- Consumes: `src/config.ts` (`BASE_DIR`, `SSH_KEY_PATH`, `SSH_USER`, `REMOTE_BASE_DIR`), `src/db.ts` (`getUserByUsername`, `updateGpuInitStatus`, `getGpuConfig`)
- Produces: `testGpuSsh(host, port)`, `stopGpuSession(username)`, `gpuInitStream(username, host, port, keyPath, sshUser, token, endpoint)`, `rsyncToGpuStream(username, subpath?)`, `rsyncFromGpuStream(username, subpath?)`, `getLastGpuLog(username)`

- [ ] **Step 1: Write gpu.ts — SSH helpers and stop**

```typescript
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { BASE_DIR, SSH_KEY_PATH, SSH_USER, REMOTE_BASE_DIR } from "./config";
import { getUserByUsername, updateGpuInitStatus, getGpuConfig } from "./db";

function timestamp(): string {
  const d = new Date();
  // UTC+7 offset
  const utc7 = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return utc7.toISOString().replace("T", " ").slice(0, 19);
}

function logTimestamp(): string {
  const d = new Date();
  const utc7 = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return utc7.toISOString().replace(/[-:T]/g, "").slice(0, 15).replace(/(\d{8})(\d{6})/, "$1-$2");
}

export async function testGpuSsh(sshHost: string, sshPort: number = 22): Promise<[boolean, string]> {
  if (!sshHost || !existsSync(SSH_KEY_PATH)) {
    return [false, "GPU SSH not configured or key not found"];
  }
  const proc = Bun.spawn([
    "ssh", "-p", String(sshPort),
    "-i", SSH_KEY_PATH,
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=10",
    `${SSH_USER}@${sshHost}`, "echo ok"
  ], { stdout: "pipe", stderr: "pipe" });

  const timer = setTimeout(() => proc.kill(), 15000);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    return [false, `SSH failed: ${stderr}`];
  }
  return [true, "SSH connection OK"];
}

export async function stopGpuSession(username: string): Promise<[boolean, string]> {
  const user = getUserByUsername(username);
  if (!user) return [false, `User ${username} not found`];

  const sshHost = user.gpu_ssh_host;
  const sshPort = user.gpu_ssh_port ?? 22;
  if (!sshHost || !existsSync(SSH_KEY_PATH)) {
    return [false, "GPU SSH not configured for user"];
  }

  try {
    const proc = Bun.spawn([
      "ssh", "-p", String(sshPort),
      "-i", SSH_KEY_PATH,
      "-o", "StrictHostKeyChecking=no",
      `${SSH_USER}@${sshHost}`,
      `tmux kill-session -t gpu_${username}`
    ], { stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    updateGpuInitStatus(username, "stopped");
    return [true, "GPU session stopped"];
  } catch (e: any) {
    return [false, `Failed to stop GPU session: ${e.message}`];
  }
}
```

- [ ] **Step 2: Write gpuInitStream — SSE ReadableStream**

```typescript
export function gpuInitStream(
  username: string, host: string, port: number,
  keyPath: string, sshUser: string, token: string, endpoint: string
): ReadableStream<string> {
  const logDir = join(BASE_DIR, ".gpu_logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${username}-${logTimestamp()}-gpu.log`);

  return new ReadableStream<string>({
    async start(controller) {
      const logWriter = Bun.file(logPath).writer();

      function emit(msg: string): void {
        const ts = timestamp();
        const line = `[${ts}] ${msg}\n`;
        logWriter.write(line);
        logWriter.flush();
        controller.enqueue(`data: ${msg}\n\n`);
      }

      updateGpuInitStatus(username, "running");
      emit("Starting GPU initialization...");

      const [ok, sshMsg] = await testGpuSsh(host, port);
      if (!ok) {
        emit(`SSH connection test failed: ${sshMsg}`);
        updateGpuInitStatus(username, "failed");
        emit("Initialization FAILED");
        controller.close();
        logWriter.end();
        return;
      }
      emit("SSH connection OK. Beginning environment setup.");

      async function runStep(stepName: string, remoteCmd: string): Promise<void> {
        emit(`--- ${stepName} ---`);
        const proc = Bun.spawn([
          "ssh", "-p", String(port), "-i", keyPath,
          "-o", "StrictHostKeyChecking=no",
          `${sshUser}@${host}`, remoteCmd
        ], { stdout: "pipe", stderr: "pipe" });

        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const l of lines) {
            emit(`  [${stepName}] ${l}`);
          }
        }
        if (buffer) emit(`  [${stepName}] ${buffer}`);

        const exitCode = await proc.exited;
        if (exitCode !== 0) throw new Error(`${stepName} failed with exit status ${exitCode}`);
      }

      try {
        await runStep("apt-update", "apt-get update -y");
        await runStep("apt-install", "apt-get install -y tmux vim btop rsync");
        await runStep("install-uv", "curl -LsSf https://astral.sh/uv/install.sh | sh");
        await runStep("mkdir-workspace", `mkdir -p ${REMOTE_BASE_DIR}/${username}`);
        await runStep("create-venv", `$HOME/.local/bin/uv venv --clear --python ${(await import("./config")).PYTHON_VERSION} ${REMOTE_BASE_DIR}/${username}/.venv`);
        await runStep("install-jupyter", `$HOME/.local/bin/uv pip install jupyterlab==${(await import("./config")).JUPYTERLAB_VERSION} --python ${REMOTE_BASE_DIR}/${username}/.venv/bin/python`);
        await runStep("kill-existing-tmux", `tmux kill-session -t gpu_${username} 2>/dev/null || true`);

        const jupyterCmd = `cd ${REMOTE_BASE_DIR}/${username} && exec ${REMOTE_BASE_DIR}/${username}/.venv/bin/jupyter lab --no-browser --port=8888 --ServerApp.allow_origin='${endpoint}' --ip=0.0.0.0 --allow-root --IdentityProvider.token=${token} --notebook-dir=${REMOTE_BASE_DIR}/${username}`;
        await runStep("spawn-jupyter", `tmux new-session -d -s gpu_${username} "${jupyterCmd}"`);
        await runStep("verify-tmux", `tmux has-session -t gpu_${username}`);

        updateGpuInitStatus(username, "ready");
        emit("Initialization SUCCESSFUL! GPU JupyterLab is now running.");
      } catch (e: any) {
        emit(`Error: ${e.message}`);
        updateGpuInitStatus(username, "failed");
        emit("Initialization FAILED");
      }

      controller.close();
      logWriter.end();
    },
  });
}
```

- [ ] **Step 3: Write rsync stream functions**

```typescript
export function rsyncToGpuStream(username: string, subpath: string = ""): ReadableStream<string> {
  return _rsyncStream(username, subpath, "to");
}

export function rsyncFromGpuStream(username: string, subpath: string = ""): ReadableStream<string> {
  return _rsyncStream(username, subpath, "from");
}

function _rsyncStream(username: string, subpath: string, direction: "to" | "from"): ReadableStream<string> {
  const logDir = join(BASE_DIR, ".rsync_logs");
  mkdirSync(logDir, { recursive: true });
  const suffix = direction === "to" ? "rsync-to" : "rsync-from";
  const logPath = join(logDir, `${username}-${logTimestamp()}-${suffix}.log`);

  return new ReadableStream<string>({
    async start(controller) {
      const logWriter = Bun.file(logPath).writer();

      function emit(msg: string): void {
        const ts = timestamp();
        logWriter.write(`[${ts}] ${msg}\n`);
        logWriter.flush();
        controller.enqueue(`data: ${msg}\n\n`);
      }

      const user = getUserByUsername(username);
      if (!user) { emit("Error: User not found"); controller.close(); logWriter.end(); return; }

      const sshHost = user.gpu_ssh_host;
      const sshPort = user.gpu_ssh_port ?? 22;
      if (!sshHost || !existsSync(SSH_KEY_PATH)) {
        emit("Error: GPU SSH not configured"); controller.close(); logWriter.end(); return;
      }

      const userDir = join(BASE_DIR, username);
      if (!existsSync(userDir)) {
        emit("Error: User directory not found"); controller.close(); logWriter.end(); return;
      }

      let syncSub = "";
      let targetDir = userDir;
      if (subpath) {
        targetDir = resolve(userDir, subpath);
        const resolvedUser = resolve(userDir);
        if (!targetDir.startsWith(resolvedUser)) {
          emit("Error: Path escapes user directory"); controller.close(); logWriter.end(); return;
        }
        if (direction === "from") {
          mkdirSync(targetDir, { recursive: true });
        } else if (!existsSync(targetDir)) {
          emit(`Error: Local directory '${subpath}' not found`); controller.close(); logWriter.end(); return;
        }
        syncSub = subpath.replace(/^\/+|\/+$/g, "");
      }

      const localPath = targetDir + "/";
      const remotePath = `${SSH_USER}@${sshHost}:${REMOTE_BASE_DIR}/${username}/${syncSub}/`;

      // Pre-create remote directory for "to" direction
      if (direction === "to") {
        const mkdirProc = Bun.spawn([
          "ssh", "-p", String(sshPort), "-i", SSH_KEY_PATH,
          "-o", "StrictHostKeyChecking=no", `${SSH_USER}@${sshHost}`,
          `mkdir -p ${REMOTE_BASE_DIR}/${username}/${syncSub}/`
        ], { stdout: "pipe", stderr: "pipe" });
        await mkdirProc.exited;
      }

      const src = direction === "to" ? localPath : remotePath;
      const dst = direction === "to" ? remotePath : localPath;

      const cmd = [
        "rsync", "-avz", "--delete", "-P",
        "--exclude", ".venv/", "--exclude", "__pycache__/",
        "-e", `ssh -p ${sshPort} -i ${SSH_KEY_PATH} -o StrictHostKeyChecking=no`,
        src, dst
      ];

      emit(`Starting rsync ${direction === "to" ? "to" : "from"} GPU...`);

      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const l of lines) {
          if (l.trim()) emit(l);
        }
      }
      if (buffer.trim()) emit(buffer);

      const exitCode = await proc.exited;
      if (exitCode === 0) {
        emit(direction === "to" ? "Sync complete SUCCESS" : "Sync back complete SUCCESS");
      } else {
        emit(`Sync ${direction === "to" ? "" : "back "}failed with exit code ${exitCode}`);
      }

      controller.close();
      logWriter.end();
    },
  });
}
```

- [ ] **Step 4: Write getLastGpuLog**

```typescript
export function getLastGpuLog(username: string): string {
  const logDir = join(BASE_DIR, ".gpu_logs");
  if (!existsSync(logDir)) return "No logs found.";

  const files = readdirSync(logDir)
    .filter((f) => f.startsWith(username) && f.endsWith("-gpu.log"))
    .sort();

  if (files.length === 0) return "No setup logs found for this user.";

  try {
    return readFileSync(join(logDir, files[files.length - 1]), "utf-8");
  } catch (e: any) {
    return `Error reading log file: ${e.message}`;
  }
}
```

- [ ] **Step 5: Verify gpu module compiles**

Run: `bun run -e "import { getLastGpuLog } from './src/gpu'; console.log(getLastGpuLog('nonexistent'))"`
Expected: Prints "No logs found." or "No setup logs found for this user."

- [ ] **Step 6: Commit**

```bash
git add src/gpu.ts
git commit -m "feat: add GPU VM manager with async SSE streams"
```

---

### Task 6: Elysia Web Server — Auth & Pages (`src/index.ts`)

**Files:**
- Create: `src/index.ts`

**Interfaces:**
- Consumes: All modules (`src/config.ts`, `src/db.ts`, `src/spawner.ts`, `src/gpu.ts`)
- Produces: Running HTTP server on `HUB_PORT` with all routes

- [ ] **Step 1: Write server bootstrap with Nunjucks, static files, auth helpers**

```typescript
import { Elysia, t } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import nunjucks from "nunjucks";
import crypto from "node:crypto";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync } from "node:fs";
import * as config from "./config";
import * as db from "./db";
import * as spawner from "./spawner";
import * as gpu from "./gpu";

// Configure Nunjucks
const njk = nunjucks.configure("templates", { autoescape: true });

function render(name: string, ctx: Record<string, any> = {}): string {
  return njk.render(name, ctx);
}

// Simple cookie signing using HMAC
function signCookie(value: string): string {
  const sig = crypto.createHmac("sha256", config.SECRET_KEY).update(value).digest("base64url");
  return `${value}.${sig}`;
}

function unsignCookie(signed: string): string | null {
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = crypto.createHmac("sha256", config.SECRET_KEY).update(value).digest("base64url");
  if (sig !== expected) return null;
  return value;
}

function getCurrentUser(cookie: Record<string, any>): db.User | null {
  const session = cookie?.hub_session?.value;
  if (!session) return null;
  const username = unsignCookie(session);
  if (!username) return null;
  return db.getUserByUsername(username);
}

function buildJupyterUrl(hostIp: string, port: number, token: string): string {
  return `http://${hostIp}:${port}/lab?token=${token}`;
}

function resolveHostIp(request: Request): string {
  if (config.HOST_IP) return config.HOST_IP;
  const url = new URL(request.url);
  return url.hostname;
}
```

- [ ] **Step 2: Write enrichment helpers (matching Python logic)**

```typescript
function buildAdminUserContext(username: string, request: Request): Record<string, any> | null {
  const user = db.getUserByUsername(username);
  if (!user) return null;
  const hostIp = resolveHostIp(request);
  const isRunning = /* await */ false; // will be called with await in route
  return { ...user, is_running: isRunning, jupyter_url: "" };
}

async function getEnrichedUsers(request: Request): Promise<Record<string, any>[]> {
  const users = db.listUsers();
  const hostIp = resolveHostIp(request);
  const enriched: Record<string, any>[] = [];
  for (const u of users) {
    const isRunning = await spawner.isSessionRunning(u.username);
    const jupyterUrl = isRunning && u.token ? buildJupyterUrl(hostIp, u.port!, u.token) : "";
    enriched.push({ ...u, is_running: isRunning, jupyter_url: jupyterUrl });
  }
  return enriched;
}

async function enrichUser(username: string, request: Request): Promise<Record<string, any> | null> {
  const user = db.getUserByUsername(username);
  if (!user) return null;
  const hostIp = resolveHostIp(request);
  const isRunning = await spawner.isSessionRunning(username);
  const jupyterUrl = isRunning && user.token ? buildJupyterUrl(hostIp, user.port!, user.token) : "";
  return { ...user, is_running: isRunning, jupyter_url: jupyterUrl };
}
```

- [ ] **Step 3: Write auth routes (GET /, POST /login, GET /logout)**

```typescript
// Initialize and start
await db.initDb();
await spawner.syncSessions();

const app = new Elysia()
  .use(staticPlugin({ prefix: "/static", assets: "static" }))

  // --- Auth Routes ---
  .get("/", ({ cookie, query, set }) => {
    const user = getCurrentUser(cookie);
    if (user) {
      set.redirect = user.role === "admin" ? "/admin" : "/dashboard";
      return;
    }
    return new Response(render("login.html", {
      user: null, error: query.error ?? null, success: query.success ?? null
    }), { headers: { "Content-Type": "text/html" } });
  })

  .post("/login", async ({ body, cookie, set }) => {
    const { username, password } = body as { username: string; password: string };
    const user = db.getUserByUsername(username);
    if (!user || !(await db.verifyPassword(password, user.password_hash))) {
      set.redirect = "/?error=Invalid+credentials";
      set.status = 303;
      return;
    }
    const signed = signCookie(username);
    set.redirect = user.role === "admin" ? "/admin" : "/dashboard";
    set.status = 303;
    set.headers["Set-Cookie"] = `hub_session=${signed}; HttpOnly; SameSite=Lax; Path=/`;
  })

  .get("/logout", ({ set }) => {
    set.redirect = "/";
    set.status = 302;
    set.headers["Set-Cookie"] = "hub_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
  })
```

- [ ] **Step 4: Write dashboard routes (user)**

Add to the Elysia chain:

```typescript
  .get("/dashboard", async ({ cookie, query, request, set }) => {
    const user = getCurrentUser(cookie);
    if (!user) { set.redirect = "/"; set.status = 302; return; }
    if (user.role === "admin") { set.redirect = "/admin"; set.status = 302; return; }

    const hostIp = resolveHostIp(request);
    const isRunning = await spawner.isSessionRunning(user.username);
    const jupyterUrl = isRunning && user.token ? buildJupyterUrl(hostIp, user.port!, user.token) : "";
    const hasGpu = !!user.gpu_endpoint;

    return new Response(render("dashboard.html", {
      user, is_running: isRunning, user_port: user.port,
      jupyter_url: jupyterUrl, error: query.error ?? null,
      success: query.success ?? null, has_gpu: hasGpu,
      gpu_endpoint: user.gpu_endpoint ?? ""
    }), { headers: { "Content-Type": "text/html" } });
  })
```

- [ ] **Step 5: Write user session control routes (start/stop/restart/status)**

Add to the chain — these routes follow the same HTMX partial / redirect pattern as the Python version. The key pattern is:

```typescript
  .post("/session/start", async ({ cookie, request, set, headers }) => {
    const user = getCurrentUser(cookie);
    if (!user) { set.redirect = "/"; set.status = 302; return; }
    if (user.role === "admin") { set.redirect = "/admin"; set.status = 302; return; }

    const username = user.username;
    const port = user.port!;
    const hostIp = resolveHostIp(request);
    const token = crypto.randomBytes(16).toString("base64url");
    const isHtmx = headers["hx-request"] === "true";

    const success = await spawner.spawnSession(username, port, token);
    if (!success) {
      if (isHtmx) {
        const isRunning = await spawner.isSessionRunning(username);
        const jurl = isRunning && user.token ? buildJupyterUrl(hostIp, port, user.token) : "";
        return new Response(render("partials/_dashboard_status.html", {
          is_running: isRunning, user_port: port, jupyter_url: jurl
        }), { headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({ showToast: { message: "Failed to start JupyterLab session", type: "error" } })
        }});
      }
      set.redirect = "/dashboard?error=Failed+to+start+JupyterLab+session";
      set.status = 303; return;
    }

    db.updateToken(username, token);
    if (isHtmx) {
      return new Response(render("partials/_dashboard_status.html", {
        is_running: true, user_port: port, jupyter_url: buildJupyterUrl(hostIp, port, token)
      }), { headers: {
        "Content-Type": "text/html",
        "HX-Trigger": JSON.stringify({ showToast: { message: "JupyterLab started", type: "success" } })
      }});
    }
    set.redirect = "/dashboard?success=JupyterLab+started"; set.status = 303;
  })
```

Repeat pattern for `POST /session/stop` and `POST /session/restart` (follow Python logic in `main.py` lines 462-552).

Add `GET /session/status`:

```typescript
  .get("/session/status", async ({ cookie, request, set }) => {
    const user = getCurrentUser(cookie);
    if (!user) { set.redirect = "/"; set.status = 302; return; }
    const hostIp = resolveHostIp(request);
    const isRunning = await spawner.isSessionRunning(user.username);
    const jupyterUrl = isRunning && user.token ? buildJupyterUrl(hostIp, user.port!, user.token) : "";
    return new Response(render("partials/_dashboard_status.html", {
      is_running: isRunning, user_port: user.port,
      jupyter_url: jupyterUrl, has_gpu: !!user.gpu_endpoint,
      gpu_endpoint: user.gpu_endpoint ?? "",
      gpu_init_status: user.gpu_init_status ?? "",
      gpu_token: user.gpu_token ?? "", user
    }), { headers: { "Content-Type": "text/html" } });
  })
```

- [ ] **Step 6: Write admin dashboard and user management routes**

```typescript
  .get("/admin", async ({ cookie, query, request, set }) => {
    const user = getCurrentUser(cookie);
    if (!user || user.role !== "admin") { set.redirect = "/"; set.status = 302; return; }
    const enriched = await getEnrichedUsers(request);
    return new Response(render("admin.html", {
      user, users: enriched, error: query.error ?? null, success: query.success ?? null
    }), { headers: { "Content-Type": "text/html" } });
  })

  .post("/admin/users", async ({ body, cookie, request, set, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") { set.redirect = "/"; set.status = 302; return; }
    const { username, password } = body as { username: string; password: string };
    const isHtmx = headers["hx-request"] === "true";

    // Validate
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      if (isHtmx) return new Response("", { status: 422, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "Username must be alphanumeric", type: "error" } })
      }});
      set.redirect = "/admin?error=Username+must+be+alphanumeric"; set.status = 303; return;
    }

    const port = spawner.getNextPort();
    if (!port) {
      if (isHtmx) return new Response("", { status: 422, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "No available ports left (limit 9)", type: "error" } })
      }});
      set.redirect = "/admin?error=No+available+ports+left+(limit+9)"; set.status = 303; return;
    }

    const created = await db.createUser(username, password, "user", port);
    if (!created) {
      if (isHtmx) return new Response("", { status: 422, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "Username already exists", type: "error" } })
      }});
      set.redirect = "/admin?error=Username+already+exists"; set.status = 303; return;
    }

    const envOk = await spawner.setupUserEnv(username);
    if (!envOk) {
      db.deleteUser(username);
      if (isHtmx) return new Response("", { status: 422, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "Failed to initialize venv for user", type: "error" } })
      }});
      set.redirect = "/admin?error=Failed+to+initialize+venv+for+user"; set.status = 303; return;
    }

    if (isHtmx) {
      const enriched = await getEnrichedUsers(request);
      return new Response(render("partials/_admin_user_table_body.html", { users: enriched }), {
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({ showToast: { message: `Created user ${username}`, type: "success" }, userListUpdated: null })
        }
      });
    }
    set.redirect = `/admin?success=Created+user+${username}`; set.status = 303;
  })
```

- [ ] **Step 7: Write remaining admin routes (delete, session controls, GPU, logs)**

Continue adding to the Elysia chain — follow the exact same HTMX partial/redirect pattern from `main.py` for each of:

- `POST /admin/users/:username` (delete user)
- `POST /admin/session/start/:username`
- `POST /admin/session/stop/:username`
- `POST /admin/session/restart/:username`
- `GET /admin/users/row/:username`
- `GET /admin/users/status-poll`
- `GET /admin/partials/gpu-select`
- `POST /admin/gpu/assign/:username`
- `POST /admin/gpu/unassign/:username`
- `GET /admin/gpu/init-stream/:username` — SSE: `return new Response(gpu.gpuInitStream(...), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } })`
- `POST /admin/gpu/stop/:username`
- `POST /admin/gpu/reset/:username`
- `GET /admin/gpu/last-log/:username`
- `GET /admin/logs` — render `logs.html`
- `GET /admin/logs/view` — JSON log content

- [ ] **Step 8: Write user GPU sync SSE routes and list-dirs**

```typescript
  .get("/session/gpu/sync-to-stream", ({ cookie, query, set }) => {
    const user = getCurrentUser(cookie);
    if (!user) { set.redirect = "/"; set.status = 302; return; }
    if (user.role === "admin") return new Response("Forbidden", { status: 403 });
    return new Response(gpu.rsyncToGpuStream(user.username, query.path ?? ""), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" }
    });
  })

  .get("/session/gpu/sync-from-stream", ({ cookie, query, set }) => {
    const user = getCurrentUser(cookie);
    if (!user) { set.redirect = "/"; set.status = 302; return; }
    if (user.role === "admin") return new Response("Forbidden", { status: 403 });
    return new Response(gpu.rsyncFromGpuStream(user.username, query.path ?? ""), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" }
    });
  })

  .get("/session/gpu/list-dirs", ({ cookie, set }) => {
    const user = getCurrentUser(cookie);
    if (!user) { set.redirect = "/"; set.status = 302; return; }
    if (user.role === "admin") return new Response("Forbidden", { status: 403 });

    const userDir = join(config.BASE_DIR, user.username);
    if (!existsSync(userDir)) return Response.json([]);

    function getTree(dir: string, base: string): any[] {
      const tree: any[] = [];
      try {
        const items = readdirSync(dir).sort();
        for (const name of items) {
          const full = join(dir, name);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            if ([".git", ".venv", "__pycache__", ".ipynb_checkpoints"].includes(name)) continue;
            const rel = full.slice(base.length + 1);
            tree.push({ name, path: rel, children: getTree(full, base) });
          }
        }
      } catch (_) {}
      return tree;
    }

    return Response.json(getTree(userDir, userDir));
  })
```

- [ ] **Step 9: Add server listen**

```typescript
  .listen(config.HUB_PORT);

console.log(`HubJupyLab running on http://0.0.0.0:${config.HUB_PORT}`);
```

- [ ] **Step 10: Test server starts**

Run: `bun run src/index.ts`
Expected: `HubJupyLab running on http://0.0.0.0:8080` — no crash. Stop with Ctrl+C.

- [ ] **Step 11: Commit**

```bash
git add src/index.ts
git commit -m "feat: add Elysia web server with all routes"
```

---

### Task 7: Responsive CSS (`static/style.css`)

**Files:**
- Modify: `static/style.css`

**Interfaces:**
- Consumes: Existing CSS variables and classes
- Produces: Responsive layouts for mobile/tablet viewports

- [ ] **Step 1: Add mobile breakpoint media queries**

Append to `static/style.css`:

```css
/* ========== RESPONSIVE STYLES ========== */

/* Tablet (< 768px) */
@media (max-width: 768px) {
  header {
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
  }

  .nav-user {
    width: 100%;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  main {
    padding: 1rem;
  }

  .card {
    padding: 1.25rem;
  }

  /* Table → stacked cards */
  .user-table thead {
    display: none;
  }

  .user-table, .user-table tbody, .user-table tr, .user-table td {
    display: block;
    width: 100%;
  }

  .user-table tr {
    margin-bottom: 1rem;
    padding: 1rem;
    background-color: var(--bg-card);
    border: 1px solid var(--border-color);
    border-radius: 8px;
  }

  .user-table td {
    padding: 0.4rem 0;
    border-bottom: none;
    text-align: left;
  }

  .user-table td::before {
    content: attr(data-label);
    font-weight: 600;
    color: var(--text-secondary);
    font-size: 0.75rem;
    display: block;
    margin-bottom: 0.15rem;
  }

  .action-cell {
    flex-wrap: wrap;
  }

  .controls-section {
    flex-direction: column;
  }

  .jupyter-url-box {
    flex-direction: column;
    align-items: stretch;
  }

  .jupyter-url-box code {
    word-break: break-all;
    white-space: normal;
  }

  .status-section {
    flex-direction: column;
    gap: 0.75rem;
    align-items: stretch;
  }
}

/* Mobile (< 480px) */
@media (max-width: 480px) {
  header {
    padding: 0.5rem 0.75rem;
  }

  .logo-container h1 {
    font-size: 1rem;
  }

  .nav-user span {
    font-size: 0.75rem;
  }

  main {
    padding: 0.75rem;
  }

  .card {
    padding: 1rem;
    border-radius: 8px;
  }

  .btn {
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
  }

  .toast-container {
    top: 0.5rem;
    right: 0.5rem;
    left: 0.5rem;
    max-width: 100%;
  }
}
```

- [ ] **Step 2: Add data-label attributes to admin table TDs**

Modify `templates/partials/_admin_user_row.html` — add `data-label` attributes to each `<td>`:

```html
<td data-label="Username">...
<td data-label="Port">...
<td data-label="Status">...
<td data-label="JupyterLab">...
<td data-label="Actions">...
<td data-label="GPU">...
```

- [ ] **Step 3: Test responsiveness**

Open browser dev tools, resize to 375px width. Verify:
- Header stacks vertically
- Table rows become stacked cards
- Buttons wrap properly
- No horizontal overflow

- [ ] **Step 4: Commit**

```bash
git add static/style.css templates/partials/_admin_user_row.html
git commit -m "feat: add responsive CSS for mobile and tablet"
```

---

### Task 8: Deployment Update (`hubjupylab.service`)

**Files:**
- Modify: `hubjupylab.service`

**Interfaces:**
- Consumes: Bun runtime path
- Produces: Updated systemd service file

- [ ] **Step 1: Update service file**

Replace `ExecStart` and `Environment` lines:

```ini
[Unit]
Description=HubJupyLab Service
After=network.target

[Service]
User=hubjupylab
WorkingDirectory=/home/hubjupylab/hubjupylab
ExecStart=/home/hubjupylab/.bun/bin/bun run src/index.ts
Restart=always
RestartSec=5
Environment=PATH=/home/hubjupylab/.bun/bin:/home/hubjupylab/.local/bin:/usr/bin:/usr/local/bin

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Commit**

```bash
git add hubjupylab.service
git commit -m "feat: update systemd service for Bun runtime"
```

---

### Task 9: End-to-End Verification

**Files:**
- No new files

**Interfaces:**
- Consumes: All previous tasks
- Produces: Verified working server

- [ ] **Step 1: Start server**

Run: `bun run src/index.ts`
Expected: `HubJupyLab running on http://0.0.0.0:8080`

- [ ] **Step 2: Test login flow**

```bash
# Login as admin
curl -c cookies.txt -L -X POST http://localhost:8080/login -d "username=admin&password=admin" -v 2>&1 | grep "Set-Cookie\|Location"
```
Expected: `Set-Cookie: hub_session=...` and redirect to `/admin`.

- [ ] **Step 3: Test admin page renders**

```bash
curl -b cookies.txt http://localhost:8080/admin | head -20
```
Expected: HTML containing "HubJupyLab" and admin dashboard markup.

- [ ] **Step 4: Test user creation via HTMX**

```bash
curl -b cookies.txt -X POST http://localhost:8080/admin/users \
  -H "HX-Request: true" \
  -d "username=testuser&password=test123" -v 2>&1 | grep "HX-Trigger"
```
Expected: `HX-Trigger` header with `showToast` success message.

- [ ] **Step 5: Test status polling**

```bash
curl -b cookies.txt http://localhost:8080/admin/users/status-poll | head -5
```
Expected: HTML partial with user rows.

- [ ] **Step 6: Clean up test data and commit any fixes**

```bash
git add -A && git commit -m "fix: end-to-end verification fixes"
```
