import { existsSync } from "node:fs";
import { join } from "node:path";
import { BASE_DIR } from "../src/config";
import { initDb, createUser, deleteUser, getUserByUsername, updateToken } from "../src/db";
import { getNextPort, getUserDir, setupUserEnv, spawnSession, isSessionRunning, stopSession, cleanupUserFiles } from "../src/spawner";

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTest() {
  console.log("--- HubJupyLab TS Verification Script ---");

  // 1. Initialize DB
  console.log("\n[1] Initializing SQLite DB...");
  await initDb();
  const dbPath = join(BASE_DIR, "hubjupylab.db");
  if (!existsSync(dbPath)) {
    throw new Error(`DB file was not created at ${dbPath}`);
  }
  console.log(`DB initialized at ${dbPath}`);

  // Verify admin was seeded
  const admin = getUserByUsername("admin");
  if (!admin) {
    throw new Error("Admin user was not seeded!");
  }
  if (admin.role !== "admin") {
    throw new Error("Admin role is incorrect!");
  }
  console.log("Admin seeded successfully");

  // Cleanup user "wayu" if leftover
  deleteUser("wayu");
  await stopSession("wayu");
  cleanupUserFiles("wayu");

  // 2. Create User
  console.log("\n[2] Creating user 'wayu'...");
  const port = getNextPort();
  if (port !== 8081) {
    throw new Error(`First port should be 8081, got ${port}`);
  }

  const created = await createUser("wayu", "test123pass", "user", port);
  if (!created) {
    throw new Error("Failed to create user in DB");
  }

  const user = getUserByUsername("wayu");
  if (!user) {
    throw new Error("User not found in DB after creation");
  }
  if (user.port !== 8081) {
    throw new Error(`Incorrect port: ${user.port}`);
  }
  console.log(`User 'wayu' created in DB with port ${port}`);

  // 3. Setup user environment (venv + install jupyterlab)
  console.log("\n[3] Setting up user venv (this will install JupyterLab using uv)...");
  const success = await setupUserEnv("wayu");
  if (!success) {
    throw new Error("Failed to setup user environment");
  }

  const userDir = getUserDir("wayu");
  const venvDir = join(userDir, ".venv");
  if (!existsSync(venvDir)) {
    throw new Error("Venv dir does not exist!");
  }
  if (!existsSync(join(venvDir, "bin", "jupyter"))) {
    throw new Error("Jupyter executable not found!");
  }
  console.log("User environment set up successfully with uv & python");

  // 4. Spawn JupyterLab session via tmux
  console.log("\n[4] Spawning tmux session for 'wayu'...");
  const token = "testtoken12345";
  updateToken("wayu", token);

  const spawned = await spawnSession("wayu", port, token);
  if (!spawned) {
    throw new Error("Failed to spawn tmux session");
  }

  // Wait a moment for tmux session to register
  await sleep(2000);

  if (!(await isSessionRunning("wayu"))) {
    throw new Error("tmux session is not running!");
  }
  console.log("tmux session spawned and running successfully");

  // 5. Stop session
  console.log("\n[5] Stopping tmux session for 'wayu'...");
  const stopped = await stopSession("wayu");
  if (!stopped) {
    throw new Error("Failed to stop tmux session");
  }
  if (await isSessionRunning("wayu")) {
    throw new Error("tmux session should be stopped!");
  }
  updateToken("wayu", null);
  console.log("tmux session stopped successfully");

  // 6. Cleanup user files
  console.log("\n[6] Deleting user 'wayu' files...");
  cleanupUserFiles("wayu");
  if (existsSync(userDir)) {
    throw new Error("User folder still exists!");
  }
  deleteUser("wayu");
  if (getUserByUsername("wayu") !== null) {
    throw new Error("User still exists in DB!");
  }
  console.log("Cleanup successful");

  console.log("\n--- ALL TS TESTS PASSED SUCCESSFULLY! ---");
}

runTest().catch((err) => {
  console.error("\n❌ ERROR:", err.message ?? err);
  process.exit(1);
});
