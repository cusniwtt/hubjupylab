# GPU Sync Excludes and Performance Optimizations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optimize directory synchronization by implementing configurable exclude lists, target directory existence checks, and dynamic zstd compression thresholds.

**Architecture:** 
1. Define configurable thresholds in `src/config.ts`.
2. Define a centralized excludes list in `src/gpu.ts` and construct corresponding argument formats.
3. Add utility functions for checking remote directory existence and calculating directory file counts.
4. Update the sync decision engine in `src/gpu.ts` to skip zstd compression if target directory exists, or evaluate the size and file count thresholds.

**Tech Stack:** Bun, TypeScript, Rsync, Tar, Zstd, SSH.

## Global Constraints
- Target VM is remote Linux (Ubuntu).
- Exclusions list covers standard cache/venv directories (`*venv*`, `__pycache__`, `.ipynb_checkpoints`, `hf_cache`, `.cache`, `.conda`, `.local`, `nohup.out`).
- Thresholds are configurable via `.env` with defaults: size limit 1 GB, file count limit 5000.

---

### Task 1: Add Configuration Thresholds

**Files:**
- Modify: `src/config.ts`

**Interfaces:**
- Consumes: None.
- Produces: `SYNC_SIZE_THRESHOLD` (number) and `SYNC_FILE_THRESHOLD` (number) exports.

- [ ] **Step 1: Write tests for threshold defaults**

Add a test in `src/gpu.test.ts`:
```typescript
test("Configuration thresholds have correct default values", () => {
  const { SYNC_SIZE_THRESHOLD, SYNC_FILE_THRESHOLD } = require("./config");
  expect(SYNC_SIZE_THRESHOLD).toBe(1073741824); // 1 GB
  expect(SYNC_FILE_THRESHOLD).toBe(5000); // 5000 files
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/gpu.test.ts -t "Configuration thresholds"`
Expected: FAIL due to `SYNC_SIZE_THRESHOLD` and `SYNC_FILE_THRESHOLD` not exported or undefined.

- [ ] **Step 3: Implement thresholds in config**

Modify `src/config.ts` to append:
```typescript
export const SYNC_SIZE_THRESHOLD = parseInt(Bun.env.SYNC_SIZE_THRESHOLD ?? "1073741824", 10);
export const SYNC_FILE_THRESHOLD = parseInt(Bun.env.SYNC_FILE_THRESHOLD ?? "5000", 10);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/gpu.test.ts -t "Configuration thresholds"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/gpu.test.ts
git commit -m "feat: add config thresholds for size and file counts"
```

---

### Task 2: Centralized Excludes Array and Helper Utilities

**Files:**
- Modify: `src/gpu.ts`
- Modify: `src/gpu.test.ts`

**Interfaces:**
- Consumes: `SYNC_SIZE_THRESHOLD`, `SYNC_FILE_THRESHOLD` from `src/config.ts`.
- Produces:
  - `SYNC_EXCLUDES` (string[])
  - `remoteDirExists(sshPort, sshKeyPath, sshUser, sshHost, path)` -> `Promise<boolean>`
  - `getLocalFileCount(path)` -> `Promise<number>`
  - `getRemoteFileCount(sshPort, sshKeyPath, sshUser, sshHost, path)` -> `Promise<number>`

- [ ] **Step 1: Write tests for excludes list and helper stubs**

Add tests to `src/gpu.test.ts`:
```typescript
test("SYNC_EXCLUDES contains all required patterns", () => {
  const { SYNC_EXCLUDES } = require("./gpu");
  expect(SYNC_EXCLUDES).toContain("hf_cache");
  expect(SYNC_EXCLUDES).toContain(".cache");
  expect(SYNC_EXCLUDES).toContain(".conda");
  expect(SYNC_EXCLUDES).toContain(".local");
  expect(SYNC_EXCLUDES).toContain("nohup.out");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/gpu.test.ts -t "SYNC_EXCLUDES"`
Expected: FAIL due to missing export.

- [ ] **Step 3: Implement excludes and helpers in gpu.ts**

At the top of `src/gpu.ts` (after imports):
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

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/gpu.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/gpu.ts src/gpu.test.ts
git commit -m "feat: implement SYNC_EXCLUDES and directory helper functions"
```

---

### Task 3: Integrate Sync Decision Logic & Build Commands

**Files:**
- Modify: `src/gpu.ts`
- Modify: `src/gpu.test.ts`

**Interfaces:**
- Consumes: `SYNC_SIZE_THRESHOLD` and `SYNC_FILE_THRESHOLD` from `src/config.ts`, `SYNC_EXCLUDES` and helpers from `src/gpu.ts`.
- Produces: Updated sync streaming execution routing inside `_rsyncStream`.

- [ ] **Step 1: Write test validating formatting of excludes arguments**

Add a mock testing section or helper check to verify argument construction matches formatting specification.

- [ ] **Step 2: Run tests to verify existing suite is intact**

Run: `bun test src/gpu.test.ts`
Expected: PASS (stub stage)

- [ ] **Step 3: Update `_rsyncStream` routing and commands**

Modify `_rsyncStream` in `src/gpu.ts`:
1. Use `SYNC_EXCLUDES` to dynamically construct:
   - `rsyncExcludeArgs`: `const rsyncExcludeArgs = SYNC_EXCLUDES.flatMap(p => ["--exclude", p]);`
   - `localTarExcludeArgs`: `const localTarExcludeArgs = SYNC_EXCLUDES.map(p => `--exclude=${p}`);`
   - `remoteTarExcludeStr`: `const remoteTarExcludeStr = SYNC_EXCLUDES.map(p => `--exclude="${p}"`).join(" ");`
2. Integrate `useZstd` decision checking:
   ```typescript
        // Calculate total size and decide on Zstd compression
        let totalBytes = 1;
        let useZstd = false;

        if (direction === "to") {
          emit("Checking remote directory status...");
          const targetExists = await remoteDirExists(sshPort, gpuConf.ssh_key_path, gpuConf.ssh_user, sshHost, remoteDir);
          
          if (!targetExists) {
            emit("Calculating directory size and file count...");
            const localSize = await getLocalDirSize(targetDir);
            const localCount = await getLocalFileCount(targetDir);
            
            const sizeLimit = require("./config").SYNC_SIZE_THRESHOLD;
            const fileLimit = require("./config").SYNC_FILE_THRESHOLD;
            
            if (localSize > sizeLimit || localCount > fileLimit) {
              useZstd = true;
              totalBytes = localSize;
            }
          }
        } else { // direction === "from"
          const targetExists = existsSync(targetDir);
          
          if (!targetExists) {
            emit("Calculating remote directory size and file count...");
            const remoteDirToMeasure = `${gpuConf.remote_base_dir}/${username}/${syncSub}`;
            const remoteSize = await getRemoteDirSize(sshPort, gpuConf.ssh_key_path, gpuConf.ssh_user, sshHost, remoteDirToMeasure);
            const remoteCount = await getRemoteFileCount(sshPort, gpuConf.ssh_key_path, gpuConf.ssh_user, sshHost, remoteDirToMeasure);
            
            const sizeLimit = require("./config").SYNC_SIZE_THRESHOLD;
            const fileLimit = require("./config").SYNC_FILE_THRESHOLD;
            
            if (remoteSize > sizeLimit || remoteCount > fileLimit) {
              useZstd = true;
              totalBytes = remoteSize;
            }
          }
        }
   ```
3. Use the dynamically computed `useZstd` flag:
   - Change `if (totalBytes <= TAR_THRESHOLD_BYTES)` to `if (!useZstd)`.
   - Update commands inside `if (!useZstd)` to inject `rsyncExcludeArgs`.
   - Update commands inside the `else` (large sync) block to use `localTarExcludeArgs` (for compression) and `remoteTarExcludeStr` (for remote compression).

- [ ] **Step 4: Run all unit tests to verify correctness**

Run: `bun test`
Expected: PASS (All tests, including user directory structure and path injection tests, pass successfully).

- [ ] **Step 5: Commit**

```bash
git add src/gpu.ts src/gpu.test.ts
git commit -m "feat: integrate sync decision logic and excludes formatting into rsync stream"
```
