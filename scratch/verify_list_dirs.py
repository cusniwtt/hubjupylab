import sys
from pathlib import Path
import shutil

# Add root directory to path to import modules
sys.path.append(str(Path(__file__).parent.parent))

import db
import config
from main import user_list_dirs
from fastapi import HTTPException

def run_test():
    print("--- HubJupyLab Directory List Verification ---")
    
    # Init DB and cleanup
    db.init_db()
    db.delete_user("test_list")
    
    # Create test user
    db.create_user("test_list", "pass123", role="user", port=8086)
    user_dir = Path(config.BASE_DIR) / "test_list"
    
    # Setup directories
    if user_dir.exists():
        shutil.rmtree(user_dir)
    user_dir.mkdir(parents=True)
    
    # Create folder structure
    (user_dir / "data").mkdir()
    (user_dir / "data" / "raw").mkdir()
    (user_dir / "data" / "processed").mkdir()
    (user_dir / "models").mkdir()
    (user_dir / ".git").mkdir()
    (user_dir / ".git" / "refs").mkdir()
    (user_dir / ".venv").mkdir()
    (user_dir / "__pycache__").mkdir()
    
    current_user = db.get_user_by_username("test_list")
    
    # 1. Test user list dirs
    print("\n[1] Testing user_list_dirs...")
    res = user_list_dirs(current_user=current_user)
    
    # We expect data, data/raw, data/processed, models.
    # We expect .git, .venv, __pycache__ to be IGNORED.
    
    print("Result structure:", res)
    
    # Let's write validation
    assert len(res) == 2, f"Expected 2 root folders (data, models), got {len(res)}"
    assert res[0]["name"] == "data"
    assert len(res[0]["children"]) == 2, f"Expected 2 subfolders in data, got {len(res[0]['children'])}"
    assert res[0]["children"][0]["name"] in ["processed", "raw"]
    assert res[0]["children"][1]["name"] in ["processed", "raw"]
    assert res[1]["name"] == "models"
    assert len(res[1]["children"]) == 0
    
    print("Ignored folders (.git, .venv, __pycache__) are successfully ignored!")
    print("Folder hierarchy is correctly generated!")
    
    # 2. Test admin role restriction
    print("\n[2] Testing role restriction...")
    admin_user = db.get_user_by_username(config.ADMIN_USER)
    if not admin_user:
        # Create temporary admin user
        db.create_user("admin_temp", "admin_pass", role="admin", port=8087)
        admin_user = db.get_user_by_username("admin_temp")
    
    try:
        user_list_dirs(current_user=admin_user)
        assert False, "Expected admin to be forbidden from listing directories"
    except HTTPException as e:
        assert e.status_code == 403
        print("Admin user is correctly forbidden (HTTP 403)")
    
    # Cleanup
    shutil.rmtree(user_dir)
    db.delete_user("test_list")
    if db.get_user_by_username("admin_temp"):
        db.delete_user("admin_temp")
        
    print("\n--- ALL DIRECTORY LIST TESTS PASSED! ---")

if __name__ == "__main__":
    run_test()
