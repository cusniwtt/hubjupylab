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
| **Cookie Signing** | `itsdangerous.Signer` | `@elysiajs/cookie` with secrets |

---

## 3. Module-by-Module Design

### Module 0: Configuration (`src/config.ts`)
- Read `.env` via `Bun.env` (no dotenv needed — Bun loads `.env` automatically).
- Export constants: `ADMIN_USER`, `ADMIN_PASS`, `SECRET_KEY`, `HUB_PORT`, `HOST_IP`, `BASE_DIR`, `JUPYTERLAB_VERSION`, `PYTHON_VERSION`, `JUPYTER_PORT_START` (8081), `JUPYTER_PORT_END` (8089).
- Ensure `BASE_DIR` exists on import (`mkdirSync`).

### Module 1: Database (`src/db.ts`)
- **Engine**: Import `{ Database } from "bun:sqlite"`. Initialize connecting to `hubjupylab.db`.
- **Schema**: `users` table (id, username, password_hash, role, port, token, created_at, gpu_endpoint, gpu_token, gpu_ssh_host, gpu_ssh_port, gpu_init_status) and `gpu_config` table (single-row SSH config).
- **Security**: 
  - Hash password: `await Bun.password.hash(password, "bcrypt")`.
  - Verify password: `await Bun.password.verify(password, hash)`.
- **Seeding**: Admin auto-created if missing on startup using environment variables.
- **Functions**: `initDb()`, `createUser()`, `deleteUser()`, `getUserByUsername()`, `listUsers()`, `updateToken()`, `getUsedPorts()`, `getGpuConfig()`, `saveGpuConfig()`, `assignGpu()`, `unassignGpu()`, `updateGpuInitStatus()`.

### Module 2: Local Spawner (`src/spawner.ts`)
- Use `Bun.spawn` to control `tmux` and local virtual environment configurations.
- All process calls are async (`await proc.exited`).
- **Functions**: `setupUserEnv()`, `isSessionRunning()`, `spawnSession()`, `stopSession()`, `cleanupUserFiles()`, `getNextPort()`, `syncSessions()`.
- `syncSessions()` runs on startup — checks all DB users against running tmux sessions and clears tokens for dead sessions.

### Module 3: GPU VM Manager (`src/gpu.ts`)
- **SSH Connectivity**: `Bun.spawn(["ssh", ...])` for non-blocking remote command execution.
- **Rsync SSE Streaming**:
  - SSE streaming via `ReadableStream` returning `data: [line]\n\n`.
  - Consume subprocess stdout asynchronously using `ReadableStream` from Bun's `proc.stdout`.
  - Capture real-time progress, speed, ETA, and write details to logs inside `.gpu_logs/` and `.rsync_logs/` using `Bun.file().writer()`.
- **Functions**: `testGpuSsh()`, `stopGpuSession()`, `gpuInitStream()`, `rsyncToGpuStream()`, `rsyncFromGpuStream()`, `getLastGpuLog()`.

### Module 4: Web Server & Routing (`src/index.ts`)
- Initialize `Elysia` server.
- Mount `@elysiajs/static` to serve `static/` files at `/static`.
- Configure signed cookies for `hub_session` using Elysia's native cookie plugin.
- Nunjucks template rendering for all page and partial templates.

#### Full Endpoint List

**Auth:**
- `GET /` → `login.html`
- `POST /login` → authenticate, set cookie, redirect
- `GET /logout` → clear cookie, redirect

**User Dashboard:**
- `GET /dashboard` → `dashboard.html`
- `POST /session/start` → start JupyterLab, return partial or redirect
- `POST /session/stop` → stop JupyterLab, return partial or redirect
- `POST /session/restart` → restart JupyterLab, return partial or redirect
- `GET /session/status` → `partials/_dashboard_status.html` (polling)
- `GET /session/gpu/sync-to-stream` → SSE rsync to GPU
- `GET /session/gpu/sync-from-stream` → SSE rsync from GPU
- `GET /session/gpu/list-dirs` → JSON directory tree

**Admin Dashboard:**
- `GET /admin` → `admin.html`
- `POST /admin/users` → create user, return partial table body or redirect
- `POST /admin/users/:username` → delete user, return empty or redirect
- `POST /admin/session/start/:username` → start user session, return row partial
- `POST /admin/session/stop/:username` → stop user session, return row partial
- `POST /admin/session/restart/:username` → restart user session, return row partial
- `GET /admin/users/row/:username` → `partials/_admin_user_row.html`
- `GET /admin/users/status-poll` → `partials/_admin_user_table_body.html` (polling)
- `GET /admin/partials/gpu-select` → `partials/_admin_gpu_select.html`

**Admin GPU:**
- `POST /admin/gpu/assign/:username` → save GPU config, return row partial
- `POST /admin/gpu/unassign/:username` → remove GPU config, return row partial
- `GET /admin/gpu/init-stream/:username` → SSE GPU initialization
- `POST /admin/gpu/stop/:username` → stop GPU session, return row partial
- `POST /admin/gpu/reset/:username` → reset GPU status, return row partial
- `GET /admin/gpu/last-log/:username` → plain text last GPU log

**Admin Logs:**
- `GET /admin/logs` → `logs.html`
- `GET /admin/logs/view?filename=...` → JSON log content

**Error Handling:**
- Custom error handler for HTTP 307 redirects (equivalent to FastAPI exception handler).

### Module 5: Responsive UI Design (`static/style.css`)
- Adjust page layouts for viewports `< 768px` and `< 480px`.
- Refactor headers to stack vertically on mobile.
- Form controls and modals optimized with 100% width and responsive spacing.
- Convert `.user-table` to a list of stacked cards on mobile views using standard CSS `display: block` switches.
- GPU expandable panels: single-column layout on mobile.
- User sync controls: stack buttons vertically on mobile.

### Module 6: Deployment (`hubjupylab.service`)
- Update systemd service from `uvicorn main:app` to `bun run src/index.ts`.

---

## 4. Template Files (unchanged, reused via Nunjucks)

**Pages:**
- `templates/base.html` — layout shell
- `templates/login.html` — login form
- `templates/dashboard.html` — user dashboard
- `templates/admin.html` — admin dashboard
- `templates/logs.html` — admin log viewer

**Partials (HTMX swap targets):**
- `templates/partials/_admin_gpu_select.html`
- `templates/partials/_admin_user_row.html`
- `templates/partials/_admin_user_table_body.html`
- `templates/partials/_dashboard_status.html`

---

## 5. Migration Execution Phases

1. **Scaffold & Setup**: Initialize `package.json` with Elysia, Nunjucks, and TypeScript config.
2. **Config**: Write `src/config.ts`.
3. **Database & Passwords**: Write `src/db.ts` and test password equivalence with previous Python hashes.
4. **Local tmux Spawner**: Implement `src/spawner.ts` process commands.
5. **GPU SSE Streamer**: Implement `src/gpu.ts` with async stream handling.
6. **Elysia Routing**: Establish `src/index.ts` containing authentication middleware and all routes.
7. **Responsive Styling**: Modify `static/style.css` to enhance template scaling on mobile devices.
8. **Deployment**: Update `hubjupylab.service`.
9. **Verification**: Run end-to-end checks to ensure session starts, stops, and status polls are fully operational.
