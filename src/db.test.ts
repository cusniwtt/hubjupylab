import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { BASE_DIR } from "./config";

const TEST_DB = join(BASE_DIR, "hubjupylab_test.db");
process.env.DB_PATH = TEST_DB;

// Delete the DB file before requiring the db module to avoid unlinking an open file
if (existsSync(TEST_DB)) {
  try {
    unlinkSync(TEST_DB);
  } catch (_) {}
}

// Require db module dynamically to ensure DB deletion happens first
const {
  initDb,
  createUser,
  deleteUser,
  getUserByUsername,
  listUsers,
  updateToken,
  getUsedPorts,
  verifyPassword,
  getGpuConfig,
  saveGpuConfig,
  assignGpu,
  unassignGpu,
  updateGpuInitStatus
} = require("./db");

describe("Database Module", () => {
  beforeAll(async () => {
    await initDb();
  });

  test("initDb seeds admin and creates tables", async () => {
    const admin = getUserByUsername("admin");
    expect(admin).not.toBeNull();
    expect(admin!.role).toBe("admin");
    expect(await verifyPassword("admin", admin!.password_hash)).toBe(true);
  });

  test("createUser and getUserByUsername", async () => {
    const success = await createUser("testuser", "password123", "user", 8081);
    expect(success).toBe(true);

    const user = getUserByUsername("testuser");
    expect(user).not.toBeNull();
    expect(user!.username).toBe("testuser");
    expect(user!.port).toBe(8081);
    expect(await verifyPassword("password123", user!.password_hash)).toBe(true);

    // Test duplicate creation fails
    const duplicateSuccess = await createUser("testuser", "anotherpassword", "user", 8082);
    expect(duplicateSuccess).toBe(false);
  });

  test("listUsers", async () => {
    // Should return testuser, but NOT admin
    const users = listUsers();
    expect(users.length).toBe(1);
    expect(users[0].username).toBe("testuser");
  });

  test("updateToken and getUsedPorts", () => {
    updateToken("testuser", "my-secure-token");
    const user = getUserByUsername("testuser");
    expect(user!.token).toBe("my-secure-token");

    const ports = getUsedPorts();
    expect(ports).toContain(8081);
  });

  test("GPU config save and retrieve", () => {
    const defaultConfig = getGpuConfig();
    expect(defaultConfig.ssh_port).toBe(22);

    saveGpuConfig("127.0.0.1", 2222, "root", "/home/test/.ssh/id_rsa", "/workspace");
    const savedConfig = getGpuConfig();
    expect(savedConfig.ssh_host).toBe("127.0.0.1");
    expect(savedConfig.ssh_port).toBe(2222);
  });

  test("assignGpu, updateGpuInitStatus, and unassignGpu", () => {
    assignGpu("testuser", "http://endpoint", "token123", "127.0.0.1", 2222);
    let user = getUserByUsername("testuser");
    expect(user!.gpu_endpoint).toBe("http://endpoint");
    expect(user!.gpu_init_status).toBe("pending");

    updateGpuInitStatus("testuser", "running");
    user = getUserByUsername("testuser");
    expect(user!.gpu_init_status).toBe("running");

    // Assigning again with same host/port should preserve status
    assignGpu("testuser", "http://endpoint2", "token456", "127.0.0.1", 2222);
    user = getUserByUsername("testuser");
    expect(user!.gpu_init_status).toBe("running");
    expect(user!.gpu_token).toBe("token456");

    // Assigning with new host/port resets status to pending
    assignGpu("testuser", "http://endpoint2", "token456", "127.0.0.2", 2222);
    user = getUserByUsername("testuser");
    expect(user!.gpu_init_status).toBe("pending");

    unassignGpu("testuser");
    user = getUserByUsername("testuser");
    expect(user!.gpu_endpoint).toBeNull();
    expect(user!.gpu_init_status).toBeNull();
  });

  test("deleteUser", () => {
    deleteUser("testuser");
    const user = getUserByUsername("testuser");
    expect(user).toBeNull();
  });

  afterAll(() => {
    if (existsSync(TEST_DB)) {
      try {
        unlinkSync(TEST_DB);
      } catch (_) {}
    }
  });
});
