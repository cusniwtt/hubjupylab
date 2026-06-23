# Design Specification: GPU Sync Excludes and Performance Optimizations

This document describes the design and implementation details for optimizing synchronization between the local Hub and remote GPU VMs.

## Proposed Changes

### 1. Centralized Sync Exclude Patterns
We will centralize all exclude patterns into a single array, preventing duplication and inconsistencies between `rsync`, local `tar`, and remote `tar` commands.

The centralized patterns are:
- `*venv*` (Virtual environments)
- `__pycache__` (Python bytecode cache)
- `.ipynb_checkpoints` (Jupyter notebook checkpoints)
- `hf_cache` (Hugging Face model caches)
- `.cache` (General package/tool caches, including huggingface, pip, matplotlib)
- `.conda` (Conda packages/environments)
- `.local` (User local packages/libraries)
- `nohup.out` (Log output files)

### 2. Bypass Zstd Compression for Subsequent Syncs
To dramatically speed up subsequent syncs:
- Check if the target directory already exists at the destination.
- If it **already exists** (meaning this is a subsequent sync), we bypass compression entirely and run direct `rsync -av` with exclude patterns. Direct `rsync` performs delta checks and completes in seconds.
- If it **does not exist**, we fall back to threshold checking to determine if zstd compression is required.

### 3. Customizable Size and File Count Thresholds
We will introduce customizable thresholds for zstd compression (when target directory does not exist):
- **Size Threshold**: Default `1 GB` (1,073,741,824 bytes).
- **File Count Threshold**: Default `5000` files.
- These thresholds can be customized via `.env` configuration variables:
  - `SYNC_SIZE_THRESHOLD`: Size in bytes (default `1073741824`).
  - `SYNC_FILE_THRESHOLD`: File count limit (default `5000`).

---

## Detailed Component Design

### Constants (`src/config.ts`)
Add environment-driven thresholds:
```typescript
export const SYNC_SIZE_THRESHOLD = parseInt(Bun.env.SYNC_SIZE_THRESHOLD ?? "1073741824", 10);
export const SYNC_FILE_THRESHOLD = parseInt(Bun.env.SYNC_FILE_THRESHOLD ?? "5000", 10);
```

### Excludes Array (`src/gpu.ts`)
Add centralized exclusion array:
```typescript
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
```

### Remote and Local Checks (`src/gpu.ts`)
Implement helper utilities to evaluate remote directory existence, local/remote file count:
```typescript
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
```

### Sync Decider Logic (`src/gpu.ts`)
Integrate exists-check and thresholds inside `_rsyncStream`:
```typescript
let useZstd = false;

if (direction === "to") {
  const targetExists = await remoteDirExists(sshPort, gpuConf.ssh_key_path, gpuConf.ssh_user, sshHost, remoteDir);
  
  if (!targetExists) {
    const localSize = await getLocalDirSize(targetDir);
    const localCount = await getLocalFileCount(targetDir);
    if (localSize > SYNC_SIZE_THRESHOLD || localCount > SYNC_FILE_THRESHOLD) {
      useZstd = true;
      totalBytes = localSize;
    }
  }
} else { // direction === "from"
  const targetExists = existsSync(targetDir);
  
  if (!targetExists) {
    const remoteSize = await getRemoteDirSize(sshPort, gpuConf.ssh_key_path, gpuConf.ssh_user, sshHost, remoteDir);
    const remoteCount = await getRemoteFileCount(sshPort, gpuConf.ssh_key_path, gpuConf.ssh_user, sshHost, remoteDir);
    if (remoteSize > SYNC_SIZE_THRESHOLD || remoteCount > SYNC_FILE_THRESHOLD) {
      useZstd = true;
      totalBytes = remoteSize;
    }
  }
}
```

---

## Verifiability and Testing
We will verify:
1. All unit and integration tests (`bun test`) continue to pass.
2. The logic resolves properly by simulating mock syncing of paths.
