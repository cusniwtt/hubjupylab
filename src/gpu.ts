import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BASE_DIR, SSH_KEY_PATH, SSH_USER, REMOTE_BASE_DIR, PYTHON_VERSION, JUPYTERLAB_VERSION } from "./config";
import { getUserByUsername, updateGpuInitStatus } from "./db";

function timestamp(): string {
  const d = new Date();
  // UTC+7 offset
  const utc7 = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return utc7.toISOString().replace("T", " ").slice(0, 19);
}

function logTimestamp(): string {
  const d = new Date();
  const utc7 = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return utc7.toISOString().replace(/[-:T]/g, "").slice(0, 15).replace(/(\d{8})(\d{6})/, "$1-$2");
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const l of lines) {
        onLine(l);
      }
    }
    if (buffer) {
      onLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

export async function testGpuSsh(sshHost: string, sshPort: number = 22): Promise<[boolean, string]> {
  if (!sshHost || !existsSync(SSH_KEY_PATH)) {
    return [false, "GPU SSH not configured or key not found"];
  }
  const proc = Bun.spawn([
    "ssh", "-p", String(sshPort),
    "-i", SSH_KEY_PATH,
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=10",
    `${SSH_USER}@${sshHost}`, "echo ok"
  ], { stdout: "pipe", stderr: "pipe" });

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch (_) {}
  }, 15000);

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  const exitCode = await proc.exited;
  clearTimeout(timer);

  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  if (exitCode !== 0) {
    return [false, `SSH failed: ${stderr.trim() || stdout.trim() || "unknown error"}`];
  }
  return [true, "SSH connection OK"];
}

export async function stopGpuSession(username: string): Promise<[boolean, string]> {
  const user = getUserByUsername(username);
  if (!user) return [false, `User ${username} not found`];

  const sshHost = user.gpu_ssh_host;
  const sshPort = user.gpu_ssh_port ?? 22;
  if (!sshHost || !existsSync(SSH_KEY_PATH)) {
    return [false, "GPU SSH not configured for user"];
  }

  try {
    const proc = Bun.spawn([
      "ssh", "-p", String(sshPort),
      "-i", SSH_KEY_PATH,
      "-o", "StrictHostKeyChecking=no",
      `${SSH_USER}@${sshHost}`,
      `tmux kill-session -t gpu_${username}`
    ], { stdout: "pipe", stderr: "pipe" });

    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();

    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

    if (exitCode !== 0) {
      return [false, `Failed to stop session: ${stderr.trim() || stdout.trim() || "unknown error"}`];
    }
    updateGpuInitStatus(username, "stopped");
    return [true, "GPU session stopped"];
  } catch (e: any) {
    return [false, `Failed to stop GPU session: ${e.message}`];
  }
}

export function gpuInitStream(
  username: string, host: string, port: number,
  keyPath: string, sshUser: string, token: string, endpoint: string
): ReadableStream<string> {
  const logDir = join(BASE_DIR, ".gpu_logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${username}-${logTimestamp()}-gpu.log`);

  return new ReadableStream<string>({
    async start(controller) {
      const logWriter = Bun.file(logPath).writer();

      function emit(msg: string): void {
        const ts = timestamp();
        const line = `[${ts}] ${msg}\n`;
        logWriter.write(line);
        logWriter.flush();
        controller.enqueue(`data: ${msg}\n\n`);
      }

      try {
        updateGpuInitStatus(username, "running");
        emit("Starting GPU initialization...");

        const [ok, sshMsg] = await testGpuSsh(host, port);
        if (!ok) {
          emit(`SSH connection test failed: ${sshMsg}`);
          updateGpuInitStatus(username, "failed");
          emit("Initialization FAILED");
          return;
        }
        emit("SSH connection OK. Beginning environment setup.");

        const runStep = async (stepName: string, remoteCmd: string): Promise<void> => {
          emit(`--- ${stepName} ---`);
          const proc = Bun.spawn([
            "ssh", "-p", String(port), "-i", keyPath,
            "-o", "StrictHostKeyChecking=no",
            `${sshUser}@${host}`, remoteCmd
          ], { stdout: "pipe", stderr: "pipe" });

          const stdoutPromise = readStream(proc.stdout, (l) => {
            emit(`  [${stepName}] ${l}`);
          });
          const stderrPromise = readStream(proc.stderr, (l) => {
            emit(`  [${stepName} ERR] ${l}`);
          });

          await Promise.all([stdoutPromise, stderrPromise]);
          const exitCode = await proc.exited;
          if (exitCode !== 0) throw new Error(`${stepName} failed with exit status ${exitCode}`);
        };

        await runStep("apt-update", "apt-get update -y");
        await runStep("apt-install", "apt-get install -y tmux vim btop rsync");
        await runStep("install-uv", "curl -LsSf https://astral.sh/uv/install.sh | sh");
        await runStep("mkdir-workspace", `mkdir -p ${REMOTE_BASE_DIR}/${username}`);
        await runStep("create-venv", `$HOME/.local/bin/uv venv --clear --python ${PYTHON_VERSION} ${REMOTE_BASE_DIR}/${username}/.venv`);
        await runStep("install-jupyter", `$HOME/.local/bin/uv pip install jupyterlab==${JUPYTERLAB_VERSION} --python ${REMOTE_BASE_DIR}/${username}/.venv/bin/python`);
        await runStep("kill-existing-tmux", `tmux kill-session -t gpu_${username} 2>/dev/null || true`);

        const jupyterCmd = `cd ${REMOTE_BASE_DIR}/${username} && exec ${REMOTE_BASE_DIR}/${username}/.venv/bin/jupyter lab --no-browser --port=8888 --ServerApp.allow_origin='${endpoint}' --ip=0.0.0.0 --allow-root --IdentityProvider.token=${token} --notebook-dir=${REMOTE_BASE_DIR}/${username}`;
        await runStep("spawn-jupyter", `tmux new-session -d -s gpu_${username} "${jupyterCmd}"`);
        await runStep("verify-tmux", `tmux has-session -t gpu_${username}`);

        updateGpuInitStatus(username, "ready");
        emit("Initialization SUCCESSFUL! GPU JupyterLab is now running.");
      } catch (e: any) {
        emit(`Error: ${e.message}`);
        updateGpuInitStatus(username, "failed");
        emit("Initialization FAILED");
      } finally {
        controller.close();
        logWriter.end();
      }
    },
  });
}

export function rsyncToGpuStream(username: string, subpath: string = ""): ReadableStream<string> {
  return _rsyncStream(username, subpath, "to");
}

export function rsyncFromGpuStream(username: string, subpath: string = ""): ReadableStream<string> {
  return _rsyncStream(username, subpath, "from");
}

function _rsyncStream(username: string, subpath: string, direction: "to" | "from"): ReadableStream<string> {
  const logDir = join(BASE_DIR, ".rsync_logs");
  mkdirSync(logDir, { recursive: true });
  const suffix = direction === "to" ? "rsync-to" : "rsync-from";
  const logPath = join(logDir, `${username}-${logTimestamp()}-${suffix}.log`);

  return new ReadableStream<string>({
    async start(controller) {
      const logWriter = Bun.file(logPath).writer();

      function emit(msg: string): void {
        const ts = timestamp();
        logWriter.write(`[${ts}] ${msg}\n`);
        logWriter.flush();
        controller.enqueue(`data: ${msg}\n\n`);
      }

      try {
        const user = getUserByUsername(username);
        if (!user) {
          emit("Error: User not found");
          return;
        }

        const sshHost = user.gpu_ssh_host;
        const sshPort = user.gpu_ssh_port ?? 22;
        if (!sshHost || !existsSync(SSH_KEY_PATH)) {
          emit("Error: GPU SSH not configured");
          return;
        }

        const userDir = join(BASE_DIR, username);
        if (!existsSync(userDir)) {
          emit("Error: User directory not found");
          return;
        }

        let syncSub = "";
        let targetDir = resolve(userDir);
        if (subpath) {
          targetDir = resolve(userDir, subpath);
          const resolvedBase = resolve(userDir) + "/";
          if (!targetDir.startsWith(resolvedBase) && targetDir !== resolve(userDir)) {
            emit("Error: Path escapes user directory");
            return;
          }
          if (direction === "from") {
            mkdirSync(targetDir, { recursive: true });
          } else if (!existsSync(targetDir)) {
            emit(`Error: Local directory '${subpath}' not found`);
            return;
          }
          syncSub = subpath.replace(/^\/+|\/+$/g, "");
        }

        const localPath = targetDir + "/";
        const remotePath = `${SSH_USER}@${sshHost}:${REMOTE_BASE_DIR}/${username}/${syncSub}/`;

        // Pre-create remote directory for "to" direction
        if (direction === "to") {
          const mkdirProc = Bun.spawn([
            "ssh", "-p", String(sshPort), "-i", SSH_KEY_PATH,
            "-o", "StrictHostKeyChecking=no", `${SSH_USER}@${sshHost}`,
            `mkdir -p ${REMOTE_BASE_DIR}/${username}/${syncSub}/`
          ], { stdout: "pipe", stderr: "pipe" });
          const stdoutPromise = new Response(mkdirProc.stdout).text();
          const stderrPromise = new Response(mkdirProc.stderr).text();
          const exitCode = await mkdirProc.exited;
          const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
          if (exitCode !== 0) {
            emit(`Warning: remote mkdir failed: ${stderr.trim() || stdout.trim() || "unknown error"}`);
          }
        }

        const src = direction === "to" ? localPath : remotePath;
        const dst = direction === "to" ? remotePath : localPath;

        const cmd = [
          "rsync", "-avz", "--delete", "-P",
          "--exclude", ".venv/", "--exclude", "__pycache__/",
          "-e", `ssh -p ${sshPort} -i ${SSH_KEY_PATH} -o StrictHostKeyChecking=no`,
          src, dst
        ];

        emit(`Starting rsync ${direction === "to" ? "to" : "from"} GPU...`);

        const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });

        const stdoutPromise = readStream(proc.stdout, (line) => {
          if (line.trim()) emit(line);
        });
        const stderrPromise = readStream(proc.stderr, (line) => {
          if (line.trim()) emit(`Error: ${line}`);
        });

        await Promise.all([stdoutPromise, stderrPromise]);
        const exitCode = await proc.exited;
        if (exitCode === 0) {
          emit(direction === "to" ? "Sync complete SUCCESS" : "Sync back complete SUCCESS");
        } else {
          emit(`Sync ${direction === "to" ? "" : "back "}failed with exit status ${exitCode}`);
        }
      } catch (e: any) {
        emit(`Error: ${e.message}`);
      } finally {
        controller.close();
        logWriter.end();
      }
    },
  });
}

export function getLastGpuLog(username: string): string {
  const logDir = join(BASE_DIR, ".gpu_logs");
  if (!existsSync(logDir)) return "No logs found.";

  const files = readdirSync(logDir)
    .filter((f) => f.startsWith(username) && f.endsWith("-gpu.log"))
    .sort();

  if (files.length === 0) return "No setup logs found for this user.";

  try {
    return readFileSync(join(logDir, files[files.length - 1]), "utf-8");
  } catch (e: any) {
    return `Error reading log file: ${e.message}`;
  }
}
