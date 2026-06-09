import os
import sys
from fastapi.testclient import TestClient

# Adjust path to import main
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from main import app
import db
import spawner

def test_polling_endpoints():
    db.init_db()
    client = TestClient(app)
    
    # 1. Create a dummy test user
    username = "testpolluser"
    db.create_user(username, "password123")
    
    try:
        # Mock login/session by setting cookie
        # We need a signed cookie. Let's use TestClient with signed cookie or manually sign it.
        # But we can also test the endpoints directly by mocking require_auth and require_admin dependencies!
        from main import require_auth, require_admin
        
        user_data = db.get_user_by_username(username)
        # Mock require_auth to return the test user
        app.dependency_overrides[require_auth] = lambda: user_data
        # Mock require_admin to return the admin user
        admin_data = db.get_user_by_username("admin")
        if not admin_data:
            db.create_user("admin", "adminpass", role="admin")
            admin_data = db.get_user_by_username("admin")
        app.dependency_overrides[require_admin] = lambda: admin_data

        # 2. Test GET /session/status
        print("[1] Testing GET /session/status...")
        response = client.get("/session/status")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        assert "Your JupyterLab Server" in response.text
        print("GET /session/status response looks correct!")

        # 3. Test GET /admin/users/status-poll
        print("[2] Testing GET /admin/users/status-poll...")
        response = client.get("/admin/users/status-poll")
        assert response.status_code == 200, f"Expected 200, got {response.status_code}"
        assert f"user-row-{username}" in response.text
        assert 'hx-swap-oob="true"' in response.text
        # Ensure gpu-panel is NOT in the response (since is_poll is True)
        assert f"gpu-panel-{username}" not in response.text
        print("GET /admin/users/status-poll response looks correct!")
        
        print("\n--- ALL POLLING ENDPOINT TESTS PASSED! ---")
        
    finally:
        # Clean up
        db.delete_user(username)
        app.dependency_overrides.clear()

if __name__ == "__main__":
    test_polling_endpoints()
