import os
sys_path_setup = False
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
    
    # Cleanup wayu
    db.delete_user("wayu")
    spawner.stop_session("wayu")
    spawner.cleanup_user_files("wayu")
    
    # Create user
    port = spawner.get_next_port()
    db.create_user("wayu", "pass123", role="user", port=port)
    spawner.setup_user_env("wayu")
    
    print("\n[1] Testing admin_start_session...")
    response = admin_start_session("wayu", admin_user=None)
    assert response.status_code == 303
    assert "success=" in response.headers["location"]
    assert spawner.is_session_running("wayu")
    print("admin_start_session works!")
    
    print("\n[2] Testing admin_restart_session...")
    response = admin_restart_session("wayu", admin_user=None)
    assert response.status_code == 303
    assert "success=" in response.headers["location"]
    assert spawner.is_session_running("wayu")
    print("admin_restart_session works!")
    
    print("\n[3] Testing admin_stop_session...")
    response = admin_stop_session("wayu", admin_user=None)
    assert response.status_code == 303
    assert "success=" in response.headers["location"]
    assert not spawner.is_session_running("wayu")
    print("admin_stop_session works!")
    
    # Clean up
    spawner.cleanup_user_files("wayu")
    db.delete_user("wayu")
    print("\n--- ALL ADMIN CONTROL TESTS PASSED! ---")

if __name__ == "__main__":
    run_test()
