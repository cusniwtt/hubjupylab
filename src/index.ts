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

// Configure Nunjucks
const njk = nunjucks.configure("templates", { autoescape: true });

function render(name: string, ctx: Record<string, any> = {}): string {
  return njk.render(name, ctx);
}

// Simple cookie signing using HMAC
function signCookie(value: string): string {
  const sig = crypto.createHmac("sha256", config.SECRET_KEY).update(value).digest("base64url");
  return `${value}.${sig}`;
}

function unsignCookie(signed: string): string | null {
  const idx = signed.lastIndexOf(".");
  if (idx < 0) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = crypto.createHmac("sha256", config.SECRET_KEY).update(value).digest("base64url");
  if (sig !== expected) return null;
  return value;
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

  .post("/login", async ({ body, set, redirect }) => {
    const { username, password } = body as { username?: string; password?: string };
    if (!username || !password) {
      return redirect("/?error=Missing+credentials", 303);
    }
    const user = db.getUserByUsername(username);
    if (!user || !(await db.verifyPassword(password, user.password_hash))) {
      return redirect("/?error=Invalid+credentials", 303);
    }
    const signed = signCookie(username);
    set.headers["Set-Cookie"] = `hub_session=${signed}; HttpOnly; SameSite=Lax; Path=/`;
    return redirect(user.role === "admin" ? "/admin" : "/dashboard", 303);
  })

  .get("/logout", ({ set, redirect }) => {
    set.headers["Set-Cookie"] = "hub_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
    return redirect("/", 302);
  })

  // --- User Dashboard ---
  .get("/dashboard", async ({ cookie, query, request, redirect }) => {
    const user = getCurrentUser(cookie);
    if (!user) return redirect("/", 302);
    if (user.role === "admin") return redirect("/admin", 302);

    const hostIp = resolveHostIp(request);
    const isRunning = await spawner.isSessionRunning(user.username);
    const jupyterUrl = isRunning && user.token ? buildJupyterUrl(hostIp, user.port!, user.token) : "";
    const codeServerUrl = isRunning && user.token ? buildCodeServerUrl(hostIp, user.port! + config.CODE_SERVER_PORT_OFFSET) : "";
    const gpuCodeServerUrl = user.gpu_endpoint ? user.gpu_endpoint.replace("-8888", "-8889").replace(":8888", ":8889") : "";
    const hasGpu = !!user.gpu_endpoint;

    return new Response(render("dashboard.html", {
      user, is_running: isRunning, user_port: user.port,
      jupyter_url: jupyterUrl, code_server_url: codeServerUrl, error: query.error ?? null,
      success: query.success ?? null, has_gpu: hasGpu,
      gpu_endpoint: user.gpu_endpoint ?? "",
      gpu_code_server_url: gpuCodeServerUrl,
      gpu_init_status: user.gpu_init_status ?? "",
      gpu_token: user.gpu_token ?? ""
    }), { headers: { "Content-Type": "text/html" } });
  })

  // --- User Session Controls ---
  .post("/session/start", async ({ cookie, request, redirect, headers }) => {
    const user = getCurrentUser(cookie);
    if (!user) return redirect("/", 302);
    if (user.role === "admin") return redirect("/admin", 302);

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
          code_server_url: csurl,
          has_gpu: !!user.gpu_endpoint,
          gpu_endpoint: user.gpu_endpoint ?? "",
          gpu_code_server_url: user.gpu_endpoint ? user.gpu_endpoint.replace("-8888", "-8889").replace(":8888", ":8889") : "",
          gpu_init_status: user.gpu_init_status ?? "",
          gpu_token: user.gpu_token ?? "",
          user: user
        }), { headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({ showToast: { message: "Failed to start JupyterLab session", type: "error" } })
        }});
      }
      return redirect("/dashboard?error=Failed+to+start+JupyterLab+session", 303);
    }

    db.updateToken(username, token);
    if (isHtmx) {
      return new Response(render("partials/_dashboard_status.html", {
        is_running: true, user_port: port, jupyter_url: buildJupyterUrl(hostIp, port, token),
        code_server_url: buildCodeServerUrl(hostIp, port + config.CODE_SERVER_PORT_OFFSET),
        has_gpu: !!user.gpu_endpoint,
        gpu_endpoint: user.gpu_endpoint ?? "",
        gpu_code_server_url: user.gpu_endpoint ? user.gpu_endpoint.replace("-8888", "-8889").replace(":8888", ":8889") : "",
        gpu_init_status: user.gpu_init_status ?? "",
        gpu_token: user.gpu_token ?? "",
        user: user
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
          code_server_url: csurl,
          has_gpu: !!user.gpu_endpoint,
          gpu_endpoint: user.gpu_endpoint ?? "",
          gpu_code_server_url: user.gpu_endpoint ? user.gpu_endpoint.replace("-8888", "-8889").replace(":8888", ":8889") : "",
          gpu_init_status: user.gpu_init_status ?? "",
          gpu_token: user.gpu_token ?? "",
          user: user
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
        is_running: false, user_port: port, jupyter_url: "",
        code_server_url: "",
        has_gpu: !!user.gpu_endpoint,
        gpu_endpoint: user.gpu_endpoint ?? "",
        gpu_code_server_url: user.gpu_endpoint ? user.gpu_endpoint.replace("-8888", "-8889").replace(":8888", ":8889") : "",
        gpu_init_status: user.gpu_init_status ?? "",
        gpu_token: user.gpu_token ?? "",
        user: user
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

    const username = user.username;
    const port = user.port!;
    const hostIp = resolveHostIp(request);
    const token = crypto.randomBytes(16).toString("base64url");
    const isHtmx = headers["hx-request"] === "true";

    await spawner.stopSession(username);
    const success = await spawner.spawnSession(username, port, token);
    if (!success) {
      db.updateToken(username, null);
      if (isHtmx) {
        return new Response(render("partials/_dashboard_status.html", {
          is_running: false, user_port: port, jupyter_url: "",
          code_server_url: "",
          has_gpu: !!user.gpu_endpoint,
          gpu_endpoint: user.gpu_endpoint ?? "",
          gpu_code_server_url: user.gpu_endpoint ? user.gpu_endpoint.replace("-8888", "-8889").replace(":8888", ":8889") : "",
          gpu_init_status: user.gpu_init_status ?? "",
          gpu_token: user.gpu_token ?? "",
          user: user
        }), { headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({ showToast: { message: "Failed to restart JupyterLab session", type: "error" } })
        }});
      }
      return redirect("/dashboard?error=Failed+to+restart+JupyterLab+session", 303);
    }

    db.updateToken(username, token);
    if (isHtmx) {
      return new Response(render("partials/_dashboard_status.html", {
        is_running: true, user_port: port, jupyter_url: buildJupyterUrl(hostIp, port, token),
        code_server_url: buildCodeServerUrl(hostIp, port + config.CODE_SERVER_PORT_OFFSET),
        has_gpu: !!user.gpu_endpoint,
        gpu_endpoint: user.gpu_endpoint ?? "",
        gpu_code_server_url: user.gpu_endpoint ? user.gpu_endpoint.replace("-8888", "-8889").replace(":8888", ":8889") : "",
        gpu_init_status: user.gpu_init_status ?? "",
        gpu_token: user.gpu_token ?? "",
        user: user
      }), { headers: {
        "Content-Type": "text/html",
        "HX-Trigger": JSON.stringify({ showToast: { message: "JupyterLab restarted", type: "success" } })
      }});
    }
    return redirect("/dashboard?success=JupyterLab+restarted", 303);
  })

  .get("/session/status", async ({ cookie, request, redirect }) => {
    const user = getCurrentUser(cookie);
    if (!user) return redirect("/", 302);
    const hostIp = resolveHostIp(request);
    const isRunning = await spawner.isSessionRunning(user.username);
    const jupyterUrl = isRunning && user.token ? buildJupyterUrl(hostIp, user.port!, user.token) : "";
    const codeServerUrl = isRunning && user.token ? buildCodeServerUrl(hostIp, user.port! + config.CODE_SERVER_PORT_OFFSET) : "";
    const gpuCodeServerUrl = user.gpu_endpoint ? user.gpu_endpoint.replace("-8888", "-8889").replace(":8888", ":8889") : "";
    return new Response(render("partials/_dashboard_status.html", {
      is_running: isRunning, user_port: user.port,
      jupyter_url: jupyterUrl, code_server_url: codeServerUrl, has_gpu: !!user.gpu_endpoint,
      gpu_endpoint: user.gpu_endpoint ?? "",
      gpu_code_server_url: gpuCodeServerUrl,
      gpu_init_status: user.gpu_init_status ?? "",
      gpu_token: user.gpu_token ?? "", user
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

  .post("/admin/session/start/:username", async ({ params, cookie, request, redirect, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return redirect("/", 302);
    const username = params.username;
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

    await spawner.stopSession(username);
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
    const user = db.getUserByUsername(username);
    if (!user) return new Response("User not found", { status: 404 });

    const { gpu_ssh_host, gpu_ssh_port, gpu_endpoint, gpu_token } = body as Record<string, any>;
    const host = (gpu_ssh_host ?? "").trim();
    const port = gpu_ssh_port ? parseInt(gpu_ssh_port, 10) : 22;
    const endpoint = (gpu_endpoint ?? "").trim();
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

    db.assignGpu(username, endpoint, tokenToSave, host, port);

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

  .get("/admin/gpu/init-stream/:username", async ({ params, cookie }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return new Response("Forbidden", { status: 403 });
    const username = params.username;
    const user = db.getUserByUsername(username);
    if (!user) return new Response("User not found", { status: 404 });

    const sseHeaders = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive"
    };

    if (user.gpu_init_status === "running") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: Error: Initialization already in progress\n\n"));
          controller.close();
        }
      });
      return new Response(stream, { headers: sseHeaders });
    }

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

    let token = user.gpu_token;
    if (!token) {
      token = crypto.randomBytes(16).toString("base64url");
      db.assignGpu(username, user.gpu_endpoint ?? "", token, sshHost, sshPort);
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
  .get("/session/gpu/sync-to-stream", ({ cookie, query, redirect }) => {
    const user = getCurrentUser(cookie);
    if (!user) return redirect("/", 302);
    if (user.role === "admin") return new Response("Forbidden", { status: 403 });

    const responseStream = toUint8ArrayStream(gpu.rsyncToGpuStream(user.username, query.path ?? ""));
    return new Response(responseStream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  })

  .get("/session/gpu/sync-from-stream", ({ cookie, query, redirect }) => {
    const user = getCurrentUser(cookie);
    if (!user) return redirect("/", 302);
    if (user.role === "admin") return new Response("Forbidden", { status: 403 });

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
