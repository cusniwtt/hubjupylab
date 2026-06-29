import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { BASE_DIR, PYTHON_VERSION, JUPYTERLAB_VERSION, JUPYTER_PORT_START, JUPYTER_PORT_END, CODE_SERVER_PORT_OFFSET } from "./config";
import { listUsers, updateToken, getUsedPorts } from "./db";

export function validateUsername(username: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    throw new Error(`Invalid username: ${username}`);
  }
}

export function getUserDir(username: string): string {
  validateUsername(username);
  const resolvedBase = resolve(BASE_DIR);
  const resolvedUser = resolve(join(resolvedBase, username));
  if (!resolvedUser.startsWith(resolvedBase)) {
    throw new Error(`Path traversal attempt detected: ${username}`);
  }
  return resolvedUser;
}

export async function setupUserEnv(username: string): Promise<boolean> {
  validateUsername(username);
  const userDir = getUserDir(username);
  mkdirSync(userDir, { recursive: true });

  const venvDir = join(userDir, ".venv");

  // Check if existing venv has a working python binary (guards against stale venvs
  // from old TLJH installations where symlinks point to deleted paths).
  if (existsSync(venvDir)) {
    const pythonBin = join(venvDir, "bin", "python");
    const checkProc = Bun.spawn([pythonBin, "--version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const checkExit = await checkProc.exited;
    if (checkExit !== 0) {
      console.warn(`Broken venv detected for ${username} (python check failed) — removing and recreating`);
      rmSync(venvDir, { recursive: true, force: true });
    }
  }

  if (!existsSync(venvDir)) {
    // Create venv
    const venvProc = Bun.spawn(["uv", "venv", "--python", PYTHON_VERSION, venvDir], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderrText = await new Response(venvProc.stderr).text();
    const exitCode = await venvProc.exited;
    if (exitCode !== 0) {
      console.error(`Error creating venv for ${username}: ${stderrText}`);
      return false;
    }

    // Install jupyterlab
    const pythonBin = join(venvDir, "bin", "python");
    const installProc = Bun.spawn(
      ["uv", "pip", "install", `jupyterlab==${JUPYTERLAB_VERSION}`, "ipykernel", "--python", pythonBin],
      { stdout: "ignore", stderr: "pipe" }
    );
    const stderrTextInstall = await new Response(installProc.stderr).text();
    const installExit = await installProc.exited;
    if (installExit !== 0) {
      console.error(`Error installing jupyterlab for ${username}: ${stderrTextInstall}`);
      return false;
    }
  }
  return true;
}

function getSessionName(username: string): string {
  validateUsername(username);
  return `hub_${username}`;
}

export async function isSessionRunning(username: string): Promise<boolean> {
  validateUsername(username);
  const proc = Bun.spawn(["tmux", "has-session", "-t", getSessionName(username)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

export async function spawnSession(username: string, port: number, token: string): Promise<boolean> {
  validateUsername(username);
  if (typeof port !== "number" || !Number.isInteger(port) || port < JUPYTER_PORT_START || port > JUPYTER_PORT_END) {
    throw new Error(`Invalid port: ${port}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
    throw new Error("Invalid token format");
  }
  if (!(await setupUserEnv(username))) return false;

  if (await isSessionRunning(username)) {
    await stopSession(username);
  }

  const sessionName = getSessionName(username);
  const userDir = getUserDir(username);
  const jupyterBin = join(userDir, ".venv", "bin", "jupyter");
  const codeServerPort = port + CODE_SERVER_PORT_OFFSET;

  const jupyterCmd = `cd ${userDir} && exec ${jupyterBin} lab --ip=0.0.0.0 --port=${port} --IdentityProvider.token=${token} --no-browser --notebook-dir=${userDir}`;

  // Find the vscode server node binary (commit hash changes per CLI version)
  const serveWebBase = join(process.env.HOME!, ".vscode", "cli", "serve-web");
  const commitDir = readdirSync(serveWebBase).find(d => d !== "lru.json") ?? "";
  const vsNode = join(serveWebBase, commitDir, "node");
  const vsMain = join(serveWebBase, commitDir, "out", "server-main.js");
  const codeServerCmd = `exec ${vsNode} ${vsMain} --host=0.0.0.0 --port=${codeServerPort} --without-connection-token --server-data-dir=${userDir}/.vscode-server --default-folder=${userDir} --telemetry-level=off --accept-server-license-terms`;

  // Start tmux with jupyter in window 0
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

  // Spawn VS Code serve-web in window 1
  const winProc = Bun.spawn(["tmux", "new-window", "-t", `${sessionName}:1`, "-n", "vscode", codeServerCmd], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const winStderr = await new Response(winProc.stderr).text();
  const winExit = await winProc.exited;
  if (winExit !== 0) {
    console.error(`Error spawning VS Code window for ${username}: ${winStderr}`);
    const killProc = Bun.spawn(["tmux", "kill-session", "-t", sessionName], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await killProc.exited;
    return false;
  }

  return true;
}

export async function stopSession(username: string): Promise<boolean> {
  validateUsername(username);
  if (!(await isSessionRunning(username))) return true;
  const proc = Bun.spawn(["tmux", "kill-session", "-t", getSessionName(username)], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await proc.exited) === 0;
}

export function cleanupUserFiles(username: string): void {
  validateUsername(username);
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
