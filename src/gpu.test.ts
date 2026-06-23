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
const { testGpuSsh, stopGpuSession, getLastGpuLog, rsyncToGpuStream, isValidGpuEndpoint, gpuInitStream } = require("./gpu");

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
});
