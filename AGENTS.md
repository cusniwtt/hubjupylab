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
- Disk Logging: Persistent logs under `{BASE_DIR}/.gpu_logs/` and `{BASE_DIR}/.rsync_logs/` with dedicated `/admin/logs` viewer.

### 5. Interactive UI (HTMX & Alpine.js)
- **Zero Page Reloads**: Migrated user and admin dashboards to perform partial page swaps using [HTMX](file:///home/hubjupylab/hubjupylab/static/vendor/htmx.min.js) and [Alpine.js](file:///home/hubjupylab/hubjupylab/static/vendor/alpine.min.js).
- **Inline Controls**: Supports real-time session start, stop, restart updates with button dimming/loading spinner transitions.
- **Form Modal & Event Swaps**: Create user modal form closes dynamically on success and resets; GPU init dropdown select options sync reactively using custom `userListUpdated` HTMX body event trigger.
- **Global Toasts**: Custom `HX-Trigger` HTTP header parsing displays success/error toasts.

---

## Technical Details

- **WSL Local Development**: Configured to bind on `127.0.0.1` inside WSL environment to support local Windows browser access.
- **Starlette TemplateResponse**: Position-independent keyword call style (`request=request, name=name, context=context`) prevents signature exceptions.

## Verification
Scripts available in [/scratch](file:///home/hubjupylab/hubjupylab/scratch):
- [verify_hub.py](file:///home/hubjupylab/hubjupylab/scratch/verify_hub.py): Standard verification of spawner, db, and user flows.
- [verify_admin_controls.py](file:///home/hubjupylab/hubjupylab/scratch/verify_admin_controls.py): Verification of admin routes.
- [verify_gpu.py](file:///home/hubjupylab/hubjupylab/scratch/verify_gpu.py): Verification of GPU config assignment and rsync failures.
- [verify_htmx_user_controls.py](file:///home/hubjupylab/hubjupylab/scratch/verify_htmx_user_controls.py): Verification of user dashboard HTMX endpoints.
- [verify_htmx_admin_controls.py](file:///home/hubjupylab/hubjupylab/scratch/verify_htmx_admin_controls.py): Verification of admin dashboard HTMX endpoints.
