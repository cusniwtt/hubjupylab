# code-server Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate code-server alongside JupyterLab in local spawn sessions and RunPod GPU VM initialization.

**Architecture:** Use a single tmux session per user (`hub_{username}` locally and `gpu_{username}` on GPU VM) containing two windows: `jupyter` for JupyterLab and `code-server` for code-server. Calculate the local code-server port with a port offset of 100 relative to the JupyterLab port. Use the user's JupyterLab token as the password for code-server authentication. Add code-server setup commands to GPU initialization and expose URL launchers in the user UI.

**Tech Stack:** Bun, Elysia, tmux, Bash, code-server (global installation)

## Global Constraints
- Target code-server port offset = 100
- Sync excludes must ignore `.code-server`
- Spawners must use tmux windowing to run both servers concurrently in the same session.

---

### Task 1: Configuration Constants and Sync Excludes

**Files:**
- Modify: `src/config.ts:13-21`
- Modify: `src/gpu.ts:6-16`
- Modify: `src/gpu.test.ts:30-45`

**Interfaces:**
- Produces: `CODE_SERVER_PORT_OFFSET` (number) in `src/config.ts`

- [ ] **Step 1: Write/Update the configuration and GPU sync test**

Modify `src/gpu.test.ts` to expect `.code-server` in `SYNC_EXCLUDES`.
```typescript
  test("SYNC_EXCLUDES contains all required patterns", () => {
    expect(SYNC_EXCLUDES).toContain("*venv*");
    expect(SYNC_EXCLUDES).toContain("__pycache__");
    expect(SYNC_EXCLUDES).toContain(".ipynb_checkpoints");
    expect(SYNC_EXCLUDES).toContain("hf_cache");
    expect(SYNC_EXCLUDES).toContain(".cache");
    expect(SYNC_EXCLUDES).toContain(".conda");
    expect(SYNC_EXCLUDES).toContain(".local");
    expect(SYNC_EXCLUDES).toContain("nohup.out");
    expect(SYNC_EXCLUDES).toContain(".code-server");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/gpu.test.ts`
Expected: FAIL due to missing `.code-server` in `SYNC_EXCLUDES`

- [ ] **Step 3: Write minimal implementation**

Modify `src/config.ts` to add `CODE_SERVER_PORT_OFFSET`:
```typescript
export const JUPYTER_PORT_START = 8081;
export const JUPYTER_PORT_END = 8090;
export const CODE_SERVER_PORT_OFFSET = 100;
```

Modify `src/gpu.ts` to add `.code-server` to `SYNC_EXCLUDES`:
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
  ".code-server"
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/gpu.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/gpu.ts src/gpu.test.ts
git commit -m "feat: add CODE_SERVER_PORT_OFFSET and update SYNC_EXCLUDES"
```

---

### Task 2: Local tmux code-server Window Spawning

**Files:**
- Modify: `src/spawner.ts:80-105`

**Interfaces:**
- Consumes: `CODE_SERVER_PORT_OFFSET` from `src/config.ts`
- Modifies: `spawnSession(username: string, port: number, token: string)` to launch jupyter in tmux window 0 (`jupyter`) and code-server in tmux window 1 (`code-server`).

- [ ] **Step 1: Write/Update spawner implementation**

Modify `src/spawner.ts` inside `spawnSession`:
```typescript
  const sessionName = getSessionName(username);
  const userDir = getUserDir(username);
  const jupyterBin = join(userDir, ".venv", "bin", "jupyter");
  const codeServerPort = port + CODE_SERVER_PORT_OFFSET;

  const jupyterCmd = `cd ${userDir} && exec ${jupyterBin} lab --ip=0.0.0.0 --port=${port} --IdentityProvider.token=${token} --no-browser --notebook-dir=${userDir}`;
  const codeServerCmd = `PASSWORD=${token} exec code-server --bind-addr=0.0.0.0:${codeServerPort} --auth=password --disable-telemetry ${userDir}`;

  // Start tmux session with jupyter window named 'jupyter'
  const proc = Bun.spawn(["systemd-run", "--user", "--scope", "tmux", "new-session", "-d", "-s", sessionName, "-n", "jupyter", jupyterCmd], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderrText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    console.error(`Error spawning tmux session for ${username}: ${stderrText}`);
    return false;
  }

  // Create new window for code-server
  const winProc = Bun.spawn(["tmux", "new-window", "-t", `${sessionName}:1`, "-n", "code-server", codeServerCmd], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const winStderr = await new Response(winProc.stderr).text();
  const winExit = await winProc.exited;
  if (winExit !== 0) {
    console.error(`Error spawning code-server window for ${username}: ${winStderr}`);
    return false;
  }

  return true;
```

- [ ] **Step 2: Verify test pass**

Run: `bun test src/spawner.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/spawner.ts
git commit -m "feat: configure spawner to spawn code-server in separate tmux window"
```

---

### Task 3: GPU VM code-server Installation and tmux Window Spawning

**Files:**
- Modify: `src/gpu.ts:315-335`

**Interfaces:**
- Modifies: `gpuInitStream(username, host, port, keyPath, sshUser, token, endpoint, remoteBaseDir)` to add code-server installation step and window spawn step.

- [ ] **Step 1: Write/Update GPU VM environment steps**

Modify `src/gpu.ts` inside `gpuInitStream`:
- Insert installation step:
```typescript
        await runStep("install-code-server", "curl -fsSL https://code-server.dev/install.sh | sh");
```
- Update spawning steps:
```typescript
        const jupyterCmd = `cd ${remoteBaseDir}/${username} && exec ${remoteBaseDir}/${username}/.venv/bin/jupyter lab --no-browser --port=8888 --ServerApp.allow_origin='${endpoint}' --ip=0.0.0.0 --allow-root --IdentityProvider.token=${token} --notebook-dir=${remoteBaseDir}/${username}`;
        await runStep("spawn-jupyter", `tmux new-session -d -s gpu_${username} -n jupyter "${jupyterCmd}"`);
        
        const codeServerCmd = `PASSWORD=${token} exec code-server --bind-addr=0.0.0.0:8889 --auth=password --disable-telemetry ${remoteBaseDir}/${username}`;
        await runStep("spawn-code-server", `tmux new-window -t gpu_${username}:1 -n code-server "${codeServerCmd}"`);
        await runStep("verify-tmux", `tmux has-session -t gpu_${username}`);
```

- [ ] **Step 2: Verify existing tests**

Run: `bun test src/gpu.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/gpu.ts
git commit -m "feat: install and start code-server during GPU initialization"
```

---

### Task 4: Routes and URL Mappings

**Files:**
- Modify: `src/index.ts`

**Interfaces:**
- Modifies: computed response contexts inside dashboard endpoint to map `code_server_url` and `gpu_code_server_url`.

- [ ] **Step 1: Write/Update code-server URL helper mapping**

Modify `src/index.ts` to add url builders and pass them to responses.
Add helper:
```typescript
function buildCodeServerUrl(hostIp: string, port: number): string {
  return `http://${hostIp}:${port}/`;
}
```
Update `getEnrichedUsers`:
```typescript
    const isRunning = await spawner.isSessionRunning(u.username);
    const jupyterUrl = isRunning && u.token ? buildJupyterUrl(hostIp, u.port!, u.token) : "";
    const codeServerUrl = isRunning && u.token ? buildCodeServerUrl(hostIp, u.port! + config.CODE_SERVER_PORT_OFFSET) : "";
    enriched.push({ ...u, is_running: isRunning, jupyter_url: jupyterUrl, code_server_url: codeServerUrl });
```
Update `enrichUser`:
```typescript
  const isRunning = await spawner.isSessionRunning(username);
  const jupyterUrl = isRunning && user.token ? buildJupyterUrl(hostIp, user.port!, user.token) : "";
  const codeServerUrl = isRunning && user.token ? buildCodeServerUrl(hostIp, user.port! + config.CODE_SERVER_PORT_OFFSET) : "";
  return { ...user, is_running: isRunning, jupyter_url: jupyterUrl, code_server_url: codeServerUrl };
```
Update local user dashboard `/dashboard` route context parameters:
```typescript
    const codeServerUrl = isRunning && user.token ? buildCodeServerUrl(hostIp, user.port! + config.CODE_SERVER_PORT_OFFSET) : "";
    const gpuCodeServerUrl = user.gpu_endpoint ? user.gpu_endpoint.replace(":8888", ":8889") : "";
```
Pass the context vars to the user dashboard template:
```typescript
    return new Response(render("dashboard.html", {
      user, is_running: isRunning, user_port: user.port,
      jupyter_url: jupyterUrl, code_server_url: codeServerUrl, error: query.error ?? null,
      success: query.success ?? null, has_gpu: hasGpu,
      gpu_endpoint: user.gpu_endpoint ?? "",
      gpu_code_server_url: gpuCodeServerUrl,
      gpu_init_status: user.gpu_init_status ?? "",
      gpu_token: user.gpu_token ?? ""
    }), { headers: { "Content-Type": "text/html" } });
```
Update HTMX partial endpoints `/session/start`, `/session/stop`, `/session/restart`, `/session/status` to pass `code_server_url` and `gpu_code_server_url` context:
```typescript
          code_server_url: isRunning && user.token ? buildCodeServerUrl(hostIp, port + config.CODE_SERVER_PORT_OFFSET) : "",
          gpu_code_server_url: user.gpu_endpoint ? user.gpu_endpoint.replace(":8888", ":8889") : "",
```

- [ ] **Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat: add code-server URLs to routing contexts"
```

---

### Task 5: Dashboard UI Button Integration

**Files:**
- Modify: `templates/dashboard.html`
- Modify: `templates/partials/_dashboard_status.html`

- [ ] **Step 1: Insert launcher buttons to the templates**

In `templates/dashboard.html`:
Replace local jupyter launch link section:
```html
            <a href="{{ jupyter_url }}" target="_blank" class="btn btn-primary" style="text-decoration: none; width: 100%; margin-bottom: 0.5rem;">
                Open JupyterLab ↗
            </a>
            <a href="{{ code_server_url }}" target="_blank" class="btn btn-outline" style="text-decoration: none; width: 100%; border-color: var(--accent-color); color: var(--accent-color);">
                Open Code Server ↗
            </a>
```
Replace remote GPU VM session launch link section:
```html
                {% if user.gpu_init_status == 'ready' %}
                {% set separator = '&' if '?' in gpu_endpoint else '?' %}
                <div style="display: flex; flex-direction: column; gap: 0.5rem; width: 100%;">
                    <a href="{{ gpu_endpoint }}{{ separator }}token={{ user.gpu_token }}" target="_blank" class="btn" style="background: linear-gradient(135deg, #7c3aed, #6366f1); color: white; font-weight: 600; text-decoration: none; text-align: center; width: 100%;">
                        🚀 Launch GPU JupyterLab
                    </a>
                    <a href="{{ gpu_code_server_url }}" target="_blank" class="btn btn-outline" style="border-color: #7c3aed; color: #a78bfa; font-weight: 600; text-decoration: none; text-align: center; width: 100%;">
                        💻 Launch GPU Code Server
                    </a>
                </div>
```

In `templates/partials/_dashboard_status.html`:
Replace local jupyter launch link section:
```html
    <a href="{{ jupyter_url }}" target="_blank" class="btn btn-primary" style="text-decoration: none; width: 100%; margin-bottom: 0.5rem;">
        Open JupyterLab ↗
    </a>
    <a href="{{ code_server_url }}" target="_blank" class="btn btn-outline" style="text-decoration: none; width: 100%; border-color: var(--accent-color); color: var(--accent-color);">
        Open Code Server ↗
    </a>
```
Replace remote GPU VM session launch link section:
```html
    <div style="display: flex; gap: 1rem; margin-bottom: 1rem;">
        {% if gpu_init_status == 'ready' %}
        {% set separator = '&' if '?' in gpu_endpoint else '?' %}
        <div style="display: flex; flex-direction: column; gap: 0.5rem; width: 100%;">
            <a href="{{ gpu_endpoint }}{{ separator }}token={{ gpu_token }}" target="_blank" class="btn" style="background: linear-gradient(135deg, #7c3aed, #6366f1); color: white; font-weight: 600; text-decoration: none; text-align: center; width: 100%;">
                🚀 Launch GPU JupyterLab
            </a>
            <a href="{{ gpu_code_server_url }}" target="_blank" class="btn btn-outline" style="border-color: #7c3aed; color: #a78bfa; font-weight: 600; text-decoration: none; text-align: center; width: 100%;">
                💻 Launch GPU Code Server
            </a>
        </div>
```

- [ ] **Step 2: Commit**

```bash
git add templates/dashboard.html templates/partials/_dashboard_status.html
git commit -m "feat: add user dashboard launcher buttons for code-server"
```
