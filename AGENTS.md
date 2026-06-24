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
- **Rsync Progress Bar**: Real-time parsing of rsync SSE stream showing active file name, percent completion, transfer speed, and ETA with a dynamic progress bar.
- **Smoother GPU Launch**: Removed confirmation prompt on "Launch GPU Session" for faster entry.
- **Disk Logging & Caching**: Persistent logs under `{BASE_DIR}/.gpu_logs/` and `{BASE_DIR}/.rsync_logs/` with dedicated `/admin/logs` viewer. Expandable admin GPU panel pulls the last log from disk on expand.
- **Redesigned Expandable UI**: Replaced the legacy bottom GPU console card with clean, per-user expandable rows containing inputs, actions (Save, Init, Stop, Reset, Remove), and a live/historical console log viewer.
- **Decoupled Configuration & Wiping**: GPU configuration (SSH Host/Port, Endpoint URL) is saved independently of completion constraints, resolving the value-wipe bug. Explicit "Remove GPU" button is provided for complete teardown.


### 5. Interactive UI (HTMX & Alpine.js)
- **Zero Page Reloads**: Migrated user and admin dashboards to perform partial page swaps using [HTMX](file:///home/hubjupylab/hubjupylab/static/vendor/htmx.min.js) and [Alpine.js](file:///home/hubjupylab/hubjupylab/static/vendor/alpine.min.js).
- **Inline Controls**: Supports real-time session start, stop, restart updates with button dimming/loading spinner transitions.
- **Form Modal & Event Swaps**: Create user modal form closes dynamically on success and resets; GPU init dropdown select options sync reactively using custom `userListUpdated` HTMX body event trigger.
- **Global Toasts**: Custom `HX-Trigger` HTTP header parsing displays success/error toasts.
- **Rsync Folder Explorer**: Collapsible folder tree browser allowing users to select directory paths to sync instead of typing them manually.
- **Status Auto-Update**: Continuous 5-second background polling to auto-update local server and GPU status on both user and admin dashboards using HTMX OOB swaps without interrupting open panels.

### 6. code-server Integration
- **Concurrent Spawning**: Runs `code-server` alongside `JupyterLab` in the same tmux session (`hub_{username}` locally and `gpu_{username}` remotely) in separate windows.
- **Port Mapping**: Local code-server port is dynamically set at `JupyterLab port + 100`; remote GPU VM runs code-server on port `8889`.
- **Credential Sharing**: Reuses JupyterLab session token as code-server authentication password.
- **Exclusion Filters**: Added `.code-server` configuration to `SYNC_EXCLUDES` to prevent synchronization overhead.

### 7. UI Dashboard Layout Refinements
- **Badge Indicator**: Added Session Password/Token display card above JupyterLab launcher button.
- **Collapsible URL Toggles**: Direct JupyterLab and Code Server URL boxes moved below launcher buttons and hidden behind Alpine.js show/hide toggles.
- **Button Icons**: Embedded SVG brand icons (Jupyter and Code Server logos) within both local and remote GPU VM launcher buttons.

### 8. Aesthetic Branding & Palette Update
- **Solid Dark Palette**: Configured site theme with solid background (removed radial gradients) and custom Color Hunt palette: `#191919` (Solid dark grey background), `#242424` (Solid card background), `#750e21` (deep burgundy red logo segment), `#e3651d` (primary accent orange highlights, hover, active tabs, and logo segment), and `#bed754` (success color, alerts, and logo segment).

### 9. Password Management & Security
- **Admin Password Reset**: Admins can reset user passwords. Generating a secure random 12-char OTP and displaying it on a centered Alpine.js window modal with copy options.
- **Forced Password Changes**: Resets flag `must_change_password` in DB. Users are forced to change their passwords before accessing any dashboard or session control endpoints.
- **User Password Updates**: Users can voluntarily change passwords at any time via a Change Password dashboard link.

---

## Technical Details

- **WSL Local Development**: Configured to bind on `127.0.0.1` inside WSL environment to support local Windows browser access.
- **Starlette TemplateResponse**: Position-independent keyword call style (`request=request, name=name, context=context`) prevents signature exceptions.
- **Nunjucks Development Caching**: Set `noCache: true` on Nunjucks configuration to enable immediate template updates without server restarts.

## Verification
Scripts available in [/scratch](file:///Users/cusniwtt/Developer/Repository/hubjupylab/scratch):
- [verify_hub.py](file:///Users/cusniwtt/Developer/Repository/hubjupylab/scratch/verify_hub.py): Standard verification of spawner, db, and user flows.
- [verify_admin_controls.py](file:///Users/cusniwtt/Developer/Repository/hubjupylab/scratch/verify_admin_controls.py): Verification of admin routes.
- [verify_gpu.py](file:///Users/cusniwtt/Developer/Repository/hubjupylab/scratch/verify_gpu.py): Verification of GPU config assignment and rsync failures.
- [verify_htmx_user_controls.py](file:///Users/cusniwtt/Developer/Repository/hubjupylab/scratch/verify_htmx_user_controls.py): Verification of user dashboard HTMX endpoints.
- [verify_htmx_admin_controls.py](file:///Users/cusniwtt/Developer/Repository/hubjupylab/scratch/verify_htmx_admin_controls.py): Verification of admin dashboard HTMX endpoints.
- [verify_list_dirs.py](file:///Users/cusniwtt/Developer/Repository/hubjupylab/scratch/verify_list_dirs.py): Verification of user directory listing for rsync.
- [verify_status_polling.py](file:///Users/cusniwtt/Developer/Repository/hubjupylab/scratch/verify_status_polling.py): Verification of status polling endpoints and OOB properties.
- [verify_reset_password.ts](file:///Users/cusniwtt/Developer/Repository/hubjupylab/scratch/verify_reset_password.ts): End-to-end integration test verifying admin password resets, database flag setting, force redirects to `/change-password`, and password change updates.
