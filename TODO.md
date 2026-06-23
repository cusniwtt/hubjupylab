# HubJupyLab Development TODO

---

## 1. Fix GPU SSH Key Mismatch

### Symptom
GPU init logs show:
```
[apt-update ERR] Warning: Identity file /home/test/.ssh/id_rsa not accessible: No such file or directory.
```
Correct key: `ssh-ed25519` at `/home/hubjupylab/.ssh/id_ed25519`.

### Root Cause
Two sources of truth:
- `testGpuSsh` in `src/gpu.ts` uses `SSH_KEY_PATH` from `src/config.ts` → `/home/hubjupylab/.ssh/id_ed25519`
- `runStep` inside `gpuInitStream` uses `keyPath` from DB `gpu_config.ssh_key_path` → `/home/test/.ssh/id_rsa`
- `_rsyncStream` also hardcodes `SSH_KEY_PATH`, `SSH_USER`, `REMOTE_BASE_DIR` from `config.ts` (lines 263, 293, 298, 300, 324)

DB value came from legacy migration. Connection test passes (uses config.ts), but all actual SSH commands fail/warn (uses DB value).

### Design Decisions
- **Single source of truth**: DB `gpu_config` table. All functions read from DB, not config.ts.
- **Global key**: One `ssh_key_path` shared across all users. Per-user fields remain: `gpu_ssh_host`, `gpu_ssh_port`.
- **`remote_base_dir`**: Also from DB, not hardcoded. Rsync uses `gpu_config.remote_base_dir`.
- **Fresh install seed**: `initDb()` seeds `gpu_config` with defaults from config.ts values on first run. Admin edits later via UI.
- **Validation**: On save, validate `ssh_key_path` file exists on disk. Show error toast if not.
- **Admin UI placement**: Expandable row (decide exact layout later).

### Implementation Plan

| Step | Task | File(s) |
|------|------|---------|
| 1a | Fix `testGpuSsh` signature → accept `keyPath`, `sshUser` params instead of importing from config | `src/gpu.ts` |
| 1b | Update `stopGpuSession` same way — pass DB values | `src/gpu.ts` |
| 1c | Update `_rsyncStream` — read `gpuConf` from DB for `ssh_key_path`, `ssh_user`, `remote_base_dir` | `src/gpu.ts` |
| 1d | Update `gpuInitStream` — also read `remote_base_dir` from passed params (currently hardcoded) | `src/gpu.ts` |
| 1e | Remove `SSH_KEY_PATH`, `SSH_USER`, `REMOTE_BASE_DIR` from config — dead constants | `src/config.ts` |
| 1f | Update `initDb()` — seed `gpu_config` with sensible defaults (`/home/hubjupylab/.ssh/id_ed25519`, `root`, `/workspace`) | `src/db.ts` |
| 1g | Add admin UI section (expandable row) to edit global `gpu_config` (ssh_user, ssh_key_path, remote_base_dir) | `templates/admin.html` |
| 1h | Add route `POST /admin/gpu/config` → validate `ssh_key_path` exists on disk, then call `db.saveGpuConfig()` | `src/index.ts` |
| 1i | Update tests — fix broken signatures in `src/gpu.test.ts` after refactor | `src/gpu.test.ts` |
| 1j | **Hotfix**: update DB value `/home/test/.ssh/id_rsa` → `/home/hubjupylab/.ssh/id_ed25519` | DB |

---

## 2. Pinned Progress Bar for Rsync Console

### Requirement
Rsync sync ("Sync To GPU" / "Sync From GPU") should show a sticky progress bar pinned to bottom of console box — not scrolling away. **User dashboard only** (not admin GPU init console).

### Design Decisions
- **Progress mode**: Use `--info=progress2` instead of `-P` for **overall** transfer progress (single 0→100%), not per-file.
- **SSE event type**: Emit named `event: progress` for progress data, default unnamed events for log lines.
- **Frontend**: `addEventListener('progress', ...)` for progress bar updates, `onmessage` for regular log lines.
- **Scope**: Only user dashboard rsync console. Admin GPU init console stays as-is (step-by-step, no percentage).

### Implementation Plan

| Step | Task | File(s) |
|------|------|---------|
| 2a | **Backend**: Switch rsync flag from `-P` to `--info=progress2`. Parse overall progress lines matching `(\d+)%`. Emit `event: progress\ndata: {"percent":N,"speed":"...","eta":"..."}\n\n` | `src/gpu.ts` |
| 2b | **Frontend**: Wrap rsync console box in `position: relative` container. Add sticky bar at bottom (`position: sticky; bottom: 0`). Contains: CSS progress bar, percentage, speed/ETA | `templates/dashboard.html`, `static/style.css` |
| 2c | **JS**: Use `addEventListener('progress', ...)` for bar updates. Regular `onmessage` for log lines as before | `templates/dashboard.html` |
| 2d | Hide progress bar when rsync not active. Show on first progress event, hide on "SUCCESS"/"FAILED" | `templates/dashboard.html` |

### Effort Estimate
- Fix 1: ~1.5hr (wiring + admin form + validation + tests)
- Fix 2: ~1-2hr (SSE event parsing + CSS sticky bar)
