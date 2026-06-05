# Agent Log - HubJupyLab

Agent log documenting changes, design choices, and workspace status for pair-programming assistant.

## Features Implemented

### 1. Core Architecture
- **Isolated User Directories**: Every user is housed at `{BASE_DIR}/{username}`.
- **Dedicated uv Virtual Environments**: Automatically initializes a virtual environment using Python 3.14 via `uv`.
- **tmux Spawner**: Detached tmux session `hub_{username}` runs JupyterLab, surviving Hub restarts.
- **Port Spacing**: Dynamically assigns ports `8081-8089` (max 9 users).
- **SQLite DB Layer**: Tracks users, ports, tokens, and bcrypt-hashed credentials. Seeding admin credentials on startup.

### 2. Admin Capabilities
- Create new users.
- Delete users with checkbox to optionally purge all user files.
- Start, stop, and restart user JupyterLab sessions.

### 3. User Capabilities
- Manage own session (start, stop, restart).
- Grab secure token-based URL to access JupyterLab.

### 4. GPU VM Spawning & Synchronization
- **RunPod GPU VM Spawning**: Admin can assign a separate GPU VM to each user.
- **Automated initialization**: Remote setup via SSH (apt packages, uv venv, JupyterLab installation, tmux session `gpu_{username}`).
- **SSE progress streaming**: Live console feedback for both GPU initialization (admin console) and rsync progress (user console).
- **GPU Init State Machine**: `NULL` -> `pending` -> `running` -> `ready` / `failed` / `stopped`.
- **Manual Rsync Controls**: Replaced auto-rsync with manual "Sync To GPU" and "Sync From GPU" triggers on user dashboard to reduce sync complexity.
- **Disk Logging**: Persistent logs under `{BASE_DIR}/.gpu_logs/` and `{BASE_DIR}/.rsync_logs/` with dedicated `/admin/logs` viewer.

---

## Technical Details

- **WSL Local Development**: Configured to bind on `127.0.0.1` inside WSL environment to support local Windows browser access.
- **Starlette TemplateResponse**: Position-independent keyword call style (`request=request, name=name, context=context`) prevents signature exceptions.

## Verification
Scripts available in `/scratch`:
- `verify_hub.py`: Standard verification of spawner, db, and user flows.
- `verify_admin_controls.py`: Verification of admin routes.
- `verify_gpu.py`: Verification of GPU config assignment and rsync failures.
