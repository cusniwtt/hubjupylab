# HubJupyLab

HubJupyLab is a lightweight JupyterLab Hub designed for small teams (up to 9 users). It runs on a single host machine, spawning user JupyterLab instances inside `tmux` sessions. Each user is isolated in their own directory with a dedicated virtual environment managed by `uv`.

## Features

- **Isolated User Environments**: Each user gets their own `uv` virtual environment and folder inside the base directory.
- **`tmux`-Managed Sessions**: JupyterLab runs in detached tmux sessions, surviving hub restarts.
- **Port Allocation**: Automatically assigns unique ports from `8081-8089` to users.
- **Token-Auth Security**: Generates unique, secure access tokens for each JupyterLab session.
- **Clean Admin Dashboard**: Create/delete users, see server status, and optionally clean up user files.
- **User Dashboard**: Users can start, stop, restart, and copy their JupyterLab endpoint URL.

---

## Prerequisites

Before running HubJupyLab, make sure the following are installed on the host system:

### 1. `uv` (Fast Python Package Installer)
If not installed, install it system-wide:
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### 2. Python 3.14
Ensure Python 3.14 is available on the host system (managed by `uv` or system repository). `uv` will download it automatically when creating virtual environments if it's not found.

### 3. `tmux`
HubJupyLab runs JupyterLab inside tmux sessions.
- **Ubuntu/Debian**:
  ```bash
  sudo apt update && sudo apt install -y tmux
  ```
- **RHEL/CentOS/Rocky**:
  ```bash
  sudo dnf install -y tmux
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
uv run uvicorn main:app --host 0.0.0.0 --port 8080
```
Then access the dashboard at `http://<host-ip>:8080`.

### Production (Systemd)
To configure HubJupyLab to run on system startup:

1. Copy the systemd service file to `/etc/systemd/system/`:
   ```bash
   sudo cp hubjupylab.service /etc/systemd/system/
   ```
2. Reload systemd daemon:
   ```bash
   sudo systemctl daemon-reload
   ```
3. Enable and start the service:
   ```bash
   sudo systemctl enable --now hubjupylab
   ```
4. Check status:
   ```bash
   sudo systemctl status hubjupylab
   ```

---

## Architecture details

- **User directories**: Each user gets a directory at `{BASE_DIR}/{username}` containing their `.venv/` and notebook workspace.
- **SQLite Database**: A SQLite file `hubjupylab.db` is stored inside `{BASE_DIR}` to track user credentials, ports, and current session tokens.
- **tmux Sessions**: Created using session name `hub_{username}`. Use `tmux list-sessions` to view running instances on the host system.
