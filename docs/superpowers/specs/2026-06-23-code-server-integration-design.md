# Design Specification: code-server Integration

This document describes the design and integration details for running `code-server` alongside `JupyterLab` in the HubJupyLab application (both locally and on GPU VM instances).

## Proposed Changes

### 1. Configuration Constants (`src/config.ts`)
- Introduce a new constant `CODE_SERVER_PORT_OFFSET` set to `100`.
- Local code-server port will be calculated as `JupyterLab port + CODE_SERVER_PORT_OFFSET` (e.g., port 8081 becomes port 8181 for code-server).

### 2. Spawner Integration (`src/spawner.ts`)
- Update `spawnSession` to spin up both `JupyterLab` and `code-server` in the user's dedicated `tmux` session (`hub_{username}`).
- They will run in separate tmux windows in the same session:
  - Window 0 (`jupyter`): Spawns the JupyterLab server.
  - Window 1 (`code-server`): Spawns the code-server.
- Auth for `code-server`:
  - Set the `PASSWORD` environment variable to the same secure token generated for JupyterLab.
  - Bind to `0.0.0.0` at the calculated code-server port.
  - Pass the user's workspace directory (`{BASE_DIR}/{username}`) as the project directory to code-server.
  - Disable telemetry.
  - Command: `PASSWORD=${token} exec code-server --bind-addr=0.0.0.0:${codeServerPort} --auth=password --disable-telemetry ${userDir}`
- Update `stopSession` to terminate the entire tmux session (`tmux kill-session`), which automatically terminates both servers.

### 3. GPU VM Init Spawning (`src/gpu.ts`)
- Add code-server setup to the remote GPU initialization workflow (`gpuInitStream`):
  - Add installation of code-server globally on the remote VM: `curl -fsSL https://code-server.dev/install.sh | sh` (wrapped as a separate runStep).
  - Update the tmux spawning on the GPU. Instead of starting only JupyterLab, we will configure a single tmux session `gpu_{username}` with two windows (similar to local spawner):
    - Window 0 (`jupyter`): Spawns JupyterLab on port `8888`.
    - Window 1 (`code-server`): Spawns code-server on port `8889` using the JupyterLab token as the `PASSWORD` environment variable.
    - Command: `PASSWORD=${token} tmux new-window -t gpu_${username}:1 -n code-server "exec code-server --bind-addr=0.0.0.0:8889 --auth=password --disable-telemetry ${remoteBaseDir}/${username}"`
- Add `.code-server` configuration files/directories to `SYNC_EXCLUDES` to prevent synchronization overhead.

### 4. Route and URL Enrichment (`src/index.ts`)
- Compute code-server URL helper functions:
  - Local URL: `http://${hostIp}:${codeServerPort}/?folder=${userDir}` or simply `http://${hostIp}:${codeServerPort}/` (password entered via login page, or passed as URL params if supported. Since code-server doesn't natively allow inline passwords via URL query parameter without extra proxying, we will direct the user to the login screen where they use the same token as the password).
  - GPU VM URL: `http://${gpuHost}:8889/` (using mapped RunPod external port or GPU endpoint base URL. Note: RunPod HTTP endpoint routing uses standard endpoints. If external ports are mapped, port `8889` mapping will be parsed/inferred from `gpu_endpoint` URL or the host port configuration).
- Update user dashboard query payloads to include:
  - `code_server_url` (local)
  - `gpu_code_server_url` (remote)

### 5. UI Dashboard Buttons (`templates/dashboard.html` & `templates/partials/_dashboard_status.html`)
- If local server is running, show a full-width "Open Code Server ↗" button alongside the "Open JupyterLab ↗" button.
- If GPU session is ready, show a "🚀 Launch GPU Code Server" button or direct links.

---

## Detailed Code Adjustments

### Sync Excludes (`src/gpu.ts`)
```typescript
export const SYNC_EXCLUDES = [
  "*venv*",
  "__pycache__",
  ".ipynb_checkpoints",
  "hf_cache",
  ".cache",
  ".conda",
  ".local",
  "nohup.out",
  ".code-server" // Exclude code-server settings/extensions from syncing
];
```

### Tmux Spawn Sequence (`src/spawner.ts`)
```typescript
const sessionName = getSessionName(username);
const userDir = getUserDir(username);
const jupyterBin = join(userDir, ".venv", "bin", "jupyter");
const codeServerPort = port + CODE_SERVER_PORT_OFFSET;

const jupyterCmd = `cd ${userDir} && exec ${jupyterBin} lab --ip=0.0.0.0 --port=${port} --IdentityProvider.token=${token} --no-browser --notebook-dir=${userDir}`;
const codeServerCmd = `PASSWORD=${token} exec code-server --bind-addr=0.0.0.0:${codeServerPort} --auth=password --disable-telemetry ${userDir}`;

// Start tmux with jupyter window
const proc = Bun.spawn(["systemd-run", "--user", "--scope", "tmux", "new-session", "-d", "-s", sessionName, "-n", "jupyter", jupyterCmd], {
  stdout: "ignore",
  stderr: "pipe",
});
// ... wait for exit code, then spawn code-server window:
const codeServerProc = Bun.spawn(["tmux", "new-window", "-t", `${sessionName}:1`, "-n", "code-server", codeServerCmd], {
  stdout: "ignore",
  stderr: "pipe",
});
```

---

## Verifiability and Testing
1. Execute unit tests (`bun test`) to ensure no regressions in spawning/spawner module.
2. Confirm tmux creates both windows: `tmux list-windows -t hub_test_user`.
3. Check listening ports for both `8081` and `8181`.
