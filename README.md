# HubJupyLab

HubJupyLab is a lightweight JupyterLab Hub built with **TypeScript, Bun, and Elysia JS** designed for small teams (up to 9 users). It runs on a single host machine, spawning user JupyterLab instances inside `tmux` sessions. Each user is isolated in their own directory with a dedicated virtual environment managed by `uv` (on the local VM) and remote GPU VMs.

## Features

- **Isolated User Environments**: Each user gets their own `uv` virtual environment and folder inside the base directory.
- **`tmux`-Managed Sessions**: JupyterLab runs in detached tmux sessions, surviving hub restarts.
- **Port Allocation**: Automatically assigns unique ports from `8081-8089` to users.
- **Token-Auth Security**: Generates unique, secure access tokens for each JupyterLab session.
- **Clean Admin Dashboard**: Create/delete users, start/stop/restart any user's session, see server status, and optionally clean up user files.
- **User Dashboard**: Users can start, stop, restart, and copy their JupyterLab endpoint URL.
- **Modern Interactive UI**: Powered by [HTMX](file:///home/hubjupylab/hubjupylab/static/vendor/htmx.min.js) and [Alpine.js](file:///home/hubjupylab/hubjupylab/static/vendor/alpine.min.js) for zero page reloads, live controls, inline form/dropdown updates, and global toast alerts.
- **GPU VM Spawning & Syncing**: Assign remote GPU VMs (e.g. RunPod) to users with automated initialization (venv, JupyterLab) over SSH, and manual sync controls ("Sync To GPU" and "Sync From GPU") utilizing a real-time parsed multi-threaded Zstd-compressed Tar progress stream.

---

## Prerequisites

Before running HubJupyLab, make sure the following are installed on the host system:

### 1. Bun (JavaScript Runtime)
Bun is used to run the Elysia JS web server:
```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. `uv` (Fast Python Package Installer)
If not installed, install it system-wide to provision local python environments:
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### 3. Python 3.14
Ensure Python 3.14 is available on the host system. `uv` will download it automatically when creating virtual environments if it's not found.

### 4. `tmux`
HubJupyLab runs JupyterLab inside tmux sessions.
```bash
sudo apt update && sudo apt install -y tmux zstd
```

---

## Installation & Setup

1. **Extract/Clone files** to `/home/hubjupylab`.
2. **Configure Environment Variables**:
   Copy `env.template` to `.env` and adjust variables.
   ```bash
   cp env.template .env
   ```
   **Important settings in `.env`**:
   - `ADMIN_USER`: Admin username for the web UI.
   - `ADMIN_PASS`: Admin password for the web UI.
   - `SECRET_KEY`: Long random string to secure session cookies.
   - `BASE_DIR`: Directory where user environments will reside (e.g., `/home/hubjupylab`). Ensure the running user has read/write permissions here.
   - `HOST_IP`: The IP address or hostname of the VM (e.g. `192.168.1.100`) so JupyterLab links generated are reachable on your VPN/network.

---

## Running the Hub

### Development / Manual Run
To start the hub manually:
```bash
bun run src/index.ts
```
Then access the dashboard at `http://<host-ip>:8080`.

### Production (Systemd)

**Quick install** (recommended):
```bash
sudo bash scripts/install.sh
```
This handles all steps below automatically: copies the service file, sets ownership, enables linger, reloads systemd, and starts the service.

**Manual install**:

1. Configure `.env` (required — the service will not load defaults without it):
   ```bash
   cp env.template .env
   # Edit .env: set SECRET_KEY, ADMIN_PASS, HOST_IP, NODE_ENV=production, etc.
   ```
2. Copy the service file:
   ```bash
   sudo cp hubjupylab.service /etc/systemd/system/
   ```
3. Set ownership:
   ```bash
   sudo chown -R hubjupylab:hubjupylab /home/hubjupylab/hubjupylab /home/hubjupylab/hubjupylab.db*
   ```
4. Enable systemd linger (keeps tmux sessions alive across service restarts):
   ```bash
   sudo loginctl enable-linger hubjupylab
   ```
5. Reload, enable, and start:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now hubjupylab
   ```
6. Check status and logs:
   ```bash
   sudo systemctl status hubjupylab
   sudo journalctl -u hubjupylab -f
   ```

**Notes:**
- `XDG_RUNTIME_DIR` uses the `%U` systemd specifier (expands to the UID of `User=hubjupylab`) — no hardcoded UID needed.
- The service loads `.env` via `EnvironmentFile=` — all config lives in one place.
- `NODE_ENV=production` in `.env` enables startup guards: the service refuses to start if `SECRET_KEY` or `ADMIN_PASS` are still at default values.

---

## Architecture details

- **User directories**: Each user gets a directory at `{BASE_DIR}/{username}` containing their `.venv/` and notebook workspace.
- **SQLite Database**: A SQLite file `hubjupylab.db` is stored inside `{BASE_DIR}` to track user credentials, ports, current session tokens, and assigned GPU configs.
- **tmux Sessions**: Created using session name `hub_{username}` locally and `gpu_{username}` on remote VMs. Use `tmux list-sessions` to view running instances.
- **GPU Synchronization**: Manual Zstd-compressed Tar stream synchronizes files between local `{BASE_DIR}/{username}` and remote workspace over SSH.

