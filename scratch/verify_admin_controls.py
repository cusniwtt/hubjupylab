import os
import sys
from pathlib import Path

# Add root directory to path to import modules
sys.path.append(str(Path(__file__).parent.parent))

import db
import spawner
import config
from main import admin_start_session, admin_stop_session, admin_restart_session
from fastapi import HTTPException

def run_test():
    print("--- HubJupyLab Admin Control Verification ---")
    
    # Init DB
    db.init_db()
    
    # Cleanup test_user
    db.delete_user("test_user")
    spawner.stop_session("test_user")
    spawner.cleanup_user_files("test_user")
    
    # Create user on port 8090
    port = 8090
    db.create_user("test_user", "pass123", role="user", port=port)
    spawner.setup_user_env("test_user")
    
    print("\n[1] Testing admin_start_session...")
    response = admin_start_session("test_user", admin_user=None)
    assert response.status_code == 303
    assert "success=" in response.headers["location"]
    assert spawner.is_session_running("test_user")
    print("admin_start_session works!")
    
    print("\n[2] Testing admin_restart_session...")
    response = admin_restart_session("test_user", admin_user=None)
    assert response.status_code == 303
    assert "success=" in response.headers["location"]
    assert spawner.is_session_running("test_user")
    print("admin_restart_session works!")
    
    print("\n[3] Testing admin_stop_session...")
    response = admin_stop_session("test_user", admin_user=None)
    assert response.status_code == 303
    assert "success=" in response.headers["location"]
    assert not spawner.is_session_running("test_user")
    print("admin_stop_session works!")
    
    # Clean up
    spawner.cleanup_user_files("test_user")
    db.delete_user("test_user")
    print("\n--- ALL ADMIN CONTROL TESTS PASSED! ---")

if __name__ == "__main__":
    run_test()
