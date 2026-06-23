import os
import sys
import shutil
import time
from pathlib import Path

# Add root directory to path to import modules
sys.path.append(str(Path(__file__).parent.parent))

import db
import spawner
import config

def run_test():
    print("--- HubJupyLab Verification Script ---")
    
    # 1. Initialize DB
    print("\n[1] Initializing SQLite DB...")
    db.init_db()
    db_path = Path(config.BASE_DIR) / "hubjupylab.db"
    assert db_path.exists(), "DB file was not created!"
    print(f"DB initialized at {db_path}")

    # Verify admin was seeded
    admin = db.get_user_by_username(config.ADMIN_USER)
    assert admin is not None, "Admin user was not seeded!"
    assert admin['role'] == 'admin', "Admin role is incorrect!"
    print("Admin seeded successfully")

    # Cleanup user "test_user" if leftover
    db.delete_user("test_user")
    spawner.stop_session("test_user")
    spawner.cleanup_user_files("test_user")

    # 2. Create User
    print("\n[2] Creating user 'test_user'...")
    port = 8090
    
    created = db.create_user("test_user", "test123pass", role="user", port=port)
    assert created, "Failed to create user in DB"
    
    user = db.get_user_by_username("test_user")
    assert user is not None, "User not found in DB after creation"
    assert user['port'] == port, f"Incorrect port: expected {port}, got {user['port']}"
    print(f"User 'test_user' created in DB with port {port}")

    # 3. Setup user environment (venv + install jupyterlab)
    print("\n[3] Setting up user venv (this will download Python 3.14 if needed and install JupyterLab)...")
    success = spawner.setup_user_env("test_user")
    assert success, "Failed to setup user environment"
    
    user_dir = spawner.get_user_dir("test_user")
    venv_dir = user_dir / ".venv"
    assert venv_dir.exists(), "Venv dir does not exist!"
    assert (venv_dir / "bin" / "jupyter").exists(), "Jupyter executable not found!"
    print("User environment set up successfully with uv & python 3.14")

    # 4. Spawn JupyterLab session via tmux
    print("\n[4] Spawning tmux session for 'test_user'...")
    token = "testtoken12345"
    db.update_token("test_user", token)
    
    success = spawner.spawn_session("test_user", port, token)
    assert success, "Failed to spawn tmux session"
    
    # Wait a moment for tmux session to register
    time.sleep(2)
    
    assert spawner.is_session_running("test_user"), "tmux session is not running!"
    print("tmux session spawned and running successfully")

    # 5. Stop session
    print("\n[5] Stopping tmux session for 'test_user'...")
    success = spawner.stop_session("test_user")
    assert success, "Failed to stop tmux session"
    assert not spawner.is_session_running("test_user"), "tmux session should be stopped!"
    db.update_token("test_user", None)
    print("tmux session stopped successfully")

    # 6. Cleanup user files
    print("\n[6] Deleting user 'test_user' files...")
    spawner.cleanup_user_files("test_user")
    assert not user_dir.exists(), "User folder still exists!"
    db.delete_user("test_user")
    assert db.get_user_by_username("test_user") is None, "User still exists in DB!"
    print("Cleanup successful")

    print("\n--- ALL TESTS PASSED SUCCESSFULLY! ---")

if __name__ == "__main__":
    try:
        run_test()
    except AssertionError as e:
        print(f"\n❌ ASSERTION ERROR: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ UNEXPECTED ERROR: {e}")
        sys.exit(1)
