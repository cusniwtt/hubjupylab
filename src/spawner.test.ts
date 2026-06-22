import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { unlinkSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_DIR } from "./config";
import { initDb, createUser, deleteUser } from "./db";
import { getNextPort, getUserDir, cleanupUserFiles, spawnSession, validateUsername } from "./spawner";

const TEST_DB = join(BASE_DIR, "hubjupylab_spawner_test.db");
process.env.DB_PATH = TEST_DB;

describe("Spawner Module", () => {
  beforeAll(async () => {
    if (existsSync(TEST_DB)) {
      try {
        unlinkSync(TEST_DB);
      } catch (_) {}
    }
    await initDb();
  });

  afterAll(() => {
    if (existsSync(TEST_DB)) {
      try {
        unlinkSync(TEST_DB);
      } catch (_) {}
    }
  });

  test("getUserDir returns correct path", () => {
    expect(getUserDir("testuser")).toBe(join(BASE_DIR, "testuser"));
  });

  test("getNextPort allocates next port correctly", async () => {
    const initialPort = getNextPort();
    expect(initialPort).toBe(8081);

    // Create a user on 8081
    await createUser("user8081", "pass", "user", 8081);
    expect(getNextPort()).toBe(8082);

    // Create a user on 8082
    await createUser("user8082", "pass", "user", 8082);
    expect(getNextPort()).toBe(8083);

    // Clean up users
    deleteUser("user8081");
    deleteUser("user8082");
  });

  test("cleanupUserFiles deletes user directory", () => {
    const userDir = getUserDir("tempuser");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "file.txt"), "hello");
    expect(existsSync(userDir)).toBe(true);

    cleanupUserFiles("tempuser");
    expect(existsSync(userDir)).toBe(false);
  });

  test("validateUsername validates correctly", () => {
    expect(() => validateUsername("valid_user-123")).not.toThrow();
    expect(() => validateUsername("invalid;user")).toThrow();
    expect(() => validateUsername("../user")).toThrow();
  });

  test("getUserDir throws on path traversal attempts", () => {
    expect(() => getUserDir("valid-user")).not.toThrow();
    expect(() => getUserDir("invalid/user")).toThrow();
    expect(() => getUserDir("../outside")).toThrow();
  });

  test("spawnSession rejects invalid ports or tokens", async () => {
    // Port out of bounds
    await expect(spawnSession("validuser", 9999, "token")).rejects.toThrow("Invalid port: 9999");
    // Non-integer port
    await expect(spawnSession("validuser", 8081.5, "token")).rejects.toThrow("Invalid port: 8081.5");
    // Invalid token characters
    await expect(spawnSession("validuser", 8081, "token;injection")).rejects.toThrow("Invalid token format");
  });
});
