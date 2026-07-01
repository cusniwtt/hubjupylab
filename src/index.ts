import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import nunjucks from "nunjucks";
import crypto from "node:crypto";
import { join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync, mkdirSync } from "node:fs";
import * as config from "./config";
import * as db from "./db";
import * as spawner from "./spawner";
import * as gpu from "./gpu";
import { validateSshUser, validateSshHost, validateRemoteBaseDir } from "./gpu";

// Configure Nunjucks
const njk = nunjucks.configure("templates", { autoescape: true, noCache: true });

function render(name: string, ctx: Record<string, any> = {}): string {
  return njk.render(name, ctx);
}

// Session TTL: default 24 hours, configurable via SESSION_TTL_HOURS env var
const SESSION_TTL_MS = parseInt(Bun.env.SESSION_TTL_HOURS ?? "24", 10) * 60 * 60 * 1000;

// Cookie format: "username|issuedAtMs.hmac"
function signCookie(username: string): string {
  const payload = `${username}|${Date.now()}`;
  const sig = crypto.createHmac("sha256", config.SECRET_KEY).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function unsignCookie(signed: string): string | null {
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return null;
  const payload = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = crypto.createHmac("sha256", config.SECRET_KEY).update(payload).digest("base64url");
  if (sig !== expected) return null;
  const sep = payload.lastIndexOf("|");
  if (sep < 0) return null;
  const username = payload.slice(0, sep);
  const issuedAt = parseInt(payload.slice(sep + 1), 10);
  if (isNaN(issuedAt) || Date.now() - issuedAt > SESSION_TTL_MS) return null;
  return username;
}

function isHttps(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto");
  if (proto) return proto === "https";
  return new URL(request.url).protocol === "https:";
}

function sessionCookieFlags(request: Request): string {
  const secure = isHttps(request) ? "; Secure" : "";
  return `HttpOnly; SameSite=Lax; Path=/${secure}`;
}

function getCurrentUser(cookie: Record<string, any>): db.User | null {
  const session = cookie?.hub_session?.value;
  if (!session) return null;
  const username = unsignCookie(session);
  if (!username) return null;
  return db.getUserByUsername(username);
}

function buildJupyterUrl(hostIp: string, port: number, token: string): string {
  return `http://${hostIp}:${port}/lab?token=${token}`;
}

function buildCodeServerUrl(hostIp: string, port: number): string {
  return `http://${hostIp}:${port}/`;
}

function resolveHostIp(request: Request): string {
  if (config.HOST_IP) return config.HOST_IP;
  const url = new URL(request.url);
  return url.hostname;
}

/** Build GPU template context from a User row. Replaces the repeated inline .replace() hacks. */
function buildGpuCtx(user: db.User): Record<string, any> {
  return {
    has_gpu: !!user.gpu_endpoint,
    gpu_endpoint: user.gpu_endpoint ?? "",
    gpu_streamlit_url: user.gpu_streamlit_endpoint ?? "",
    gpu_code_server_url: user.gpu_code_server_endpoint ?? "",
    gpu_init_status: user.gpu_init_status ?? "",
    gpu_token: user.gpu_token ?? "",
  };
}

async function getEnrichedUsers(request: Request): Promise<Record<string, any>[]> {
  const users = db.listUsers();
  const hostIp = resolveHostIp(request);
  const enriched: Record<string, any>[] = [];
  for (const u of users) {
    const isRunning = await spawner.isSessionRunning(u.username);
    const jupyterUrl = isRunning && u.token ? buildJupyterUrl(hostIp, u.port!, u.token) : "";
    const codeServerUrl = isRunning ? buildCodeServerUrl(hostIp, u.port! + config.CODE_SERVER_PORT_OFFSET) : "";
    enriched.push({ ...u, is_running: isRunning, jupyter_url: jupyterUrl, code_server_url: codeServerUrl });
  }
  return enriched;
}

async function enrichUser(username: string, request: Request): Promise<Record<string, any> | null> {
  const user = db.getUserByUsername(username);
  if (!user) return null;
  const hostIp = resolveHostIp(request);
  const isRunning = await spawner.isSessionRunning(username);
  const jupyterUrl = isRunning && user.token ? buildJupyterUrl(hostIp, user.port!, user.token) : "";
  const codeServerUrl = isRunning ? buildCodeServerUrl(hostIp, user.port! + config.CODE_SERVER_PORT_OFFSET) : "";
  return { ...user, is_running: isRunning, jupyter_url: jupyterUrl, code_server_url: codeServerUrl };
}

// Convert ReadableStream<string> to ReadableStream<Uint8Array> for SSE Responses
function toUint8ArrayStream(stringStream: ReadableStream<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const reader = stringStream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(encoder.encode(value));
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason);
    }
  });
}

// Initialize and start db/session sync
await db.initDb();
await spawner.syncSessions();

const app = new Elysia()
  .use(staticPlugin({ prefix: "/static", assets: "static" }))

  // --- Auth & Profile APIs ---
  .get("/api/me", ({ cookie }) => {
    const user = getCurrentUser(cookie);
    if (!user) return Response.json({ authenticated: false }, { status: 401 });
    return Response.json({
      authenticated: true,
      username: user.username,
      role: user.role,
      must_change_password: !!user.must_change_password
    });
  })

  .post("/api/login", async ({ body, set, request }) => {
    const { username, password } = body as { username?: string; password?: string };
    if (!username || !password) {
      return Response.json({ error: "Missing credentials" }, { status: 400 });
    }
    const user = db.getUserByUsername(username);
    const DUMMY_HASH = "$2b$10$invalidhashvaluethatnevermatchesXXXXXXXXXXXXXXXXXXXXX";
    const passwordOk = user
      ? await db.verifyPassword(password, user.password_hash)
      : (await db.verifyPassword(password, DUMMY_HASH), false);
    if (!user || !passwordOk) {
      return Response.json({ error: "Invalid credentials" }, { status: 401 });
    }
    const signed = signCookie(username);
    set.headers["Set-Cookie"] = `hub_session=${signed}; ${sessionCookieFlags(request)}`;
    return Response.json({
      ok: true,
      username: user.username,
      role: user.role,
      must_change_password: !!user.must_change_password
    });
  })

  .post("/api/logout", ({ set, request }) => {
    set.headers["Set-Cookie"] = `hub_session=; ${sessionCookieFlags(request)}; Max-Age=0`;
    return Response.json({ ok: true });
  })

  .post("/api/change-password", async ({ cookie, body }) => {
    const user = getCurrentUser(cookie);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const { password, confirm_password } = body as { password?: string; confirm_password?: string };
    if (!password || !confirm_password) {
      return Response.json({ error: "Missing fields" }, { status: 400 });
    }
    if (password !== confirm_password) {
      return Response.json({ error: "Passwords do not match" }, { status: 400 });
    }
    if (password.length < 8) {
      return Response.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }
    await db.changePassword(user.username, password, false);
    return Response.json({ ok: true });
  })

  // --- User Session Controls ---
  .get("/api/session/status", async ({ cookie, request }) => {
    const user = getCurrentUser(cookie);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    const hostIp = resolveHostIp(request);
    const isRunning = await spawner.isSessionRunning(user.username);
    const jupyterUrl = isRunning && user.token ? buildJupyterUrl(hostIp, user.port!, user.token) : "";
    const codeServerUrl = isRunning ? buildCodeServerUrl(hostIp, user.port! + config.CODE_SERVER_PORT_OFFSET) : "";
    return Response.json({
      username: user.username,
      port: user.port,
      is_running: isRunning,
      jupyter_url: jupyterUrl,
      code_server_url: codeServerUrl,
      ssh_host: hostIp,
      ssh_port: config.SSH_PORT,
      ...buildGpuCtx(user)
    });
  })

  .post("/api/session/start", async ({ cookie, request }) => {
    const user = getCurrentUser(cookie);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role === "admin") return Response.json({ error: "Admins cannot run sessions" }, { status: 403 });
    if (user.must_change_password) return Response.json({ error: "Password change required", must_change_password: true }, { status: 403 });

    const username = user.username;
    const port = user.port!;
    const hostIp = resolveHostIp(request);
    const token = crypto.randomBytes(16).toString("base64url");

    const success = await spawner.spawnSession(username, port, token);
    if (!success) {
      return Response.json({ error: "Failed to start JupyterLab session" }, { status: 500 });
    }

    db.updateToken(username, token);
    return Response.json({
      ok: true,
      token,
      jupyter_url: buildJupyterUrl(hostIp, port, token),
      code_server_url: buildCodeServerUrl(hostIp, port + config.CODE_SERVER_PORT_OFFSET)
    });
  })

  .post("/api/session/stop", async ({ cookie }) => {
    const user = getCurrentUser(cookie);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role === "admin") return Response.json({ error: "Admins cannot run sessions" }, { status: 403 });
    if (user.must_change_password) return Response.json({ error: "Password change required", must_change_password: true }, { status: 403 });

    const username = user.username;
    const success = await spawner.stopSession(username);
    if (!success) {
      return Response.json({ error: "Failed to stop JupyterLab session" }, { status: 500 });
    }

    db.updateToken(username, null);
    return Response.json({ ok: true });
  })

  .post("/api/session/restart", async ({ cookie, request }) => {
    const user = getCurrentUser(cookie);
    if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (user.role === "admin") return Response.json({ error: "Admins cannot run sessions" }, { status: 403 });
    if (user.must_change_password) return Response.json({ error: "Password change required", must_change_password: true }, { status: 403 });

    const username = user.username;
    const port = user.port!;
    const hostIp = resolveHostIp(request);
    const token = crypto.randomBytes(16).toString("base64url");

    const success = await spawner.spawnSession(username, port, token);
    if (!success) {
      db.updateToken(username, null);
      return Response.json({ error: "Failed to restart JupyterLab session" }, { status: 500 });
    }

    db.updateToken(username, token);
    return Response.json({
      ok: true,
      token,
      jupyter_url: buildJupyterUrl(hostIp, port, token),
      code_server_url: buildCodeServerUrl(hostIp, port + config.CODE_SERVER_PORT_OFFSET)
    });
  })

  // --- Admin User & Session Controls ---
  .get("/api/admin/users", async ({ cookie, request }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    const enriched = await getEnrichedUsers(request);
    const gpuConfig = db.getGpuConfig();

    const gpuLogsDir = join(config.BASE_DIR, ".gpu_logs");
    const rsyncLogsDir = join(config.BASE_DIR, ".rsync_logs");
    const logs: any[] = [];

    if (existsSync(gpuLogsDir)) {
      const files = readdirSync(gpuLogsDir);
      for (const f of files) {
        if (f.endsWith(".log")) {
          const fullPath = join(gpuLogsDir, f);
          const stat = statSync(fullPath);
          logs.push({
            name: f,
            type: "gpu-init",
            size: stat.size,
            mtime: stat.mtimeMs / 1000
          });
        }
      }
    }

    if (existsSync(rsyncLogsDir)) {
      const files = readdirSync(rsyncLogsDir);
      for (const f of files) {
        if (f.endsWith(".log")) {
          const fullPath = join(rsyncLogsDir, f);
          const stat = statSync(fullPath);
          logs.push({
            name: f,
            type: f.includes("rsync-to") ? "rsync-to" : "rsync-from",
            size: stat.size,
            mtime: stat.mtimeMs / 1000
          });
        }
      }
    }

    logs.sort((a, b) => b.mtime - a.mtime);

    return Response.json({
      users: enriched,
      gpu_config: gpuConfig,
      logs
    });
  })

  .post("/api/admin/users", async ({ body, cookie }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    const { username } = body as { username?: string };

    const userTrim = (username ?? "").trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(userTrim)) {
      return Response.json({ error: "Username must be alphanumeric" }, { status: 400 });
    }

    const port = spawner.getNextPort();
    if (!port) {
      return Response.json({ error: "No available ports left (limit 9)" }, { status: 400 });
    }

    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let tempPass = "";
    for (let i = 0; i < 12; i++) {
      tempPass += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    const created = await db.createUser(userTrim, tempPass, "user", port);
    if (!created) {
      return Response.json({ error: "Username already exists" }, { status: 400 });
    }

    await db.changePassword(userTrim, tempPass, true);

    const envOk = await spawner.setupUserEnv(userTrim);
    if (!envOk) {
      db.deleteUser(userTrim);
      return Response.json({ error: "Failed to initialize venv for user" }, { status: 500 });
    }

    return Response.json({
      ok: true,
      username: userTrim,
      tempPass
    });
  })

  .post("/api/admin/users/:username/delete", async ({ params, body, cookie }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return Response.json({ error: "Invalid username" }, { status: 400 });
    }

    await spawner.stopSession(username);

    const deleteFiles = (body as any)?.delete_files === true || (body as any)?.delete_files === "true";
    let msg = "";
    if (deleteFiles) {
      spawner.cleanupUserFiles(username);
      msg = `Deleted user ${username} and all files`;
    } else {
      msg = `Deleted user ${username} (files preserved)`;
    }

    db.deleteUser(username);
    return Response.json({ ok: true, message: msg });
  })

  .post("/api/admin/users/:username/reset-password", async ({ params, cookie }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return Response.json({ error: "Invalid username" }, { status: 400 });
    }
    const user = db.getUserByUsername(username);
    if (!user) return Response.json({ error: "User not found" }, { status: 404 });

    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let tempPass = "temp-";
    for (let i = 0; i < 8; i++) {
      tempPass += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    await db.changePassword(username, tempPass, true);
    return Response.json({ ok: true, tempPass });
  })

  .post("/api/admin/session/start/:username", async ({ params, cookie, request }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return Response.json({ error: "Invalid username" }, { status: 400 });
    }
    const user = db.getUserByUsername(username);
    if (!user) return Response.json({ error: "User not found" }, { status: 404 });

    const port = user.port!;
    const token = crypto.randomBytes(16).toString("base64url");
    const success = await spawner.spawnSession(username, port, token);
    if (!success) {
      return Response.json({ error: `Failed to start session for ${username}` }, { status: 500 });
    }

    db.updateToken(username, token);
    const enriched = await enrichUser(username, request);
    return Response.json({ ok: true, user: enriched });
  })

  .post("/api/admin/session/stop/:username", async ({ params, cookie, request }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return Response.json({ error: "Invalid username" }, { status: 400 });
    }
    const user = db.getUserByUsername(username);
    if (!user) return Response.json({ error: "User not found" }, { status: 404 });

    const success = await spawner.stopSession(username);
    if (!success) {
      return Response.json({ error: `Failed to stop session for ${username}` }, { status: 500 });
    }

    db.updateToken(username, null);
    const enriched = await enrichUser(username, request);
    return Response.json({ ok: true, user: enriched });
  })

  .post("/api/admin/session/restart/:username", async ({ params, cookie, request }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return Response.json({ error: "Invalid username" }, { status: 400 });
    }
    const user = db.getUserByUsername(username);
    if (!user) return Response.json({ error: "User not found" }, { status: 404 });

    const port = user.port!;
    const token = crypto.randomBytes(16).toString("base64url");
    const success = await spawner.spawnSession(username, port, token);
    if (!success) {
      db.updateToken(username, null);
      return Response.json({ error: `Failed to restart session for ${username}` }, { status: 500 });
    }

    db.updateToken(username, token);
    const enriched = await enrichUser(username, request);
    return Response.json({ ok: true, user: enriched });
  })

  // --- Admin GPU VM & Logging APIs ---
  .post("/api/admin/gpu/assign/:username", async ({ params, body, cookie, request }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return Response.json({ error: "Invalid username" }, { status: 400 });
    }
    const user = db.getUserByUsername(username);
    if (!user) return Response.json({ error: "User not found" }, { status: 404 });

    const { gpu_ssh_host, gpu_ssh_port, gpu_ssh_user, gpu_endpoint, gpu_streamlit_endpoint, gpu_code_server_endpoint, gpu_token } = body as Record<string, any>;
    const host = (gpu_ssh_host ?? "").trim();
    const port = gpu_ssh_port ? parseInt(gpu_ssh_port, 10) : 22;
    const sshUser = (gpu_ssh_user ?? "root").trim();
    const endpoint = (gpu_endpoint ?? "").trim();
    const streamlitEndpoint = (gpu_streamlit_endpoint ?? "").trim();
    const codeServerEndpoint = (gpu_code_server_endpoint ?? "").trim();
    const tokenToSave = (gpu_token ?? "").trim() || user.gpu_token || "";

    if (endpoint !== "" && !gpu.isValidGpuEndpoint(endpoint)) {
      return Response.json({ error: "Invalid GPU endpoint URL format" }, { status: 400 });
    }

    if (host) {
      try {
        validateSshHost(host);
        validateSshUser(sshUser);
      } catch (e: any) {
        return Response.json({ error: `Invalid SSH config: ${e.message}` }, { status: 400 });
      }
    }

    for (const [label, ep] of [["Streamlit", streamlitEndpoint], ["Code Server", codeServerEndpoint]] as [string, string][]) {
      if (ep !== "" && !gpu.isValidGpuEndpoint(ep)) {
        return Response.json({ error: `Invalid ${label} endpoint URL` }, { status: 400 });
      }
    }

    db.assignGpu(username, endpoint, tokenToSave, host, port, sshUser, streamlitEndpoint, codeServerEndpoint);
    const enriched = await enrichUser(username, request);
    return Response.json({ ok: true, user: enriched });
  })

  .post("/api/admin/gpu/unassign/:username", async ({ params, cookie, request }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return Response.json({ error: "Invalid username" }, { status: 400 });
    }

    db.unassignGpu(username);
    const enriched = await enrichUser(username, request);
    return Response.json({ ok: true, user: enriched });
  })

  .get("/admin/gpu/init-stream/:username", async ({ params, cookie, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return new Response("Forbidden", { status: 403 });
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return new Response("Invalid username", { status: 400 });
    }
    // CSRF guard for state-mutating GET
    const fetchSite = headers["sec-fetch-site"];
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site") {
      return new Response("Forbidden: cross-origin request", { status: 403 });
    }
    const user = db.getUserByUsername(username);
    if (!user) return new Response("User not found", { status: 404 });

    const sseHeaders = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    };

    const sshHost = user.gpu_ssh_host;
    const sshPort = user.gpu_ssh_port ?? 22;
    const gpuConf = db.getGpuConfig();

    if (!sshHost || !gpuConf.ssh_key_path) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: Error: GPU SSH not configured\n\n"));
          controller.close();
        }
      });
      return new Response(stream, { headers: sseHeaders });
    }

    // Atomic TOCTOU guard: set 'running' only if not already running
    const won = db.trySetGpuInitRunning(username);
    if (!won) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: Error: Initialization already in progress\n\n"));
          controller.close();
        }
      });
      return new Response(stream, { headers: sseHeaders });
    }

    let token = user.gpu_token;
    if (!token) {
      token = crypto.randomBytes(16).toString("base64url");
      db.assignGpu(username, user.gpu_endpoint ?? "", token, sshHost, sshPort, user.gpu_ssh_user ?? "root",
        user.gpu_streamlit_endpoint ?? "", user.gpu_code_server_endpoint ?? "");
    }

    const stringStream = gpu.gpuInitStream(
      username,
      sshHost,
      sshPort,
      gpuConf.ssh_key_path,
      user.gpu_ssh_user || "root",
      token,
      user.gpu_endpoint ?? "",
      gpuConf.remote_base_dir
    );

    return new Response(toUint8ArrayStream(stringStream), { headers: sseHeaders });
  })

  .post("/api/admin/gpu/stop/:username", async ({ params, cookie, request }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return Response.json({ error: "Invalid username" }, { status: 400 });
    }

    const [success, msg] = await gpu.stopGpuSession(username);
    if (!success) {
      return Response.json({ error: msg }, { status: 500 });
    }
    const enriched = await enrichUser(username, request);
    return Response.json({ ok: true, user: enriched });
  })

  .post("/api/admin/gpu/reset/:username", async ({ params, cookie, request }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return Response.json({ error: "Invalid username" }, { status: 400 });
    }

    db.updateGpuInitStatus(username, null);
    const enriched = await enrichUser(username, request);
    return Response.json({ ok: true, user: enriched });
  })

  .get("/api/admin/gpu/config", ({ cookie }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    return Response.json(db.getGpuConfig());
  })

  .post("/api/admin/gpu/config", async ({ body, cookie }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const { ssh_key_path, remote_base_dir, additional_public_keys } = body as Record<string, any>;
    const keyPath = (ssh_key_path ?? "").trim();
    const rBaseDir = (remote_base_dir ?? "/workspace").trim();
    const addPubKeys = (additional_public_keys ?? "").trim();

    if (!keyPath || !existsSync(keyPath)) {
      return Response.json({ error: `SSH Key file not found on disk: ${keyPath}` }, { status: 400 });
    }

    try {
      validateRemoteBaseDir(rBaseDir);
    } catch (e: any) {
      return Response.json({ error: `Invalid config value: ${e.message}` }, { status: 400 });
    }

    db.saveGpuConfig("", 22, "root", keyPath, rBaseDir, addPubKeys);
    return Response.json({ ok: true });
  })

  .get("/api/admin/gpu/last-log/:username", ({ params, cookie }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return Response.json({ error: "Invalid username" }, { status: 400 });
    }
    const logContent = gpu.getLastGpuLog(username);
    return Response.json({ log: logContent });
  })

  .get("/api/admin/logs", ({ cookie }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const gpuLogsDir = join(config.BASE_DIR, ".gpu_logs");
    const rsyncLogsDir = join(config.BASE_DIR, ".rsync_logs");
    const logs: any[] = [];

    if (existsSync(gpuLogsDir)) {
      const files = readdirSync(gpuLogsDir);
      for (const f of files) {
        if (f.endsWith(".log")) {
          const fullPath = join(gpuLogsDir, f);
          const stat = statSync(fullPath);
          logs.push({
            name: f,
            type: "gpu-init",
            size: stat.size,
            mtime: stat.mtimeMs / 1000
          });
        }
      }
    }

    if (existsSync(rsyncLogsDir)) {
      const files = readdirSync(rsyncLogsDir);
      for (const f of files) {
        if (f.endsWith(".log")) {
          const fullPath = join(rsyncLogsDir, f);
          const stat = statSync(fullPath);
          logs.push({
            name: f,
            type: f.includes("rsync-to") ? "rsync-to" : "rsync-from",
            size: stat.size,
            mtime: stat.mtimeMs / 1000
          });
        }
      }
    }

    logs.sort((a, b) => b.mtime - a.mtime);
    return Response.json({ logs });
  })

  .get("/api/admin/logs/view", ({ query, cookie }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return Response.json({ error: "Forbidden" }, { status: 403 });

    const filename = query.filename;
    if (!filename || filename.includes("..") || filename.startsWith("/") || filename.startsWith("\\")) {
      return Response.json({ error: "Invalid filename" }, { status: 400 });
    }

    const gpuLogsDir = join(config.BASE_DIR, ".gpu_logs");
    const rsyncLogsDir = join(config.BASE_DIR, ".rsync_logs");

    let filePath = join(gpuLogsDir, filename);
    if (!existsSync(filePath)) {
      filePath = join(rsyncLogsDir, filename);
    }

    if (!existsSync(filePath)) {
      return Response.json({ error: "Log file not found" }, { status: 404 });
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      return Response.json({ filename, content });
    } catch (err: any) {
      return Response.json({ error: `Error reading log file: ${err.message}` }, { status: 500 });
    }
  })

  // --- User GPU Sync & Tree APIs ---
  .get("/session/gpu/sync-to-stream", ({ cookie, query, redirect, headers, request }) => {
    const user = getCurrentUser(cookie);
    if (!user) return redirect("/", 302);
    if (user.role === "admin") return new Response("Forbidden", { status: 403 });
    if (user.must_change_password) return new Response("Forbidden: change password first", { status: 403 });
    // CSRF guard: SSE GET mutates state; verify same-origin via Sec-Fetch-Site
    const fetchSite = headers["sec-fetch-site"];
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site") {
      return new Response("Forbidden: cross-origin request", { status: 403 });
    }

    const responseStream = toUint8ArrayStream(gpu.rsyncToGpuStream(user.username, query.path ?? ""));
    return new Response(responseStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  })

  .get("/session/gpu/sync-from-stream", ({ cookie, query, redirect, headers, request }) => {
    const user = getCurrentUser(cookie);
    if (!user) return redirect("/", 302);
    if (user.role === "admin") return new Response("Forbidden", { status: 403 });
    if (user.must_change_password) return new Response("Forbidden: change password first", { status: 403 });
    const fetchSite = headers["sec-fetch-site"];
    if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "same-site") {
      return new Response("Forbidden: cross-origin request", { status: 403 });
    }

    const responseStream = toUint8ArrayStream(gpu.rsyncFromGpuStream(user.username, query.path ?? ""));
    return new Response(responseStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  })

  .get("/session/gpu/list-dirs", ({ cookie }) => {
    const user = getCurrentUser(cookie);
    if (!user) return new Response("Unauthorized", { status: 401 });
    if (user.role === "admin") return new Response("Forbidden", { status: 403 });
    if (user.must_change_password) return new Response("Forbidden: change password first", { status: 403 });

    const userDir = join(config.BASE_DIR, user.username);
    if (!existsSync(userDir)) return Response.json([]);

    function getTree(dir: string, base: string): any[] {
      const tree: any[] = [];
      try {
        const items = readdirSync(dir).sort();
        for (const name of items) {
          const full = join(dir, name);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            if ([".git", ".venv", "__pycache__", ".ipynb_checkpoints"].includes(name)) continue;
            const rel = full.slice(base.length + 1);
            tree.push({ name, path: rel, children: getTree(full, base) });
          }
        }
      } catch (_) {}
      return tree;
    }

    return Response.json(getTree(userDir, userDir));
  })

  // --- SPA Frontend Fallback (React Router client-side routing support) ---
  .get("*", ({ set, path }) => {
    // If the path points to a file in frontend/dist, serve it
    const filePath = join(__dirname, "../frontend/dist", path);
    if (existsSync(filePath) && !statSync(filePath).isDirectory()) {
      if (path.endsWith(".js")) set.headers["Content-Type"] = "application/javascript";
      else if (path.endsWith(".css")) set.headers["Content-Type"] = "text/css";
      else if (path.endsWith(".svg")) set.headers["Content-Type"] = "image/svg+xml";
      else if (path.endsWith(".png")) set.headers["Content-Type"] = "image/png";
      else if (path.endsWith(".ico")) set.headers["Content-Type"] = "image/x-icon";
      return readFileSync(filePath);
    }
    const htmlPath = join(__dirname, "../frontend/dist/index.html");
    if (existsSync(htmlPath)) {
      set.headers["Content-Type"] = "text/html";
      return readFileSync(htmlPath);
    }
    return new Response(
      "Frontend build not found. Running in development? Use the Vite dev server at http://localhost:5173",
      { status: 404 }
    );
  })

  .listen(config.HUB_PORT);

console.log(`HubJupyLab running on http://0.0.0.0:${config.HUB_PORT}`);
