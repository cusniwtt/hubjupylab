import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const ADMIN_USER = Bun.env.ADMIN_USER ?? "admin";
export const ADMIN_PASS = Bun.env.ADMIN_PASS ?? "admin";
export const SECRET_KEY = Bun.env.SECRET_KEY ?? "dev-secret-key-please-change-in-prod";
export const HUB_PORT = parseInt(Bun.env.HUB_PORT ?? "8080", 10);
export const HOST_IP = Bun.env.HOST_IP?.trim() ?? "";
export const BASE_DIR = Bun.env.BASE_DIR ?? "/home/hubjupylab";
export const JUPYTERLAB_VERSION = Bun.env.JUPYTERLAB_VERSION ?? "4.4.1";
export const PYTHON_VERSION = Bun.env.PYTHON_VERSION ?? "3.14";

export const JUPYTER_PORT_START = 8081;
export const JUPYTER_PORT_END = 8090;

export const SYNC_SIZE_THRESHOLD = parseInt(Bun.env.SYNC_SIZE_THRESHOLD ?? "1073741824", 10);
export const SYNC_FILE_THRESHOLD = parseInt(Bun.env.SYNC_FILE_THRESHOLD ?? "5000", 10);

// Ensure BASE_DIR exists
mkdirSync(BASE_DIR, { recursive: true });
