import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BASE_DIR, PYTHON_VERSION, JUPYTERLAB_VERSION, JUPYTER_PORT_START, JUPYTER_PORT_END } from "./config";
import { listUsers, updateToken, getUsedPorts } from "./db";

export function getUserDir(username: string): string {
  return join(BASE_DIR, username);
}

export async function setupUserEnv(username: string): Promise<boolean> {
  const userDir = getUserDir(username);
  mkdirSync(userDir, { recursive: true });

  const venvDir = join(userDir, ".venv");
  if (!existsSync(venvDir)) {
    // Create venv
    const venvProc = Bun.spawn(["uv", "venv", "--python", PYTHON_VERSION, venvDir], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await venvProc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(venvProc.stderr).text();
      console.error(`Error creating venv for ${username}: ${stderr}`);
      return false;
    }

    // Install jupyterlab
    const pythonBin = join(venvDir, "bin", "python");
    const installProc = Bun.spawn(
      ["uv", "pip", "install", `jupyterlab==${JUPYTERLAB_VERSION}`, "--python", pythonBin],
      { stdout: "pipe", stderr: "pipe" }
    );
    const installExit = await installProc.exited;
    if (installExit !== 0) {
      const stderr = await new Response(installProc.stderr).text();
      console.error(`Error installing jupyterlab for ${username}: ${stderr}`);
      return false;
    }
  }
  return true;
}

function getSessionName(username: string): string {
  return `hub_${username}`;
}

export async function isSessionRunning(username: string): Promise<boolean> {
  const proc = Bun.spawn(["tmux", "has-session", "-t", getSessionName(username)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
}

export async function spawnSession(username: string, port: number, token: string): Promise<boolean> {
  if (!(await setupUserEnv(username))) return false;

  if (await isSessionRunning(username)) {
    await stopSession(username);
  }

  const sessionName = getSessionName(username);
  const userDir = getUserDir(username);
  const jupyterBin = join(userDir, ".venv", "bin", "jupyter");

  const jupyterCmd = `cd ${userDir} && exec ${jupyterBin} lab --ip=0.0.0.0 --port=${port} --IdentityProvider.token=${token} --no-browser --notebook-dir=${userDir}`;

  const proc = Bun.spawn(["tmux", "new-session", "-d", "-s", sessionName, jupyterCmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error(`Error spawning tmux session for ${username}: ${stderr}`);
    return false;
  }
  return true;
}

export async function stopSession(username: string): Promise<boolean> {
  if (!(await isSessionRunning(username))) return true;
  const proc = Bun.spawn(["tmux", "kill-session", "-t", getSessionName(username)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (await proc.exited) === 0;
}

export function cleanupUserFiles(username: string): void {
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
