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
    enriched.push({ ...u, is_running: isRunning, jupyter_url: jupyterUrl });
  }
  return enriched;
}

async function enrichUser(username: string, request: Request): Promise<Record<string, any> | null> {
  const user = db.getUserByUsername(username);
  if (!user) return null;
  const hostIp = resolveHostIp(request);
  const isRunning = await spawner.isSessionRunning(username);
  const jupyterUrl = isRunning && user.token ? buildJupyterUrl(hostIp, user.port!, user.token) : "";
  return { ...user, is_running: isRunning, jupyter_url: jupyterUrl };
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
  .get("/", ({ cookie, query, set }) => {
    const user = getCurrentUser(cookie);
    if (user) {
      set.redirect = user.role === "admin" ? "/admin" : "/dashboard";
      return;
    }
    return new Response(render("login.html", {
      user: null, error: query.error ?? null, success: query.success ?? null
    }), { headers: { "Content-Type": "text/html" } });
  })

  .post("/login", async ({ body, cookie, set }) => {
    const { username, password } = body as { username?: string; password?: string };
    if (!username || !password) {
      set.redirect = "/?error=Missing+credentials";
      set.status = 303;
      return;
    }
    const user = db.getUserByUsername(username);
    if (!user || !(await db.verifyPassword(password, user.password_hash))) {
      set.redirect = "/?error=Invalid+credentials";
      set.status = 303;
      return;
    }
    const signed = signCookie(username);
    set.redirect = user.role === "admin" ? "/admin" : "/dashboard";
    set.status = 303;
    set.headers["Set-Cookie"] = `hub_session=${signed}; HttpOnly; SameSite=Lax; Path=/`;
  })

  .get("/logout", ({ set }) => {
    set.redirect = "/";
    set.status = 302;
    set.headers["Set-Cookie"] = "hub_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
  })

  // --- User Dashboard ---
  .get("/dashboard", async ({ cookie, query, request, set }) => {
    const user = getCurrentUser(cookie);
    if (!user) { set.redirect = "/"; set.status = 302; return; }
    if (user.role === "admin") { set.redirect = "/admin"; set.status = 302; return; }

    const hostIp = resolveHostIp(request);
    const isRunning = await spawner.isSessionRunning(user.username);
    const jupyterUrl = isRunning && user.token ? buildJupyterUrl(hostIp, user.port!, user.token) : "";
    const hasGpu = !!user.gpu_endpoint;

    return new Response(render("dashboard.html", {
      user, is_running: isRunning, user_port: user.port,
      jupyter_url: jupyterUrl, error: query.error ?? null,
      success: query.success ?? null, has_gpu: hasGpu,
      gpu_endpoint: user.gpu_endpoint ?? "",
      gpu_init_status: user.gpu_init_status ?? "",
      gpu_token: user.gpu_token ?? ""
    }), { headers: { "Content-Type": "text/html" } });
  })

  // --- User Session Controls ---
  .post("/session/start", async ({ cookie, request, set, headers }) => {
    const user = getCurrentUser(cookie);
    if (!user) { set.redirect = "/"; set.status = 302; return; }
    if (user.role === "admin") { set.redirect = "/admin"; set.status = 302; return; }

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
        return new Response(render("partials/_dashboard_status.html", {
          is_running: isRunning, user_port: port, jupyter_url: jurl,
          has_gpu: !!user.gpu_endpoint,
          gpu_endpoint: user.gpu_endpoint ?? "",
          gpu_init_status: user.gpu_init_status ?? "",
          gpu_token: user.gpu_token ?? "",
          user: user
        }), { headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({ showToast: { message: "Failed to start JupyterLab session", type: "error" } })
        }});
      }
      set.redirect = "/dashboard?error=Failed+to+start+JupyterLab+session";
      set.status = 303; return;
    }

    db.updateToken(username, token);
    if (isHtmx) {
      return new Response(render("partials/_dashboard_status.html", {
        is_running: true, user_port: port, jupyter_url: buildJupyterUrl(hostIp, port, token),
        has_gpu: !!user.gpu_endpoint,
        gpu_endpoint: user.gpu_endpoint ?? "",
        gpu_init_status: user.gpu_init_status ?? "",
        gpu_token: user.gpu_token ?? "",
        user: user
      }), { headers: {
        "Content-Type": "text/html",
        "HX-Trigger": JSON.stringify({ showToast: { message: "JupyterLab started", type: "success" } })
      }});
    }
    set.redirect = "/dashboard?success=JupyterLab+started"; set.status = 303;
  })

  .post("/session/stop", async ({ cookie, request, set, headers }) => {
    const user = getCurrentUser(cookie);
    if (!user) { set.redirect = "/"; set.status = 302; return; }
    if (user.role === "admin") { set.redirect = "/admin"; set.status = 302; return; }

    const username = user.username;
    const port = user.port!;
    const hostIp = resolveHostIp(request);
    const isHtmx = headers["hx-request"] === "true";

    const success = await spawner.stopSession(username);
    if (!success) {
      if (isHtmx) {
        const isRunning = await spawner.isSessionRunning(username);
        const jurl = isRunning && user.token ? buildJupyterUrl(hostIp, port, user.token) : "";
        return new Response(render("partials/_dashboard_status.html", {
          is_running: isRunning, user_port: port, jupyter_url: jurl,
          has_gpu: !!user.gpu_endpoint,
          gpu_endpoint: user.gpu_endpoint ?? "",
          gpu_init_status: user.gpu_init_status ?? "",
          gpu_token: user.gpu_token ?? "",
          user: user
        }), { headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({ showToast: { message: "Failed to stop JupyterLab session", type: "error" } })
        }});
      }
      set.redirect = "/dashboard?error=Failed+to+stop+JupyterLab+session";
      set.status = 303; return;
    }

    db.updateToken(username, null);
    if (isHtmx) {
      return new Response(render("partials/_dashboard_status.html", {
        is_running: false, user_port: port, jupyter_url: "",
        has_gpu: !!user.gpu_endpoint,
        gpu_endpoint: user.gpu_endpoint ?? "",
        gpu_init_status: user.gpu_init_status ?? "",
        gpu_token: user.gpu_token ?? "",
        user: user
      }), { headers: {
        "Content-Type": "text/html",
        "HX-Trigger": JSON.stringify({ showToast: { message: "JupyterLab stopped", type: "success" } })
      }});
    }
    set.redirect = "/dashboard?success=JupyterLab+stopped"; set.status = 303;
  })

  .post("/session/restart", async ({ cookie, request, set, headers }) => {
    const user = getCurrentUser(cookie);
    if (!user) { set.redirect = "/"; set.status = 302; return; }
    if (user.role === "admin") { set.redirect = "/admin"; set.status = 302; return; }

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
          has_gpu: !!user.gpu_endpoint,
          gpu_endpoint: user.gpu_endpoint ?? "",
          gpu_init_status: user.gpu_init_status ?? "",
          gpu_token: user.gpu_token ?? "",
          user: user
        }), { headers: {
          "Content-Type": "text/html",
          "HX-Trigger": JSON.stringify({ showToast: { message: "Failed to restart JupyterLab session", type: "error" } })
        }});
      }
      set.redirect = "/dashboard?error=Failed+to+restart+JupyterLab+session";
      set.status = 303; return;
    }

    db.updateToken(username, token);
    if (isHtmx) {
      return new Response(render("partials/_dashboard_status.html", {
        is_running: true, user_port: port, jupyter_url: buildJupyterUrl(hostIp, port, token),
        has_gpu: !!user.gpu_endpoint,
        gpu_endpoint: user.gpu_endpoint ?? "",
        gpu_init_status: user.gpu_init_status ?? "",
        gpu_token: user.gpu_token ?? "",
        user: user
      }), { headers: {
        "Content-Type": "text/html",
        "HX-Trigger": JSON.stringify({ showToast: { message: "JupyterLab restarted", type: "success" } })
      }});
    }
    set.redirect = "/dashboard?success=JupyterLab+restarted"; set.status = 303;
  })

  .get("/session/status", async ({ cookie, request, set }) => {
    const user = getCurrentUser(cookie);
    if (!user) { set.redirect = "/"; set.status = 302; return; }
    const hostIp = resolveHostIp(request);
    const isRunning = await spawner.isSessionRunning(user.username);
    const jupyterUrl = isRunning && user.token ? buildJupyterUrl(hostIp, user.port!, user.token) : "";
    return new Response(render("partials/_dashboard_status.html", {
      is_running: isRunning, user_port: user.port,
      jupyter_url: jupyterUrl, has_gpu: !!user.gpu_endpoint,
      gpu_endpoint: user.gpu_endpoint ?? "",
      gpu_init_status: user.gpu_init_status ?? "",
      gpu_token: user.gpu_token ?? "", user
    }), { headers: { "Content-Type": "text/html" } });
  })

  // --- Admin Views & Controls ---
  .get("/admin", async ({ cookie, query, request, set }) => {
    const user = getCurrentUser(cookie);
    if (!user || user.role !== "admin") { set.redirect = "/"; set.status = 302; return; }
    const enriched = await getEnrichedUsers(request);
    return new Response(render("admin.html", {
      user, users: enriched, error: query.error ?? null, success: query.success ?? null
    }), { headers: { "Content-Type": "text/html" } });
  })

  .post("/admin/users", async ({ body, cookie, request, set, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") { set.redirect = "/"; set.status = 302; return; }
    const { username, password } = body as { username?: string; password?: string };
    const isHtmx = headers["hx-request"] === "true";

    const userTrim = (username ?? "").trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(userTrim)) {
      if (isHtmx) return new Response("", { status: 422, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "Username must be alphanumeric", type: "error" } })
      }});
      set.redirect = "/admin?error=Username+must+be+alphanumeric"; set.status = 303; return;
    }

    const port = spawner.getNextPort();
    if (!port) {
      if (isHtmx) return new Response("", { status: 422, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "No available ports left (limit 9)", type: "error" } })
      }});
      set.redirect = "/admin?error=No+available+ports+left+(limit+9)"; set.status = 303; return;
    }

    const created = await db.createUser(userTrim, password ?? "", "user", port);
    if (!created) {
      if (isHtmx) return new Response("", { status: 422, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "Username already exists", type: "error" } })
      }});
      set.redirect = "/admin?error=Username+already+exists"; set.status = 303; return;
    }

    const envOk = await spawner.setupUserEnv(userTrim);
    if (!envOk) {
      db.deleteUser(userTrim);
      if (isHtmx) return new Response("", { status: 422, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "Failed to initialize venv for user", type: "error" } })
      }});
      set.redirect = "/admin?error=Failed+to+initialize+venv+for+user"; set.status = 303; return;
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
    set.redirect = `/admin?success=Created+user+${userTrim}`; set.status = 303;
  })

  .post("/admin/users/:username", async ({ params, body, cookie, set, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") { set.redirect = "/"; set.status = 302; return; }
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

    set.redirect = `/admin?success=${encodeURIComponent(msg)}`;
    set.status = 303;
  })

  .post("/admin/session/start/:username", async ({ params, cookie, request, set, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") { set.redirect = "/"; set.status = 302; return; }
    const username = params.username;
    const user = db.getUserByUsername(username);
    const isHtmx = headers["hx-request"] === "true";

    if (!user) {
      if (isHtmx) return new Response("", { status: 404, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "User not found", type: "error" } })
      }});
      set.redirect = "/admin?error=User+not+found"; set.status = 303; return;
    }

    const port = user.port!;
    const token = crypto.randomBytes(16).toString("base64url");
    const success = await spawner.spawnSession(username, port, token);
    if (!success) {
      if (isHtmx) return new Response("", { status: 500, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: `Failed to start session for ${username}`, type: "error" } })
      }});
      set.redirect = `/admin?error=Failed+to+start+session+for+${username}`; set.status = 303; return;
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
    set.redirect = `/admin?success=JupyterLab+started+for+${username}`; set.status = 303;
  })

  .post("/admin/session/stop/:username", async ({ params, cookie, request, set, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") { set.redirect = "/"; set.status = 302; return; }
    const username = params.username;
    const user = db.getUserByUsername(username);
    const isHtmx = headers["hx-request"] === "true";

    if (!user) {
      if (isHtmx) return new Response("", { status: 404, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "User not found", type: "error" } })
      }});
      set.redirect = "/admin?error=User+not+found"; set.status = 303; return;
    }

    const success = await spawner.stopSession(username);
    if (!success) {
      if (isHtmx) return new Response("", { status: 500, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: `Failed to stop session for ${username}`, type: "error" } })
      }});
      set.redirect = `/admin?error=Failed+to+stop+session+for+${username}`; set.status = 303; return;
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
    set.redirect = `/admin?success=JupyterLab+stopped+for+${username}`; set.status = 303;
  })

  .post("/admin/session/restart/:username", async ({ params, cookie, request, set, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") { set.redirect = "/"; set.status = 302; return; }
    const username = params.username;
    const user = db.getUserByUsername(username);
    const isHtmx = headers["hx-request"] === "true";

    if (!user) {
      if (isHtmx) return new Response("", { status: 404, headers: {
        "HX-Trigger": JSON.stringify({ showToast: { message: "User not found", type: "error" } })
      }});
      set.redirect = "/admin?error=User+not+found"; set.status = 303; return;
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
      set.redirect = `/admin?error=Failed+to+restart+session+for+${username}`; set.status = 303; return;
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
    set.redirect = `/admin?success=JupyterLab+restarted+for+${username}`; set.status = 303;
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

  .post("/admin/gpu/assign/:username", async ({ params, body, cookie, request, set, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") { set.redirect = "/"; set.status = 302; return; }
    const username = params.username;
    const user = db.getUserByUsername(username);
    if (!user) return new Response("User not found", { status: 404 });

    const { gpu_ssh_host, gpu_ssh_port, gpu_endpoint, gpu_token } = body as Record<string, any>;
    const host = (gpu_ssh_host ?? "").trim();
    const port = gpu_ssh_port ? parseInt(gpu_ssh_port, 10) : 22;
    const endpoint = (gpu_endpoint ?? "").trim();
    const tokenToSave = (gpu_token ?? "").trim() || user.gpu_token || "";

    db.assignGpu(username, endpoint, tokenToSave, host, port);

    const isHtmx = headers["hx-request"] === "true";
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
    set.redirect = `/admin?success=GPU+assigned+to+${username}`; set.status = 303;
  })

  .post("/admin/gpu/unassign/:username", async ({ params, cookie, request, set, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") { set.redirect = "/"; set.status = 302; return; }
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
    set.redirect = `/admin?success=GPU+configuration+removed+for+${username}`; set.status = 303;
  })

  .get("/admin/gpu/init-stream/:username", async ({ params, cookie, set }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return new Response("Forbidden", { status: 403 });
    const username = params.username;
    const user = db.getUserByUsername(username);
    if (!user) return new Response("User not found", { status: 404 });

    set.headers["Content-Type"] = "text/event-stream";
    set.headers["Cache-Control"] = "no-cache";
    set.headers["Connection"] = "keep-alive";

    if (user.gpu_init_status === "running") {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: Error: Initialization already in progress\n\n"));
          controller.close();
        }
      });
      return new Response(stream);
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
      return new Response(stream);
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
      user.gpu_endpoint ?? ""
    );

    return new Response(toUint8ArrayStream(stringStream));
  })

  .post("/admin/gpu/stop/:username", async ({ params, cookie, request, set, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") { set.redirect = "/"; set.status = 302; return; }
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
      set.redirect = `/admin?success=GPU+session+stopped+for+${username}`;
    } else {
      set.redirect = `/admin?error=${encodeURIComponent(msg)}`;
    }
    set.status = 303;
  })

  .post("/admin/gpu/reset/:username", async ({ params, cookie, request, set, headers }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") { set.redirect = "/"; set.status = 302; return; }
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
    set.redirect = `/admin?success=GPU+status+reset+for+${username}`; set.status = 303;
  })

  .get("/admin/gpu/last-log/:username", ({ params, cookie }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") return new Response("Forbidden", { status: 403 });
    const username = params.username;
    const logContent = gpu.getLastGpuLog(username);
    return new Response(logContent, { headers: { "Content-Type": "text/plain" } });
  })

  .get("/admin/logs", ({ cookie, set }) => {
    const admin = getCurrentUser(cookie);
    if (!admin || admin.role !== "admin") { set.redirect = "/"; set.status = 302; return; }

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

    return new Response(render("logs.html", { user: admin, logs }), {
      headers: { "Content-Type": "text/html" }
    });
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
  .get("/session/gpu/sync-to-stream", ({ cookie, query, set }) => {
    const user = getCurrentUser(cookie);
    if (!user) { set.redirect = "/"; set.status = 302; return; }
    if (user.role === "admin") return new Response("Forbidden", { status: 403 });

    set.headers["Content-Type"] = "text/event-stream";
    set.headers["Cache-Control"] = "no-cache";
    set.headers["Connection"] = "keep-alive";

    const stringStream = gpu.rsyncToGpuStream(user.username, query.path ?? "");
    return new Response(toUint8ArrayStream(stringStream));
  })

  .get("/session/gpu/sync-from-stream", ({ cookie, query, set }) => {
    const user = getCurrentUser(cookie);
    if (!user) { set.redirect = "/"; set.status = 302; return; }
    if (user.role === "admin") return new Response("Forbidden", { status: 403 });

    set.headers["Content-Type"] = "text/event-stream";
    set.headers["Cache-Control"] = "no-cache";
    set.headers["Connection"] = "keep-alive";

    const stringStream = gpu.rsyncFromGpuStream(user.username, query.path ?? "");
    return new Response(toUint8ArrayStream(stringStream));
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
