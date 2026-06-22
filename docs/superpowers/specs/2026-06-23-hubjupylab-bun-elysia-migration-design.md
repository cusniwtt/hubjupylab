# Design Spec: HubJupyLab Migration to Bun & Elysia JS

This document details the architectural migration of HubJupyLab from a Python/FastAPI stack to a TypeScript/Bun/Elysia JS stack, resolving blocking subprocess performance issues and optimizing the user interface for responsive mobile design.

## 1. Migration Goals

- **Resolve Subprocess Blocking**: Replace Python synchronous subprocess calls with non-blocking async processes using `Bun.spawn`.
- **Performance & Simplicity**: Leverage Bun's built-in fast runtime, native SQLite support (`bun:sqlite`), and native bcrypt implementation (`Bun.password`).
- **Template Compatibility**: Use `nunjucks` in JS to render the existing Jinja2 HTML templates, avoiding a complete rewrite of the interactive HTMX & Alpine.js frontend.
- **Responsive UI**: Apply custom CSS styles to existing templates to support seamless mobile layout scaling, responsive tables, and forms.

---

## 2. Technical Stack Mapping

| Layer | Python / FastAPI Stack | TypeScript / Bun Stack |
| :--- | :--- | :--- |
| **Runtime** | Python 3.14 + `uv` | Bun |
| **Framework** | FastAPI + Starlette | Elysia JS |
| **Database** | `sqlite3` | `bun:sqlite` |
| **Hashing** | `bcrypt` (python-bcrypt) | `Bun.password` (native bcrypt) |
| **Process Control** | `subprocess` (blocking / Popen) | `Bun.spawn` (native async subprocess) |
| **Templates** | `Jinja2Templates` | `nunjucks` (identical syntax) |
| **Static Files** | FastAPI `StaticFiles` | `@elysiajs/static` |

---

## 3. Module-by-Module Design

### Module 1: Database (`db.ts`)
- **Engine**: Import `{ Database } from "bun:sqlite"`. Initialize connecting to `hubjupylab.db`.
- **Compatibility**: Ensure SQL queries are compatible. The current schema tracks `users` and `gpu_config`.
- **Security**: 
  - Hash password: `Bun.password.hash(password, "bcrypt")`.
  - Verify password: `Bun.password.verify(password, hash)`.
- **Seeding**: Admin auto-created if missing on startup using environment variables.

### Module 2: Local Spawner (`spawner.ts`)
- Use `Bun.spawn` to control `tmux` and local virtual environment configurations.
- Spawning JupyterLab details:
  - Run `uv venv` and install `jupyterlab` as background processes.
  - Spawning tmux session: `Bun.spawn(["tmux", "new-session", "-d", "-s", "hub_" + username, jupyterCmd])`.
  - Process exits checked via `await proc.exited`.
- Cleanup: Utilize `node:fs` recursive removal (`fs.rmSync`).

### Module 3: GPU VM Manager (`gpu.ts`)
- **SSH Connectivity**: `Bun.spawn(["ssh", ...])` for non-blocking remote command execution.
- **Rsync SSE Streaming**:
  - SSE streaming via `ReadableStream` returning `data: [line]\n\n`.
  - Consume subprocess stdout asynchronously using Node's `readline` wrapper on the child process's stdout stream (`proc.stdout`).
  - Capture real-time progress, speed, ETA, and write details to logs inside `.gpu_logs/` and `.rsync_logs/` using `Bun.file().writer()`.

### Module 4: Web Server & Routing (`index.ts` / `server.ts`)
- Initialize `Elysia` server.
- Mount `@elysiajs/static` to serve `static/` files at `/static`.
- Configure signed cookies for `hub_session` using Elysia's native cookie plugin with secrets.
- Map endpoints to Nunjucks template renders:
  - `/` -> `login.html`
  - `/dashboard` -> `dashboard.html`
  - `/admin` -> `admin.html`
  - `/admin/logs` -> `logs.html`
- Serve HTMX action controllers (login, logout, start/stop/restart, status badges, log reading).

### Module 5: Responsive UI Design (`static/style.css`)
- Adjust page layouts for viewports `< 768px` and `< 480px`.
- Refactor headers to stack vertically on mobile.
- Form controls and modals optimized with 100% width and responsive spacing.
- Convert `.user-table` to a list of stacked cards on mobile views using standard CSS `display: block` switches.

---

## 4. Migration Execution Phases

1. **Scaffold & Setup**: Initialize `package.json` with Elysia, Nunjucks, and TypeScript types.
2. **Database & Passwords**: Write `db.ts` and test password equivalence with previous Python hashes.
3. **Local tmux Spawner**: Implement `spawner.ts` process commands.
4. **GPU SSE Streamer**: Implement `gpu.ts` with async stream handling.
5. **Elysia Routing**: Establish `index.ts` containing authentication middleware and routes.
6. **Responsive Styling**: Modify `static/style.css` to enhance template scaling on mobile devices.
7. **Verification**: Run unit/end-to-end checks to ensure session starts, stops, and status polls are fully operational.
