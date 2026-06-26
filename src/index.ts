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
    const codeServerUrl = isRunning && u.token ? buildCodeServerUrl(hostIp, u.port! + config.CODE_SERVER_PORT_OFFSET) : "";
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
  const codeServerUrl = isRunning && user.token ? buildCodeServerUrl(hostIp, user.port! + config.CODE_SERVER_PORT_OFFSET) : "";
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

  // --- Auth Routes ---
  .get("/", ({ cookie, query, redirect }) => {
    const user = getCurrentUser(cookie);
    if (user) {
      return redirect(user.role === "admin" ? "/admin" : "/dashboard");
    }
    return new Response(render("login.html", {
      user: null, error: query.error ?? null, success: query.success ?? null
    }), { headers: { "Content-Type": "text/html" } });
  })

  .post("/login", async ({ body, set, redirect, request }) => {
    const { username, password } = body as { username?: string; password?: string };
    if (!username || !password) {
      return redirect("/?error=Missing+credentials", 303);
    }
    const user = db.getUserByUsername(username);
    // Always run bcrypt to prevent username enumeration via timing
    const DUMMY_HASH = "$2b$10$invalidhashvaluethatnevermatchesXXXXXXXXXXXXXXXXXXXXX";
    const passwordOk = user
      ? await db.verifyPassword(password, user.password_hash)
      : (await db.verifyPassword(password, DUMMY_HASH), false);
    if (!user || !passwordOk) {
      return redirect("/?error=Invalid+credentials", 303);
    }
    const signed = signCookie(username);
    set.headers["Set-Cookie"] = `hub_session=${signed}; ${sessionCookieFlags(request)}`;
    return redirect(user.must_change_password ? "/change-password" : (user.role === "admin" ? "/admin" : "/dashboard"), 303);
  })

  .get("/logout", ({ set, redirect, request }) => {
    set.headers["Set-Cookie"] = `hub_session=; ${sessionCookieFlags(request)}; Max-Age=0`;
    return redirect("/", 302);
  })

  // --- User Dashboard ---
  .get("/dashboard", async ({ cookie, query, request, redirect }) => {
    const user = getCurrentUser(cookie);
    if (!user) return redirect("/", 302);
    if (user.role === "admin") return redirect("/admin", 302);
    if (user.must_change_password) return redirect("/change-password", 302);

    const hostIp = resolveHostIp(request);
    const isRunning = await spawner.isSessionRunning(user.username);
    const jupyterUrl = isRunning && user.token ? buildJupyterUrl(hostIp, user.port!, user.token) : "";
    const codeServerUrl = isRunning && user.token ? buildCodeServerUrl(hostIp, user.port! + config.CODE_SERVER_PORT_OFFSET) : "";

    return new Response(render("dashboard.html", {
      user, is_running: isRunning, user_port: user.port,
      jupyter_url: jupyterUrl, code_server_url: codeServerUrl,
      error: query.error ?? null, success: query.success ?? null,
      ...buildGpuCtx(user)
    }), { headers: { "Content-Type": "text/html" } });
  })

  // --- Change Password ---
  .get("/change-password", ({ cookie, redirect, query }) => {
    const user = getCurrentUser(cookie);
    if (!user) return redirect("/", 302);
    return new Response(render("change_password.html", {
      user, error: query.error ?? null, success: query.success ?? null
    }), { headers: { "Content-Type": "text/html" } });
  })

  .post("/change-password", async ({ cookie, body, redirect }) => {
    const user = getCurrentUser(cookie);
    if (!user) return redirect("/", 302);
    const { password, confirm_password } = body as { password?: string; confirm_password?: string };
    if (!password || !confirm_password) {
      return redirect("/change-password?error=Missing+fields", 303);
    }
    if (password !== confirm_password) {
      return redirect("/change-password?error=Passwords+do+not+match", 303);
    }
    if (password.length < 8) {
      return redirect("/change-password?error=Password+must+be+at+least+8+characters", 303);
    }
    await db.changePassword(user.username, password, false);
    return redirect("/dashboard?success=Password+changed+successfully", 303);
  })

  // --- User Session Controls ---
  .post("/session/start", async ({ cookie, request, redirect, headers }) => {
    const user = getCurrentUser(cookie);
    if (!user) return redirect("/", 302);
    if (user.role === "admin") return redirect("/admin", 302);
    if (user.must_change_password) {
      if (headers["hx-request"] === "true") {
        return new Response("", { headers: { "HX-Redirect": "/change-password" } });
      }
      return redirect("/change-password", 302);
    }

    const username = user.username;
    const port = user.port!;
    const hostIp = resolveHostIp(request);
    const token = crypto.randomBytes(16).toString("base64url");
    const isHtmx = headers["hx-request"] === "true";

    const success = await spawner.spawnSession(username, port, token);
    if (!success) {
      if (isHtmx) {
        const isRunning = await spawner.isSessionRunning(username);
        const jurl = isRunning && user.token ? buildJupyterUrl(hostIp, port, user.token) : "";
        const csurl = isRunning && user.token ? buildCodeServerUrl(hostIp, port + config.CODE_SERVER_PORT_OFFSET) : "";
        return new Response(render("partials/_dashboard_status.html", {
          is_running: isRunning, user_port: port, jupyter_url: jurl,
          code_server_url: csurl, user,
          ...buildGpuCtx(user)
        }), { headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({ showToast: { message: "Failed to start JupyterLab session", type: "error" } })
        }});
      }
      return redirect("/dashboard?error=Failed+to+start+JupyterLab+session", 303);
    }

    db.updateToken(username, token);
    user.token = token;
    if (isHtmx) {
      return new Response(render("partials/_dashboard_status.html", {
        is_running: true, user_port: port,
        jupyter_url: buildJupyterUrl(hostIp, port, token),
        code_server_url: buildCodeServerUrl(hostIp, port + config.CODE_SERVER_PORT_OFFSET),
        user, ...buildGpuCtx(user)
      }), { headers: {
        "Content-Type": "text/html",
        "HX-Trigger": JSON.stringify({ showToast: { message: "JupyterLab started", type: "success" } })
      }});
    }
    return redirect("/dashboard?success=JupyterLab+started", 303);
  })

  .post("/session/stop", async ({ cookie, request, redirect, headers }) => {
    const user = getCurrentUser(cookie);
    if (!user) return redirect("/", 302);
    if (user.role === "admin") return redirect("/admin", 302);
    if (user.must_change_password) {
      if (headers["hx-request"] === "true") {
        return new Response("", { headers: { "HX-Redirect": "/change-password" } });
      }
      return redirect("/change-password", 302);
    }

    const username = user.username;
    const port = user.port!;
    const hostIp = resolveHostIp(request);
    const isHtmx = headers["hx-request"] === "true";

    const success = await spawner.stopSession(username);
    if (!success) {
      if (isHtmx) {
        const isRunning = await spawner.isSessionRunning(username);
        const jurl = isRunning && user.token ? buildJupyterUrl(hostIp, port, user.token) : "";
        const csurl = isRunning && user.token ? buildCodeServerUrl(hostIp, port + config.CODE_SERVER_PORT_OFFSET) : "";
        return new Response(render("partials/_dashboard_status.html", {
          is_running: isRunning, user_port: port, jupyter_url: jurl,
          code_server_url: csurl, user,
          ...buildGpuCtx(user)
        }), { headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({ showToast: { message: "Failed to stop JupyterLab session", type: "error" } })
        }});
      }
      return redirect("/dashboard?error=Failed+to+stop+JupyterLab+session", 303);
    }

    db.updateToken(username, null);
    if (isHtmx) {
      return new Response(render("partials/_dashboard_status.html", {
        is_running: false, user_port: port, jupyter_url: "", code_server_url: "",
        user, ...buildGpuCtx(user)
      }), { headers: {
        "Content-Type": "text/html",
        "HX-Trigger": JSON.stringify({ showToast: { message: "JupyterLab stopped", type: "success" } })
      }});
    }
    return redirect("/dashboard?success=JupyterLab+stopped", 303);
  })

  .post("/session/restart", async ({ cookie, request, redirect, headers }) => {
    const user = getCurrentUser(cookie);
    if (!user) return redirect("/", 302);
    if (user.role === "admin") return redirect("/admin", 302);
    if (user.must_change_password) {
      if (headers["hx-request"] === "true") {
        return new Response("", { headers: { "HX-Redirect": "/change-password" } });
      }
      return redirect("/change-password", 302);
    }

    const username = user.username;
    const port = user.port!;
    const hostIp = resolveHostIp(request);
    const token = crypto.randomBytes(16).toString("base64url");
    const isHtmx = headers["hx-request"] === "true";

    // spawnSession stops any existing session internally — no need for explicit stopSession here
    const success = await spawner.spawnSession(username, port, token);
    if (!success) {
      db.updateToken(username, null);
      if (isHtmx) {
        return new Response(render("partials/_dashboard_status.html", {
          is_running: false, user_port: port, jupyter_url: "", code_server_url: "",
          user, ...buildGpuCtx(user)
        }), { headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({ showToast: { message: "Failed to restart JupyterLab session", type: "error" } })
        }});
      }
      return redirect("/dashboard?error=Failed+to+restart+JupyterLab+session", 303);
    }

    db.updateToken(username, token);
    user.token = token;
    if (isHtmx) {
      return new Response(render("partials/_dashboard_status.html", {
        is_running: true, user_port: port,
        jupyter_url: buildJupyterUrl(hostIp, port, token),
        code_server_url: buildCodeServerUrl(hostIp, port + config.CODE_SERVER_PORT_OFFSET),
        user, ...buildGpuCtx(user)
      }), { headers: {
        "Content-Type": "text/html",
        "HX-Trigger": JSON.stringify({ showToast: { message: "JupyterLab restarted", type: "success" } })
      }});
    }
    return redirect("/dashboard?success=JupyterLab+restarted", 303);
  })

  .get("/session/status", async ({ cookie, request, redirect, headers }) => {
    const user = getCurrentUser(cookie);
    if (!user) return redirect("/", 302);
    if (user.must_change_password) {
      if (headers["hx-request"] === "true") {
        return new Response("", { headers: { "HX-Redirect": "/change-password" } });
      }
      return redirect("/change-password", 302);
    }
    const hostIp = resolveHostIp(request);
    const isRunning = await spawner.isSessionRunning(user.username);
    const jupyterUrl = isRunning && user.token ? buildJupyterUrl(hostIp, user.port!, user.token) : "";
    const codeServerUrl = isRunning && user.token ? buildCodeServerUrl(hostIp, user.port! + config.CODE_SERVER_PORT_OFFSET) : "";
    return new Response(render("partials/_dashboard_status.html", {
      is_running: isRunning, user_port: user.port,
      jupyter_url: jupyterUrl, code_server_url: codeServerUrl, user,
      ...buildGpuCtx(user)
    }), { headers: { "Content-Type": "text/html" } });
  })

  // --- Admin Views & Controls ---
  .get("/admin", async ({ cookie, query, request, redirect }) => {
    const user = getCurrentUser(cookie);
    if (!user || user.role !== "admin") return redirect("/", 302);
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

    return new Response(render("admin.html", {
      user, users: enriched, error: query.error ?? null, success: query.success ?? null, gpu_config: gpuConfig, logs
    }), { headers: { "Content-Type": "text/html" } });
  })

  .post("/admin/users", async ({ body, cookie, request, redirect, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return redirect("/", 302);
    const { username, password } = body as { username?: string; password?: string };
    const isHtmx = headers["hx-request"] === "true";

    const userTrim = (username ?? "").trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(userTrim)) {
      if (isHtmx) return new Response("", { status: 422, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "Username must be alphanumeric", type: "error" } })
      }});
      return redirect("/admin?error=Username+must+be+alphanumeric", 303);
    }

    const port = spawner.getNextPort();
    if (!port) {
      if (isHtmx) return new Response("", { status: 422, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "No available ports left (limit 9)", type: "error" } })
      }});
      return redirect("/admin?error=No+available+ports+left+(limit+9)", 303);
    }

    const created = await db.createUser(userTrim, password ?? "", "user", port);
    if (!created) {
      if (isHtmx) return new Response("", { status: 422, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "Username already exists", type: "error" } })
      }});
      return redirect("/admin?error=Username+already+exists", 303);
    }

    const envOk = await spawner.setupUserEnv(userTrim);
    if (!envOk) {
      db.deleteUser(userTrim);
      if (isHtmx) return new Response("", { status: 422, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "Failed to initialize venv for user", type: "error" } })
      }});
      return redirect("/admin?error=Failed+to+initialize+venv+for+user", 303);
    }

    if (isHtmx) {
      const enriched = await getEnrichedUsers(request);
      return new Response(render("partials/_admin_user_table_body.html", { users: enriched }), {
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({ showToast: { message: `Created user ${userTrim}`, type: "success" }, userListUpdated: null })
        }
      });
    }
    return redirect(`/admin?success=Created+user+${userTrim}`, 303);
  })

  .post("/admin/users/:username", async ({ params, body, cookie, redirect, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return redirect("/", 302);
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return new Response("Invalid username", { status: 400 });
    }

    // 1. Stop session
    await spawner.stopSession(username);

    // 2. Optionally delete files
    const deleteFiles = (body as any)?.delete_files === "true";
    let msg = "";
    if (deleteFiles) {
      spawner.cleanupUserFiles(username);
      msg = `Deleted user ${username} and all files`;
    } else {
      msg = `Deleted user ${username} (files preserved)`;
    }

    // 3. Delete from DB
    db.deleteUser(username);

    const isHtmx = headers["hx-request"] === "true";
    if (isHtmx) {
      return new Response("", {
        headers: {
          "HX-Trigger": JSON.stringify({ showToast: { message: msg, type: "success" }, userListUpdated: null })
        }
      });
    }

    return redirect(`/admin?success=${encodeURIComponent(msg)}`, 303);
  })

  .post("/admin/users/:username/reset-password", async ({ params, cookie, headers, redirect }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return redirect("/", 302);
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return new Response("Invalid username", { status: 400 });
    }
    const user = db.getUserByUsername(username);
    if (!user) {
      if (headers["hx-request"] === "true") {
        return new Response("", { status: 404, headers: {
          "HX-Trigger": JSON.stringify({ showToast: { message: "User not found", type: "error" } })
        }});
      }
      return redirect("/admin?error=User+not+found", 303);
    }

    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let tempPass = "temp-";
    for (let i = 0; i < 8; i++) {
      tempPass += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    await db.changePassword(username, tempPass, true);

    const isHtmx = headers["hx-request"] === "true";
    if (isHtmx) {
      return new Response("", {
        headers: {
          "HX-Trigger": JSON.stringify({
            showToast: { message: `Password reset for ${username}`, type: "success" },
            "password-reset": { username, tempPass }
          })
        }
      });
    }
    return redirect(`/admin?success=Password+reset+for+${username}.+New+temp+password:+${tempPass}`, 303);
  })

  .post("/admin/session/start/:username", async ({ params, cookie, request, redirect, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return redirect("/", 302);
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return new Response("Invalid username", { status: 400 });
    }
    const user = db.getUserByUsername(username);
    const isHtmx = headers["hx-request"] === "true";

    if (!user) {
      if (isHtmx) return new Response("", { status: 404, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "User not found", type: "error" } })
      }});
      return redirect("/admin?error=User+not+found", 303);
    }

    const port = user.port!;
    const token = crypto.randomBytes(16).toString("base64url");
    const success = await spawner.spawnSession(username, port, token);
    if (!success) {
      if (isHtmx) return new Response("", { status: 500, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: `Failed to start session for ${username}`, type: "error" } })
      }});
      return redirect(`/admin?error=Failed+to+start+session+for+${username}`, 303);
    }

    db.updateToken(username, token);

    if (isHtmx) {
      const enriched = await enrichUser(username, request);
      return new Response(render("partials/_admin_user_row.html", { u: enriched }), {
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({ showToast: { message: `JupyterLab started for ${username}`, type: "success" } })
        }
      });
    }
    return redirect(`/admin?success=JupyterLab+started+for+${username}`, 303);
  })

  .post("/admin/session/stop/:username", async ({ params, cookie, request, redirect, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return redirect("/", 302);
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return new Response("Invalid username", { status: 400 });
    }
    const user = db.getUserByUsername(username);
    const isHtmx = headers["hx-request"] === "true";

    if (!user) {
      if (isHtmx) return new Response("", { status: 404, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "User not found", type: "error" } })
      }});
      return redirect("/admin?error=User+not+found", 303);
    }

    const success = await spawner.stopSession(username);
    if (!success) {
      if (isHtmx) return new Response("", { status: 500, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: `Failed to stop session for ${username}`, type: "error" } })
      }});
      return redirect(`/admin?error=Failed+to+stop+session+for+${username}`, 303);
    }

    db.updateToken(username, null);

    if (isHtmx) {
      const enriched = await enrichUser(username, request);
      return new Response(render("partials/_admin_user_row.html", { u: enriched }), {
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({ showToast: { message: `JupyterLab stopped for ${username}`, type: "success" } })
        }
      });
    }
    return redirect(`/admin?success=JupyterLab+stopped+for+${username}`, 303);
  })

  .post("/admin/session/restart/:username", async ({ params, cookie, request, redirect, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return redirect("/", 302);
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return new Response("Invalid username", { status: 400 });
    }
    const user = db.getUserByUsername(username);
    const isHtmx = headers["hx-request"] === "true";

    if (!user) {
      if (isHtmx) return new Response("", { status: 404, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "User not found", type: "error" } })
      }});
      return redirect("/admin?error=User+not+found", 303);
    }

    const port = user.port!;
    const token = crypto.randomBytes(16).toString("base64url");

    // spawnSession stops any existing session internally — no need for explicit stopSession here
    const success = await spawner.spawnSession(username, port, token);
    if (!success) {
      db.updateToken(username, null);
      if (isHtmx) return new Response("", { status: 500, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: `Failed to restart session for ${username}`, type: "error" } })
      }});
      return redirect(`/admin?error=Failed+to+restart+session+for+${username}`, 303);
    }

    db.updateToken(username, token);

    if (isHtmx) {
      const enriched = await enrichUser(username, request);
      return new Response(render("partials/_admin_user_row.html", { u: enriched }), {
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({ showToast: { message: `JupyterLab restarted for ${username}`, type: "success" } })
        }
      });
    }
    return redirect(`/admin?success=JupyterLab+restarted+for+${username}`, 303);
  })

  .get("/admin/users/row/:username", async ({ params, cookie, request }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return new Response("Forbidden", { status: 403 });
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return new Response("Invalid username", { status: 400 });
    }
    const enriched = await enrichUser(username, request);
    if (!enriched) return new Response("User not found", { status: 404 });
    return new Response(render("partials/_admin_user_row.html", { u: enriched }), {
      headers: { "Content-Type": "text/html" }
    });
  })

  .get("/admin/users/status-poll", async ({ cookie, request }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return new Response("Forbidden", { status: 403 });
    const enriched = await getEnrichedUsers(request);
    return new Response(render("partials/_admin_user_table_body.html", { users: enriched, is_poll: true }), {
      headers: { "Content-Type": "text/html" }
    });
  })

  .get("/admin/partials/gpu-select", async ({ cookie }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return new Response("Forbidden", { status: 403 });
    const users = db.listUsers();
    return new Response(render("partials/_admin_gpu_select.html", { users }), {
      headers: { "Content-Type": "text/html" }
    });
  })

  .post("/admin/gpu/assign/:username", async ({ params, body, cookie, request, redirect, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return redirect("/", 302);
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return new Response("Invalid username", { status: 400 });
    }
    const user = db.getUserByUsername(username);
    if (!user) return new Response("User not found", { status: 404 });

    const { gpu_ssh_host, gpu_ssh_port, gpu_endpoint, gpu_streamlit_endpoint, gpu_code_server_endpoint, gpu_token } = body as Record<string, any>;
    const host = (gpu_ssh_host ?? "").trim();
    const port = gpu_ssh_port ? parseInt(gpu_ssh_port, 10) : 22;
    const endpoint = (gpu_endpoint ?? "").trim();
    const streamlitEndpoint = (gpu_streamlit_endpoint ?? "").trim();
    const codeServerEndpoint = (gpu_code_server_endpoint ?? "").trim();
    const tokenToSave = (gpu_token ?? "").trim() || user.gpu_token || "";

    const isHtmx = headers["hx-request"] === "true";

    if (endpoint !== "" && !gpu.isValidGpuEndpoint(endpoint)) {
      if (isHtmx) {
        const enriched = await enrichUser(username, request);
        return new Response(render("partials/_admin_user_row.html", { u: enriched }), {
          headers: {
            "Content-Type": "text/html",
            "HX-Trigger": JSON.stringify({
              showToast: { message: "Invalid GPU endpoint URL format or contains dangerous characters", type: "error" }
            })
          }
        });
      }
      return redirect(`/admin?error=Invalid+GPU+endpoint`, 303);
    }

    if (host) {
      try {
        validateSshHost(host);
      } catch (e: any) {
        if (isHtmx) {
          const enriched = await enrichUser(username, request);
          return new Response(render("partials/_admin_user_row.html", { u: enriched }), {
            headers: {
              "Content-Type": "text/html",
              "HX-Trigger": JSON.stringify({
                showToast: { message: `Invalid SSH host: ${e.message}`, type: "error" }
              })
            }
          });
        }
        return redirect(`/admin?error=Invalid+SSH+host`, 303);
      }
    }

    // Validate optional streamlit/code-server endpoints
    for (const [label, ep] of [["Streamlit", streamlitEndpoint], ["Code Server", codeServerEndpoint]] as [string, string][]) {
      if (ep !== "" && !gpu.isValidGpuEndpoint(ep)) {
        if (isHtmx) {
          const enriched = await enrichUser(username, request);
          return new Response(render("partials/_admin_user_row.html", { u: enriched }), {
            headers: {
              "Content-Type": "text/html",
              "HX-Trigger": JSON.stringify({
                showToast: { message: `Invalid ${label} endpoint URL`, type: "error" }
              })
            }
          });
        }
        return redirect(`/admin?error=Invalid+${label}+endpoint`, 303);
      }
    }

    db.assignGpu(username, endpoint, tokenToSave, host, port, streamlitEndpoint, codeServerEndpoint);

    if (isHtmx) {
      const enriched = await enrichUser(username, request);
      return new Response(render("partials/_admin_user_row.html", { u: enriched }), {
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({
            showToast: { message: `GPU assigned to ${username}`, type: "success" },
            userListUpdated: null
          })
        }
      });
    }
    return redirect(`/admin?success=GPU+assigned+to+${username}`, 303);
  })

  .post("/admin/gpu/unassign/:username", async ({ params, cookie, request, redirect, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return redirect("/", 302);
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return new Response("Invalid username", { status: 400 });
    }

    db.unassignGpu(username);

    const isHtmx = headers["hx-request"] === "true";
    if (isHtmx) {
      const enriched = await enrichUser(username, request);
      return new Response(render("partials/_admin_user_row.html", { u: enriched }), {
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({
            showToast: { message: `GPU configuration removed for ${username}`, type: "success" },
            userListUpdated: null
          })
        }
      });
    }
    return redirect(`/admin?success=GPU+configuration+removed+for+${username}`, 303);
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
      db.assignGpu(username, user.gpu_endpoint ?? "", token, sshHost, sshPort,
        user.gpu_streamlit_endpoint ?? "", user.gpu_code_server_endpoint ?? "");
    }

    const stringStream = gpu.gpuInitStream(
      username,
      sshHost,
      sshPort,
      gpuConf.ssh_key_path,
      gpuConf.ssh_user,
      token,
      user.gpu_endpoint ?? "",
      gpuConf.remote_base_dir
    );

    return new Response(toUint8ArrayStream(stringStream), { headers: sseHeaders });
  })

  .post("/admin/gpu/stop/:username", async ({ params, cookie, request, redirect, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return redirect("/", 302);
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return new Response("Invalid username", { status: 400 });
    }

    const [success, msg] = await gpu.stopGpuSession(username);

    const isHtmx = headers["hx-request"] === "true";
    if (isHtmx) {
      const enriched = await enrichUser(username, request);
      const toastType = success ? "success" : "error";
      const toastMsg = success ? `GPU session stopped for ${username}` : msg;
      return new Response(render("partials/_admin_user_row.html", { u: enriched }), {
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({
            showToast: { message: toastMsg, type: toastType }
          })
        }
      });
    }
    if (success) {
      return redirect(`/admin?success=GPU+session+stopped+for+${username}`, 303);
    } else {
      return redirect(`/admin?error=${encodeURIComponent(msg)}`, 303);
    }
  })

  .post("/admin/gpu/reset/:username", async ({ params, cookie, request, redirect, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return redirect("/", 302);
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return new Response("Invalid username", { status: 400 });
    }

    db.updateGpuInitStatus(username, null);

    const isHtmx = headers["hx-request"] === "true";
    if (isHtmx) {
      const enriched = await enrichUser(username, request);
      return new Response(render("partials/_admin_user_row.html", { u: enriched }), {
        headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({
            showToast: { message: `GPU status reset for ${username}`, type: "success" },
            userListUpdated: null
          })
        }
      });
    }
    return redirect(`/admin?success=GPU+status+reset+for+${username}`, 303);
  })

  .get("/admin/gpu/config", ({ cookie }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return new Response("Forbidden", { status: 403 });
    return Response.json(db.getGpuConfig());
  })

  .post("/admin/gpu/config", async ({ body, cookie, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return new Response("Forbidden", { status: 403 });

    const { ssh_host, ssh_port, ssh_user, ssh_key_path, remote_base_dir } = body as Record<string, any>;
    const host = (ssh_host ?? "").trim();
    const port = ssh_port ? parseInt(ssh_port, 10) : 22;
    const user = (ssh_user ?? "root").trim();
    const keyPath = (ssh_key_path ?? "").trim();
    const rBaseDir = (remote_base_dir ?? "/workspace").trim();

    const isHtmx = headers["hx-request"] === "true";

    // Validate SSH key path exists
    if (!keyPath || !existsSync(keyPath)) {
      if (isHtmx) {
        return new Response("", {
          status: 422,
          headers: {
            "HX-Trigger": JSON.stringify({
              showToast: { message: `SSH Key file not found on disk: ${keyPath}`, type: "error" }
            })
          }
        });
      }
      return new Response(`SSH Key file not found: ${keyPath}`, { status: 400 });
    }

    // Validate shell-safe values before storing
    try {
      if (host) validateSshHost(host);
      validateSshUser(user);
      validateRemoteBaseDir(rBaseDir);
    } catch (e: any) {
      if (isHtmx) {
        return new Response("", {
          status: 422,
          headers: {
            "HX-Trigger": JSON.stringify({
              showToast: { message: `Invalid config value: ${e.message}`, type: "error" }
            })
          }
        });
      }
      return new Response(`Invalid config value: ${e.message}`, { status: 400 });
    }

    db.saveGpuConfig(host, port, user, keyPath, rBaseDir);

    if (isHtmx) {
      return new Response("", {
        headers: {
          "HX-Trigger": JSON.stringify({
            showToast: { message: "Global GPU configuration saved successfully", type: "success" }
          })
        }
      });
    }
    return new Response("Config saved");
  })

  .get("/admin/gpu/last-log/:username", ({ params, cookie }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return new Response("Forbidden", { status: 403 });
    const username = params.username;
    try { spawner.validateUsername(username); } catch (_) {
      return new Response("Invalid username", { status: 400 });
    }
    const logContent = gpu.getLastGpuLog(username);
    return new Response(logContent, { headers: { "Content-Type": "text/plain" } });
  })

  .get("/admin/logs", ({ cookie, redirect }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return redirect("/", 302);
    return redirect("/admin?tab=logs", 302);
  })

  .get("/admin/logs/view", ({ query, cookie }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return new Response("Forbidden", { status: 403 });

    const filename = query.filename;
    if (!filename || filename.includes("..") || filename.startsWith("/") || filename.startsWith("\\")) {
      return new Response("Invalid filename", { status: 400 });
    }

    const gpuLogsDir = join(config.BASE_DIR, ".gpu_logs");
    const rsyncLogsDir = join(config.BASE_DIR, ".rsync_logs");

    let filePath = join(gpuLogsDir, filename);
    if (!existsSync(filePath)) {
      filePath = join(rsyncLogsDir, filename);
    }

    if (!existsSync(filePath)) {
      return new Response("Log file not found", { status: 404 });
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      return { filename, content };
    } catch (err: any) {
      return new Response(`Error reading log file: ${err.message}`, { status: 500 });
    }
  })

  // --- User GPU Sync & Tree API ---
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

  .listen(config.HUB_PORT);

console.log(`HubJupyLab running on http://0.0.0.0:${config.HUB_PORT}`);
