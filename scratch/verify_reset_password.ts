import { createUser, deleteUser, getUserByUsername, verifyPassword } from "../src/db";

async function verifyResetPassword() {
  console.log("--- End-to-End Password Reset & Change Verification ---");

  const baseUrl = "http://127.0.0.1:8080";

  // Clean up any leftover test user
  console.log("[1] Cleaning up test user...");
  deleteUser("pw_test_user");

  // 1. Create a test user directly in DB so we don't have to deal with port limits
  console.log("[2] Creating test user 'pw_test_user' with initial password...");
  const created = await createUser("pw_test_user", "initialPass123", "user", 8099);
  if (!created) {
    throw new Error("Failed to create test user");
  }

  // 2. Login as admin to get session cookie
  console.log("[3] Logging in as admin...");
  const adminLoginRes = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "username=admin&password=admin",
    redirect: "manual"
  });

  const adminCookie = adminLoginRes.headers.get("set-cookie");
  if (!adminCookie) {
    throw new Error("Admin login did not return a session cookie");
  }
  console.log("Admin logged in successfully.");

  // 3. Reset the user's password as admin via HTMX request
  console.log("[4] Resetting password for 'pw_test_user' as admin...");
  const resetRes = await fetch(`${baseUrl}/admin/users/pw_test_user/reset-password`, {
    method: "POST",
    headers: {
      "Cookie": adminCookie,
      "hx-request": "true"
    }
  });

  if (resetRes.status !== 200) {
    throw new Error(`Reset password endpoint returned status ${resetRes.status}`);
  }

  const hxTrigger = resetRes.headers.get("hx-trigger");
  if (!hxTrigger) {
    throw new Error("Reset password did not return HX-Trigger header");
  }

  const triggerData = JSON.parse(hxTrigger);
  const tempPass = triggerData["password-reset"]?.tempPass;
  if (!tempPass) {
    throw new Error("HX-Trigger header does not contain temporary password");
  }
  console.log(`Password reset successful. Temporary password generated: ${tempPass}`);

  // 4. Verify user database state reflects must_change_password = 1
  const userInDb = getUserByUsername("pw_test_user");
  if (!userInDb || userInDb.must_change_password !== 1) {
    throw new Error(`Database must_change_password state is incorrect: ${userInDb?.must_change_password}`);
  }
  console.log("User must_change_password database flag is set to 1.");

  // 5. Try logging in as pw_test_user using the temporary password
  console.log("[5] Logging in as 'pw_test_user' with temporary password...");
  const userLoginRes = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `username=pw_test_user&password=${encodeURIComponent(tempPass)}`,
    redirect: "manual"
  });

  const userCookie = userLoginRes.headers.get("set-cookie");
  if (!userCookie) {
    throw new Error("User login did not return a session cookie");
  }
  console.log("Logged in with temporary password successfully.");

  // 6. Access dashboard to check redirect to /change-password
  console.log("[6] Requesting /dashboard to verify force redirect...");
  const dashboardRes = await fetch(`${baseUrl}/dashboard`, {
    headers: { "Cookie": userCookie },
    redirect: "manual"
  });

  if (dashboardRes.status !== 302 || dashboardRes.headers.get("location") !== "/change-password") {
    throw new Error(`Expected redirect to /change-password (302), got status ${dashboardRes.status} redirecting to ${dashboardRes.headers.get("location")}`);
  }
  console.log("Successfully intercepted and redirected to /change-password!");

  // 7. Submit /change-password form
  console.log("[7] Submitting new password...");
  const changePasswordRes = await fetch(`${baseUrl}/change-password`, {
    method: "POST",
    headers: {
      "Cookie": userCookie,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "password=newSecurePassword123&confirm_password=newSecurePassword123",
    redirect: "manual"
  });

  if (changePasswordRes.status !== 303 || !changePasswordRes.headers.get("location")?.includes("/dashboard")) {
    throw new Error(`Expected 303 redirect to /dashboard after password change, got status ${changePasswordRes.status}`);
  }
  console.log("Password changed successfully.");

  // 8. Request dashboard again with the user's cookie to verify access
  console.log("[8] Requesting /dashboard again to verify access...");
  const dashboardAccessRes = await fetch(`${baseUrl}/dashboard`, {
    headers: { "Cookie": userCookie },
    redirect: "manual"
  });

  if (dashboardAccessRes.status !== 200) {
    throw new Error(`Expected 200 OK after password change, got status ${dashboardAccessRes.status}`);
  }
  console.log("Dashboard loaded successfully after password update!");

  // 9. Clean up test user
  console.log("[9] Cleaning up test user...");
  deleteUser("pw_test_user");

  console.log("\n--- PASSWORD RESET & CHANGE TEST PASSED SUCCESSFULLY ---");
}

verifyResetPassword().catch((err) => {
  console.error("\n❌ E2E TEST FAILED:", err.message ?? err);
  process.exit(1);
});
