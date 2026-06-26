import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { BASE_DIR } from "./config";

const TEST_DB = join(BASE_DIR, "hubjupylab_gpu_test.db");
process.env.DB_PATH = TEST_DB;

if (existsSync(TEST_DB)) {
  try {
    unlinkSync(TEST_DB);
  } catch (_) {}
}

// Dynamically require to avoid ES import hoisting issues
const { initDb, createUser, deleteUser, assignGpu } = require("./db");
const { testGpuSsh, stopGpuSession, getLastGpuLog, rsyncToGpuStream, isValidGpuEndpoint, gpuInitStream,
  validateGpuUsername, validateSshUser, validateSshHost, validateRemoteBaseDir } = require("./gpu");

describe("GPU Module", () => {
  beforeAll(async () => {
    await initDb();
    await createUser("gputestuser", "pass123", "user", 8096);
  });

  afterAll(() => {
    deleteUser("gputestuser");
    if (existsSync(TEST_DB)) {
      try {
        unlinkSync(TEST_DB);
      } catch (_) {}
    }
  });

  test("testGpuSsh returns false if host is empty", async () => {
    const [ok, msg] = await testGpuSsh("", 22, "/dummy/key", "root");
    expect(ok).toBe(false);
    expect(msg).toContain("not configured");
  });

  test("stopGpuSession returns false if user has no GPU config", async () => {
    const [ok, msg] = await stopGpuSession("gputestuser");
    expect(ok).toBe(false);
    expect(msg).toContain("not configured");
  });

  test("stopGpuSession returns false if user does not exist", async () => {
    const [ok, msg] = await stopGpuSession("nonexistent_user");
    expect(ok).toBe(false);
    expect(msg).toContain("not found");
  });

  test("getLastGpuLog handles non-existent logs", () => {
    const log = getLastGpuLog("nonexistent_user");
    expect(log).toBe("No setup logs found for this user.");
  });

  test("getLastGpuLog retrieves the latest log file content", () => {
    const logDir = join(BASE_DIR, ".gpu_logs");
    mkdirSync(logDir, { recursive: true });
    
    const logPath1 = join(logDir, "logtestuser-20260622-000000-gpu.log");
    const logPath2 = join(logDir, "logtestuser-20260622-000001-gpu.log");
    
    writeFileSync(logPath1, "Log 1 content");
    writeFileSync(logPath2, "Log 2 content");

    const content = getLastGpuLog("logtestuser");
    expect(content).toBe("Log 2 content");

    // Clean up
    try {
      unlinkSync(logPath1);
      unlinkSync(logPath2);
    } catch (_) {}
  });

  test("rsync streams handle non-existent user", async () => {
    const stream = rsyncToGpuStream("nonexistent_user");
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(value).toContain("Error: User not found");
  });

  test("rsync streams handle missing user directory", async () => {
    await createUser("dirlessuser", "pass123", "user", 8097);
    assignGpu("dirlessuser", "http://endpoint", "token", "127.0.0.1", 2222);

    const stream = rsyncToGpuStream("dirlessuser");
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(value).toContain("Error: User directory not found");

    deleteUser("dirlessuser");
  });

  test("rsync streams path traversal check", async () => {
    await createUser("traversaluser", "pass123", "user", 8098);
    assignGpu("traversaluser", "http://endpoint", "token", "127.0.0.1", 2222);
    const userDir = join(BASE_DIR, "traversaluser");
    mkdirSync(userDir, { recursive: true });

    const stream = rsyncToGpuStream("traversaluser", "../somewhere");
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(value).toContain("Error: Path escapes user directory");

    // Clean up
    try {
      deleteUser("traversaluser");
      const fs = require("node:fs");
      fs.rmSync(userDir, { recursive: true, force: true });
    } catch (_) {}
  });

  test("isValidGpuEndpoint validates endpoints correctly", () => {
    expect(isValidGpuEndpoint("")).toBe(true);
    expect(isValidGpuEndpoint("http://localhost:8888")).toBe(true);
    expect(isValidGpuEndpoint("https://gpu-1.runpod.net")).toBe(true);
    expect(isValidGpuEndpoint("http://192.168.1.100:8888/user")).toBe(true);

    // Dangerous / invalid cases
    expect(isValidGpuEndpoint("http://endpoint;inject")).toBe(false);
    expect(isValidGpuEndpoint("http://endpoint'inject")).toBe(false);
    expect(isValidGpuEndpoint("http://endpoint\"inject")).toBe(false);
    expect(isValidGpuEndpoint("http://endpoint`inject")).toBe(false);
    expect(isValidGpuEndpoint("http://endpoint$inject")).toBe(false);
    expect(isValidGpuEndpoint("http://endpoint inject")).toBe(false);
    expect(isValidGpuEndpoint("invalid-url")).toBe(false);
  });

  test("rsync subpath injection check", async () => {
    await createUser("subpathuser", "pass123", "user", 8099);
    assignGpu("subpathuser", "http://endpoint", "token", "127.0.0.1", 2222);
    const userDir = join(BASE_DIR, "subpathuser");
    mkdirSync(userDir, { recursive: true });

    const stream = rsyncToGpuStream("subpathuser", "subpath;injection");
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(value).toContain("Error: Invalid subpath pattern");

    // Clean up
    try {
      deleteUser("subpathuser");
      const fs = require("node:fs");
      fs.rmSync(userDir, { recursive: true, force: true });
    } catch (_) {}
  });

  test("gpuInitStream validation error on invalid endpoint", async () => {
    const stream = gpuInitStream(
      "gputestuser",
      "127.0.0.1",
      22,
      "/dummy/key",
      "root",
      "token",
      "http://endpoint;inject",
      "/workspace"
    );
    const reader = stream.getReader();
    const { value } = await reader.read();
    expect(value).toContain("Error: Invalid GPU endpoint structure or dangerous characters detected");
  });

  test("Configuration thresholds have correct default values", () => {
    const { SYNC_SIZE_THRESHOLD, SYNC_FILE_THRESHOLD } = require("./config");
    expect(SYNC_SIZE_THRESHOLD).toBe(1073741824); // 1 GB
    expect(SYNC_FILE_THRESHOLD).toBe(5000); // 5000 files
  });

  test("SYNC_EXCLUDES contains all required patterns", () => {
    const { SYNC_EXCLUDES } = require("./gpu");
    expect(SYNC_EXCLUDES).toContain("*venv*");
    expect(SYNC_EXCLUDES).toContain("__pycache__");
    expect(SYNC_EXCLUDES).toContain(".ipynb_checkpoints");
    expect(SYNC_EXCLUDES).toContain("hf_cache");
    expect(SYNC_EXCLUDES).toContain(".cache");
    expect(SYNC_EXCLUDES).toContain(".conda");
    expect(SYNC_EXCLUDES).toContain(".local");
    expect(SYNC_EXCLUDES).toContain("nohup.out");
    expect(SYNC_EXCLUDES).toContain(".code-server");
  });

  // --- Injection validator tests ---

  test("validateGpuUsername allows valid names", () => {
    expect(() => validateGpuUsername("alice")).not.toThrow();
    expect(() => validateGpuUsername("user-1")).not.toThrow();
    expect(() => validateGpuUsername("user_2")).not.toThrow();
  });

  test("validateGpuUsername rejects injection strings", () => {
    expect(() => validateGpuUsername("user;rm -rf /")).toThrow();
    expect(() => validateGpuUsername("user$(id)")).toThrow();
    expect(() => validateGpuUsername("../etc/passwd")).toThrow();
    expect(() => validateGpuUsername("user name")).toThrow();
    expect(() => validateGpuUsername("")).toThrow();
  });

  test("validateSshUser allows valid users", () => {
    expect(() => validateSshUser("root")).not.toThrow();
    expect(() => validateSshUser("ubuntu")).not.toThrow();
    expect(() => validateSshUser("user_1")).not.toThrow();
  });

  test("validateSshUser rejects injection strings", () => {
    expect(() => validateSshUser("root;id")).toThrow();
    expect(() => validateSshUser("root$(id)")).toThrow();
    expect(() => validateSshUser("")).toThrow();
  });

  test("validateSshHost allows valid hostnames and IPs", () => {
    expect(() => validateSshHost("192.168.1.1")).not.toThrow();
    expect(() => validateSshHost("gpu.example.com")).not.toThrow();
    expect(() => validateSshHost("my-gpu-host")).not.toThrow();
  });

  test("validateSshHost rejects injection strings", () => {
    expect(() => validateSshHost("host;rm -rf /")).toThrow();
    expect(() => validateSshHost("host$(id)")).toThrow();
    expect(() => validateSshHost("host name")).toThrow();
    expect(() => validateSshHost("")).toThrow();
  });

  test("validateRemoteBaseDir allows valid absolute paths", () => {
    expect(() => validateRemoteBaseDir("/workspace")).not.toThrow();
    expect(() => validateRemoteBaseDir("/home/user/data")).not.toThrow();
    expect(() => validateRemoteBaseDir("/mnt/storage-01")).not.toThrow();
  });

  test("validateRemoteBaseDir rejects injection and traversal", () => {
    expect(() => validateRemoteBaseDir("/workspace;rm -rf /")).toThrow();
    expect(() => validateRemoteBaseDir("/workspace/../etc")).toThrow();
    expect(() => validateRemoteBaseDir("workspace")).toThrow(); // relative path
    expect(() => validateRemoteBaseDir("")).toThrow();
    expect(() => validateRemoteBaseDir("/workspace$(id)")).toThrow();
  });

  test("gpuInitStream rejects invalid username", () => {
    expect(() => gpuInitStream("bad;user", "127.0.0.1", 22, "/key", "root", "token", "", "/workspace")).toThrow();
  });

  test("gpuInitStream rejects invalid ssh host", () => {
    expect(() => gpuInitStream("validuser", "bad;host", 22, "/key", "root", "token", "", "/workspace")).toThrow();
  });

  test("gpuInitStream rejects invalid remote_base_dir", () => {
    expect(() => gpuInitStream("validuser", "127.0.0.1", 22, "/key", "root", "token", "", "relative/path")).toThrow();
  });

  test("testGpuSsh returns false for invalid host", async () => {
    const [ok, msg] = await testGpuSsh("bad;host$(id)", 22, "/dummy/key", "root");
    expect(ok).toBe(false);
    expect(msg).toContain("Invalid SSH host");
  });

  test("rsync streams reject invalid username", async () => {
    expect(() => rsyncToGpuStream("bad;user")).toThrow();
  });
});
