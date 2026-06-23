import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { BASE_DIR, PYTHON_VERSION, JUPYTERLAB_VERSION, SYNC_SIZE_THRESHOLD, SYNC_FILE_THRESHOLD } from "./config";
import { getUserByUsername, updateGpuInitStatus, getGpuConfig } from "./db";

export const SYNC_EXCLUDES = [
  "*venv*",
  "__pycache__",
  ".ipynb_checkpoints",
  "hf_cache",
  ".cache",
  ".conda",
  ".local",
  "nohup.out"
];

async function remoteDirExists(
  sshPort: number,
  sshKeyPath: string,
  sshUser: string,
  sshHost: string,
  path: string
): Promise<boolean> {
  try {
    const proc = Bun.spawn([
      "ssh", "-p", String(sshPort), "-i", sshKeyPath,
      "-o", "StrictHostKeyChecking=no", `${sshUser}@${sshHost}`,
      `[ -d "${path}" ]`
    ]);
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

async function getLocalFileCount(path: string): Promise<number> {
  try {
    const proc = Bun.spawn(["bash", "-c", `find "${path}" | wc -l`], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

async function getRemoteFileCount(
  sshPort: number,
  sshKeyPath: string,
  sshUser: string,
  sshHost: string,
  path: string
): Promise<number> {
  try {
    const proc = Bun.spawn([
      "ssh", "-p", String(sshPort), "-i", sshKeyPath,
      "-o", "StrictHostKeyChecking=no", `${sshUser}@${sshHost}`,
      `find "${path}" | wc -l`
    ], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

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
      const lines = buffer.split(/\r?\n|\r/);
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

function parseSizeToBytes(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("k")) return value * 1024;
  if (u.startsWith("m")) return value * 1024 * 1024;
  if (u.startsWith("g")) return value * 1024 * 1024 * 1024;
  if (u.startsWith("t")) return value * 1024 * 1024 * 1024 * 1024;
  return value;
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return "";
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

function formatEta(seconds: number): string {
  if (seconds < 0 || !isFinite(seconds)) return "--:--:--";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

async function getLocalDirSize(path: string): Promise<number> {
  try {
    const proc = Bun.spawn(["du", "-sb", path], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const match = stdout.trim().match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 1;
  } catch (e) {
    console.error(`Error getting size for local dir ${path}:`, e);
    return 1;
  }
}

async function getRemoteDirSize(
  sshPort: number,
  sshKeyPath: string,
  sshUser: string,
  sshHost: string,
  path: string
): Promise<number> {
  try {
    const proc = Bun.spawn([
      "ssh", "-p", String(sshPort), "-i", sshKeyPath,
      "-o", "StrictHostKeyChecking=no", `${sshUser}@${sshHost}`,
      `du -sb ${path}`
    ], { stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    const match = stdout.trim().match(/^(\d+)/);
    return match ? parseInt(match[1], 10) : 1;
  } catch (e) {
    console.error(`Error getting size for remote dir ${path}:`, e);
    return 1;
  }
}

export async function testGpuSsh(
  sshHost: string,
  sshPort: number = 22,
  keyPath: string,
  sshUser: string
): Promise<[boolean, string]> {
  if (!sshHost || !keyPath || !existsSync(keyPath)) {
    return [false, "GPU SSH not configured or key not found"];
  }
  const proc = Bun.spawn([
    "ssh", "-p", String(sshPort),
    "-i", keyPath,
    "-o", "StrictHostKeyChecking=no",
    "-o", "ConnectTimeout=10",
    `${sshUser}@${sshHost}`, "echo ok"
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
  const gpuConf = getGpuConfig();
  if (!sshHost || !gpuConf.ssh_key_path || !existsSync(gpuConf.ssh_key_path)) {
    return [false, "GPU SSH not configured for user"];
  }

  try {
    const proc = Bun.spawn([
      "ssh", "-p", String(sshPort),
      "-i", gpuConf.ssh_key_path,
      "-o", "StrictHostKeyChecking=no",
      `${gpuConf.ssh_user}@${sshHost}`,
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

export function isValidGpuEndpoint(endpoint: string): boolean {
  if (endpoint === "") return true;
  if (/['";`$|&<>\s]/.test(endpoint)) {
    return false;
  }
  try {
    const url = new URL(endpoint);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (_) {
    return false;
  }
}

export function gpuInitStream(
  username: string, host: string, port: number,
  keyPath: string, sshUser: string, token: string, endpoint: string,
  remoteBaseDir: string
): ReadableStream<string> {
  const logDir = join(BASE_DIR, ".gpu_logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `${username}-${logTimestamp()}-gpu.log`);

  let activeProc: any = null;

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
        if (endpoint !== "" && !isValidGpuEndpoint(endpoint)) {
          throw new Error("Invalid GPU endpoint structure or dangerous characters detected");
        }
        updateGpuInitStatus(username, "running");
        emit("Starting GPU initialization...");

        const [ok, sshMsg] = await testGpuSsh(host, port, keyPath, sshUser);
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

          activeProc = proc;

          try {
            const stdoutPromise = readStream(proc.stdout, (l) => {
              emit(`  [${stepName}] ${l}`);
            });
            const stderrPromise = readStream(proc.stderr, (l) => {
              emit(`  [${stepName} ERR] ${l}`);
            });

            await Promise.all([stdoutPromise, stderrPromise]);
            const exitCode = await proc.exited;
            if (exitCode !== 0) throw new Error(`${stepName} failed with exit status ${exitCode}`);
          } finally {
            activeProc = null;
          }
        };

        await runStep("apt-update", "apt-get update -y");
        await runStep("apt-install", "apt-get install -y tmux vim btop rsync zstd");
        await runStep("install-uv", "curl -LsSf https://astral.sh/uv/install.sh | sh");
        await runStep("mkdir-workspace", `mkdir -p ${remoteBaseDir}/${username}`);
        await runStep("create-venv", `$HOME/.local/bin/uv venv --clear --python ${PYTHON_VERSION} ${remoteBaseDir}/${username}/.venv`);
        await runStep("install-jupyter", `$HOME/.local/bin/uv pip install jupyterlab==${JUPYTERLAB_VERSION} --python ${remoteBaseDir}/${username}/.venv/bin/python`);
        await runStep("kill-existing-tmux", `tmux kill-session -t gpu_${username} 2>/dev/null || true`);

        const jupyterCmd = `cd ${remoteBaseDir}/${username} && exec ${remoteBaseDir}/${username}/.venv/bin/jupyter lab --no-browser --port=8888 --ServerApp.allow_origin='${endpoint}' --ip=0.0.0.0 --allow-root --IdentityProvider.token=${token} --notebook-dir=${remoteBaseDir}/${username}`;
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
    cancel(reason) {
      if (activeProc) {
        try {
          activeProc.kill();
        } catch (_) {}
      }
    }
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

  let activeProc: any = null;

  return new ReadableStream<string>({
    async start(controller) {
      const logWriter = Bun.file(logPath).writer();

      let isClosed = false;

      function emit(msg: string): void {
        if (isClosed) return;
        const ts = timestamp();
        logWriter.write(`[${ts}] ${msg}\n`);
        logWriter.flush();
        try {
          controller.enqueue(`data: ${msg}\n\n`);
        } catch (_) {}
      }

      function emitProgress(percent: number, speed: string, eta: string): void {
        if (isClosed) return;
        try {
          controller.enqueue(`event: progress\ndata: ${JSON.stringify({ percent, speed, eta })}\n\n`);
        } catch (_) {}
      }

      async function runCmd(cmd: string[], keepAliveMsg?: string): Promise<number> {
        const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
        activeProc = proc;

        let timer: any = null;
        if (keepAliveMsg) {
          timer = setInterval(() => {
            emit(`${keepAliveMsg} (please wait)...`);
          }, 3000);
        }

        try {
          const stdoutPromise = readStream(proc.stdout, (line) => {
            if (line.trim()) emit(line);
          });
          const stderrPromise = readStream(proc.stderr, (line) => {
            if (line.trim()) emit(`Error: ${line}`);
          });
          await Promise.all([stdoutPromise, stderrPromise]);
          return await proc.exited;
        } finally {
          if (timer) clearInterval(timer);
          activeProc = null;
        }
      }

      try {
        if (subpath !== "" && !/^[a-zA-Z0-9_/.-]+$/.test(subpath)) {
          emit("Error: Invalid subpath pattern");
          return;
        }

        const user = getUserByUsername(username);
        if (!user) {
          emit("Error: User not found");
          return;
        }

        const sshHost = user.gpu_ssh_host;
        const sshPort = user.gpu_ssh_port ?? 22;
        const gpuConf = getGpuConfig();

        if (!sshHost || !gpuConf.ssh_key_path || !existsSync(gpuConf.ssh_key_path)) {
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
        const remotePath = `${gpuConf.ssh_user}@${sshHost}:${gpuConf.remote_base_dir}/${username}/${syncSub}/`;

        // Pre-create remote directory for "to" direction
        if (direction === "to") {
          const mkdirProc = Bun.spawn([
            "ssh", "-p", String(sshPort), "-i", gpuConf.ssh_key_path,
            "-o", "StrictHostKeyChecking=no", `${gpuConf.ssh_user}@${sshHost}`,
            `mkdir -p ${gpuConf.remote_base_dir}/${username}/${syncSub}/`
          ], { stdout: "pipe", stderr: "pipe" });

          activeProc = mkdirProc;

          try {
            const stdoutPromise = new Response(mkdirProc.stdout).text();
            const stderrPromise = new Response(mkdirProc.stderr).text();
            const exitCode = await mkdirProc.exited;
            const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
            if (exitCode !== 0) {
              emit(`Warning: remote mkdir failed: ${stderr.trim() || stdout.trim() || "unknown error"}`);
            }
          } finally {
            activeProc = null;
          }
        }

        const relativePath = subpath ? `${username}/${syncSub}` : username;
        const remoteDir = `${gpuConf.remote_base_dir}/${username}/${syncSub}`;

        // Calculate total size and decide on Zstd compression
        let totalBytes = 1;
        let useZstd = false;

        const keepAliveTimer = setInterval(() => {
          emit("Evaluating directory status and size (please wait)...");
        }, 2000);

        try {
          if (direction === "to") {
            emit("Checking remote directory status...");
            const targetExists = await remoteDirExists(sshPort, gpuConf.ssh_key_path, gpuConf.ssh_user, sshHost, remoteDir);
            if (!targetExists) {
              emit("Calculating local directory size and file count...");
              const localSize = await getLocalDirSize(targetDir);
              const localCount = await getLocalFileCount(targetDir);
              if (localSize > SYNC_SIZE_THRESHOLD || localCount > SYNC_FILE_THRESHOLD) {
                useZstd = true;
                totalBytes = localSize;
              } else {
                totalBytes = localSize;
              }
            } else {
              emit("Remote directory already exists. Bypassing compression for direct sync...");
              // Get local size just for log/progress info
              totalBytes = await getLocalDirSize(targetDir);
            }
          } else { // direction === "from"
            emit("Checking local directory status...");
            const targetExists = existsSync(targetDir);
            if (!targetExists) {
              emit("Calculating remote directory size and file count...");
              const remoteDirToMeasure = `${gpuConf.remote_base_dir}/${username}/${syncSub}`;
              const remoteSize = await getRemoteDirSize(sshPort, gpuConf.ssh_key_path, gpuConf.ssh_user, sshHost, remoteDirToMeasure);
              const remoteCount = await getRemoteFileCount(sshPort, gpuConf.ssh_key_path, gpuConf.ssh_user, sshHost, remoteDirToMeasure);
              if (remoteSize > SYNC_SIZE_THRESHOLD || remoteCount > SYNC_FILE_THRESHOLD) {
                useZstd = true;
                totalBytes = remoteSize;
              } else {
                totalBytes = remoteSize;
              }
            } else {
              emit("Local directory already exists. Bypassing compression for direct sync...");
              // Get remote size just for log/progress info
              const remoteDirToMeasure = `${gpuConf.remote_base_dir}/${username}/${syncSub}`;
              totalBytes = await getRemoteDirSize(sshPort, gpuConf.ssh_key_path, gpuConf.ssh_user, sshHost, remoteDirToMeasure);
            }
          }
        } finally {
          clearInterval(keepAliveTimer);
        }

        if (!useZstd) {
          // Direct rsync
          const localPath = targetDir + "/";
          const remotePath = `${gpuConf.ssh_user}@${sshHost}:${gpuConf.remote_base_dir}/${username}/${syncSub}/`;

          const src = direction === "to" ? localPath : remotePath;
          const dst = direction === "to" ? remotePath : localPath;

          const rsyncExcludeArgs = SYNC_EXCLUDES.flatMap(p => ["--exclude", p]);

          const cmd = [
            "rsync", "-az", "--info=progress2",
            ...rsyncExcludeArgs,
            "-e", `ssh -p ${sshPort} -i ${gpuConf.ssh_key_path} -o StrictHostKeyChecking=no`,
            src, dst
          ];

          emit(`Directory size: ${(totalBytes / (1024 * 1024)).toFixed(1)} MB. Starting direct rsync...`);

          const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
          activeProc = proc;

          try {
            const stdoutPromise = readStream(proc.stdout, (line) => {
              const trimmed = line.trim();
              if (!trimmed) return;
              const progressMatch = trimmed.match(/\s+\d+(?:,\d+)*\s+(\d+)%\s+([^\s]+\/s)?\s*(\d+:\d+:\d+)?/);
              if (progressMatch) {
                const percent = parseInt(progressMatch[1], 10);
                const speed = progressMatch[2] || "";
                const eta = progressMatch[3] || "";
                emitProgress(percent, speed, eta);
              } else {
                emit(line);
              }
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
          } finally {
            activeProc = null;
          }
        } else {
          // Large directory sync using Tar + Zstd + Rsync + Unpack
          emit(`Directory size: ${(totalBytes / (1024 * 1024)).toFixed(1)} MB. Using Tar-Zstd-Rsync...`);

          const localTempArchive = join(BASE_DIR, `.${username}_sync.tar.zst`);
          const remoteTempArchive = `${gpuConf.remote_base_dir}/.${username}_sync.tar.zst`;

          if (direction === "to") {
            // 1. Compress locally
            emit("Compressing files locally using zstd...");
            const localTarExcludeArgs = SYNC_EXCLUDES.map(p => `--exclude=${p}`);
            const compressCmd = [
              "tar", ...localTarExcludeArgs,
              "-I", "zstd -T0", "-cf", localTempArchive, "-C", BASE_DIR, relativePath
            ];
            const compressExit = await runCmd(compressCmd, "Compressing files locally");
            if (compressExit !== 0) {
              emit(`Local compression failed with exit status ${compressExit}`);
              return;
            }

            // 2. Transfer via Rsync
            emit("Transferring compressed archive to GPU...");
            const transferCmd = [
              "rsync", "-a", "--info=progress2",
              "-e", `ssh -p ${sshPort} -i ${gpuConf.ssh_key_path} -o StrictHostKeyChecking=no`,
              localTempArchive, `${gpuConf.ssh_user}@${sshHost}:${remoteTempArchive}`
            ];

            const proc = Bun.spawn(transferCmd, { stdout: "pipe", stderr: "pipe" });
            activeProc = proc;
            try {
              const stdoutPromise = readStream(proc.stdout, (line) => {
                const trimmed = line.trim();
                if (!trimmed) return;
                const progressMatch = trimmed.match(/\s+\d+(?:,\d+)*\s+(\d+)%\s+([^\s]+\/s)?\s*(\d+:\d+:\d+)?/);
                if (progressMatch) {
                  const percent = parseInt(progressMatch[1], 10);
                  const speed = progressMatch[2] || "";
                  const eta = progressMatch[3] || "";
                  emitProgress(percent, speed, eta);
                } else {
                  emit(line);
                }
              });
              const stderrPromise = readStream(proc.stderr, (line) => {
                if (line.trim()) emit(`Error: ${line}`);
              });
              await Promise.all([stdoutPromise, stderrPromise]);
              const transferExit = await proc.exited;
              if (transferExit !== 0) {
                emit(`Archive transfer failed with exit status ${transferExit}`);
                try { unlinkSync(localTempArchive); } catch (_) {}
                return;
              }
            } finally {
              activeProc = null;
            }

            // 3. Extract remotely
            emit("Extracting files on GPU VM...");
            const extractCmd = [
              "ssh", "-p", String(sshPort), "-i", gpuConf.ssh_key_path,
              "-o", "StrictHostKeyChecking=no", `${gpuConf.ssh_user}@${sshHost}`,
              `mkdir -p ${remoteDir} && zstd -d -T0 -c ${remoteTempArchive} | tar -xf - -C ${gpuConf.remote_base_dir} && rm -f ${remoteTempArchive}`
            ];
            const extractExit = await runCmd(extractCmd, "Extracting files remotely");
            if (extractExit !== 0) {
              emit(`Remote extraction failed with exit status ${extractExit}`);
            } else {
              emitProgress(100, "", "00:00:00");
              emit("Sync complete SUCCESS");
            }

            // 4. Cleanup local temp archive
            try { unlinkSync(localTempArchive); } catch (_) {}

          } else {
            // "from" direction (download)
            // 1. Compress remotely
            emit("Compressing files on GPU VM using zstd...");
            const remoteTarExcludeStr = SYNC_EXCLUDES.map(p => `--exclude="${p}"`).join(" ");
            const remoteCompressCmd = [
              "ssh", "-p", String(sshPort), "-i", gpuConf.ssh_key_path,
              "-o", "StrictHostKeyChecking=no", `${gpuConf.ssh_user}@${sshHost}`,
              `tar ${remoteTarExcludeStr} -I "zstd -T0" -cf ${remoteTempArchive} -C ${gpuConf.remote_base_dir} ${relativePath}`
            ];
            const compressExit = await runCmd(remoteCompressCmd, "Compressing files remotely");
            if (compressExit !== 0) {
              emit(`Remote compression failed with exit status ${compressExit}`);
              return;
            }

            // 2. Transfer via Rsync
            emit("Transferring compressed archive to local...");
            const transferCmd = [
              "rsync", "-a", "--info=progress2",
              "-e", `ssh -p ${sshPort} -i ${gpuConf.ssh_key_path} -o StrictHostKeyChecking=no`,
              `${gpuConf.ssh_user}@${sshHost}:${remoteTempArchive}`, localTempArchive
            ];

            const proc = Bun.spawn(transferCmd, { stdout: "pipe", stderr: "pipe" });
            activeProc = proc;
            try {
              const stdoutPromise = readStream(proc.stdout, (line) => {
                const trimmed = line.trim();
                if (!trimmed) return;
                const progressMatch = trimmed.match(/\s+\d+(?:,\d+)*\s+(\d+)%\s+([^\s]+\/s)?\s*(\d+:\d+:\d+)?/);
                if (progressMatch) {
                  const percent = parseInt(progressMatch[1], 10);
                  const speed = progressMatch[2] || "";
                  const eta = progressMatch[3] || "";
                  emitProgress(percent, speed, eta);
                } else {
                  emit(line);
                }
              });
              const stderrPromise = readStream(proc.stderr, (line) => {
                if (line.trim()) emit(`Error: ${line}`);
              });
              await Promise.all([stdoutPromise, stderrPromise]);
              const transferExit = await proc.exited;
              if (transferExit !== 0) {
                emit(`Archive transfer failed with exit status ${transferExit}`);
                try {
                  const cleanupRemoteCmd = [
                    "ssh", "-p", String(sshPort), "-i", gpuConf.ssh_key_path,
                    "-o", "StrictHostKeyChecking=no", `${gpuConf.ssh_user}@${sshHost}`,
                    `rm -f ${remoteTempArchive}`
                  ];
                  Bun.spawn(cleanupRemoteCmd);
                } catch (_) {}
                return;
              }
            } finally {
              activeProc = null;
            }

            // 3. Extract locally
            emit("Extracting files locally...");
            const extractCmd = [
              "bash", "-c",
              `zstd -d -T0 -c ${localTempArchive} | tar -xf - -C ${BASE_DIR}`
            ];
            const extractExit = await runCmd(extractCmd, "Extracting files locally");
            if (extractExit !== 0) {
              emit(`Local extraction failed with exit status ${extractExit}`);
            } else {
              emitProgress(100, "", "00:00:00");
              emit("Sync back complete SUCCESS");
            }

            // 4. Cleanup both
            try { unlinkSync(localTempArchive); } catch (_) {}
            try {
              const cleanupRemoteCmd = [
                "ssh", "-p", String(sshPort), "-i", gpuConf.ssh_key_path,
                "-o", "StrictHostKeyChecking=no", `${gpuConf.ssh_user}@${sshHost}`,
                `rm -f ${remoteTempArchive}`
              ];
              Bun.spawn(cleanupRemoteCmd);
            } catch (_) {}
          }
        }
      } catch (e: any) {
        emit(`Error: ${e.message}`);
      } finally {
        isClosed = true;
        try {
          controller.close();
        } catch (_) {}
        logWriter.end();
      }
    },
    cancel(reason) {
      if (activeProc) {
        try {
          activeProc.kill();
        } catch (_) {}
      }
    }
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
