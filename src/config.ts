import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const ADMIN_USER = Bun.env.ADMIN_USER ?? "admin";
export const ADMIN_PASS = Bun.env.ADMIN_PASS ?? "admin";
export const SECRET_KEY = Bun.env.SECRET_KEY ?? "dev-secret-key-please-change-in-prod";
export const HUB_PORT = parseInt(Bun.env.HUB_PORT ?? "8080", 10);
export const HOST_IP = Bun.env.HOST_IP?.trim() ?? "";
export const SSH_PORT = parseInt(Bun.env.SSH_PORT ?? "22", 10);
export const BASE_DIR = Bun.env.BASE_DIR ?? "/home/hubjupylab";
export const JUPYTERLAB_VERSION = Bun.env.JUPYTERLAB_VERSION ?? "4.4.1";
export const PYTHON_VERSION = Bun.env.PYTHON_VERSION ?? "3.14";

export const JUPYTER_PORT_START = 8081;
export const JUPYTER_PORT_END = 8089;
export const CODE_SERVER_PORT_OFFSET = 100;

export const SYNC_SIZE_THRESHOLD = parseInt(Bun.env.SYNC_SIZE_THRESHOLD ?? "1073741824", 10);
export const SYNC_FILE_THRESHOLD = parseInt(Bun.env.SYNC_FILE_THRESHOLD ?? "5000", 10);

const DEFAULT_SECRET = "dev-secret-key-please-change-in-prod";
const DEFAULT_ADMIN_PASS = "admin";
const IS_PROD = Bun.env.NODE_ENV === "production";

if (IS_PROD) {
  const errors: string[] = [];
  if (SECRET_KEY === DEFAULT_SECRET) errors.push("SECRET_KEY is default — set a strong random value in .env");
  if (ADMIN_PASS === DEFAULT_ADMIN_PASS) errors.push("ADMIN_PASS is default 'admin' — set a strong password in .env");
  if (errors.length > 0) {
    console.error("\n[HubJupyLab] FATAL: Refusing to start in production with insecure defaults:");
    for (const e of errors) console.error(`  - ${e}`);
    console.error("Set NODE_ENV to something other than 'production' to run in dev mode.\n");
    process.exit(1);
  }
} else {
  if (SECRET_KEY === DEFAULT_SECRET) {
    console.warn("[HubJupyLab] WARNING: SECRET_KEY is default. Change it in .env before deploying to production.");
  }
  if (ADMIN_PASS === DEFAULT_ADMIN_PASS) {
    console.warn("[HubJupyLab] WARNING: ADMIN_PASS is default 'admin'. Change it in .env before deploying to production.");
  }
}

// Ensure BASE_DIR exists
mkdirSync(BASE_DIR, { recursive: true });
