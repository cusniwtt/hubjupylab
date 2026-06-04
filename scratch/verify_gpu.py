import os
import sys
from pathlib import Path

# Add root directory to path to import modules
sys.path.append(str(Path(__file__).parent.parent))

import db
import gpu
import config

def test_gpu_features():
    print("--- HubJupyLab GPU Features Verification ---")
    
    # 1. Init DB
    db.init_db()
    
    # Clean up test user
    db.delete_user("gpu_test_user")
    
    # 2. Create test user
    db.create_user("gpu_test_user", "test_pass", role="user", port=8095)
    user = db.get_user_by_username("gpu_test_user")
    assert user is not None
    assert user['gpu_ssh_host'] is None
    assert user['gpu_ssh_port'] is None
    assert user['gpu_endpoint'] is None
    assert user['gpu_token'] is None
    print("[1] Test user created with empty GPU config successfully")

    # 3. Assign GPU config to user
    db.assign_gpu(
        username="gpu_test_user",
        gpu_endpoint="http://1.2.3.4:8888/user/gpu_test_user",
        gpu_token="some_gpu_token_abc",
        gpu_ssh_host="5.6.7.8",
        gpu_ssh_port=2222
    )
    
    user = db.get_user_by_username("gpu_test_user")
    assert user['gpu_ssh_host'] == "5.6.7.8"
    assert user['gpu_ssh_port'] == 2222
    assert user['gpu_endpoint'] == "http://1.2.3.4:8888/user/gpu_test_user"
    assert user['gpu_token'] == "some_gpu_token_abc"
    print("[2] GPU config assigned to user successfully")

    # 4. Check rsync failure handling when user directory doesn't exist
    # (Since config.BASE_DIR / username doesn't exist yet)
    db.save_gpu_config(ssh_host="", ssh_port=22, ssh_user="root", ssh_key_path="/dummy/key", remote_base_dir="/workspace")
    success, msg = gpu.rsync_user_to_gpu("gpu_test_user")
    assert not success
    assert "User directory not found" in msg
    print("[3] Checked rsync error when user directory doesn't exist")

    # 5. Check rsync failure handling when user is not found
    success, msg = gpu.rsync_user_to_gpu("non_existent_user")
    assert not success
    assert "not found" in msg
    print("[4] Checked rsync error when user is not found")

    # 6. Unassign GPU config from user
    db.unassign_gpu("gpu_test_user")
    user = db.get_user_by_username("gpu_test_user")
    assert user['gpu_ssh_host'] is None
    assert user['gpu_ssh_port'] is None
    assert user['gpu_endpoint'] is None
    assert user['gpu_token'] is None
    print("[5] GPU config unassigned from user successfully")

    # Clean up
    db.delete_user("gpu_test_user")
    print("\n--- ALL GPU FEATURE TESTS PASSED! ---")

if __name__ == "__main__":
    test_features = True
    try:
        test_gpu_features()
    except AssertionError as e:
        print(f"\n❌ ASSERTION ERROR: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ UNEXPECTED ERROR: {e}")
        sys.exit(1)
