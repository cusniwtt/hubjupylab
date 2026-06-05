import sys
from pathlib import Path

# Add root directory to path to import modules
sys.path.append(str(Path(__file__).parent.parent))

from fastapi import Request
from main import (
    admin_create_user,
    admin_delete_user,
    admin_start_session,
    admin_stop_session,
    admin_restart_session,
    admin_gpu_assign,
    admin_stop_gpu,
    admin_reset_gpu,
    admin_gpu_select_partial
)
import db
import spawner

# Mock Request object
class MockRequest:
    def __init__(self, headers):
        self.headers = headers
        self.base_url = type('BaseUrl', (object,), {'hostname': '127.0.0.1'})

def run_test():
    print("--- HubJupyLab HTMX Admin Control Flow Verification ---")
    
    # 1. Init DB and cleanup
    db.init_db()
    db.delete_user('test_admin_htmx')
    spawner.stop_session('test_admin_htmx')
    spawner.cleanup_user_files('test_admin_htmx')
    
    # 2. Test HTMX Create User
    print("\n[1] Testing HTMX create user...")
    req_htmx = MockRequest(headers={"HX-Request": "true"})
    
    res_create = admin_create_user(username="test_admin_htmx", password="password123", request=req_htmx, admin_user=None)
    assert res_create.template.name == "partials/_admin_user_table_body.html"
    assert "HX-Trigger" in res_create.headers
    assert "Created user" in res_create.headers["HX-Trigger"]
    assert "userListUpdated" in res_create.headers["HX-Trigger"]
    print("HTMX create user returns correct partial and headers!")
    
    # 3. Test HTMX Start Session
    print("\n[2] Testing HTMX start session...")
    res_start = admin_start_session(username="test_admin_htmx", request=req_htmx, admin_user=None)
    assert res_start.template.name == "partials/_admin_user_row.html"
    assert "HX-Trigger" in res_start.headers
    assert "started for test_admin_htmx" in res_start.headers["HX-Trigger"]
    print("HTMX start session returns correct partial and headers!")
    
    # 4. Test HTMX Restart Session
    print("\n[3] Testing HTMX restart session...")
    res_restart = admin_restart_session(username="test_admin_htmx", request=req_htmx, admin_user=None)
    assert res_restart.template.name == "partials/_admin_user_row.html"
    assert "HX-Trigger" in res_restart.headers
    assert "restarted for test_admin_htmx" in res_restart.headers["HX-Trigger"]
    print("HTMX restart session returns correct partial and headers!")
    
    # 5. Test HTMX Stop Session
    print("\n[4] Testing HTMX stop session...")
    res_stop = admin_stop_session(username="test_admin_htmx", request=req_htmx, admin_user=None)
    assert res_stop.template.name == "partials/_admin_user_row.html"
    assert "HX-Trigger" in res_stop.headers
    assert "stopped for test_admin_htmx" in res_stop.headers["HX-Trigger"]
    print("HTMX stop session returns correct partial and headers!")
    
    # 6. Test HTMX GPU Assign
    print("\n[5] Testing HTMX GPU Assign...")
    res_assign = admin_gpu_assign(
        username="test_admin_htmx",
        request=req_htmx,
        gpu_ssh_host="1.2.3.4",
        gpu_ssh_port=22,
        gpu_endpoint="http://gpu.example.com",
        gpu_token="gputoken",
        admin_user=None
    )
    assert res_assign.template.name == "partials/_admin_user_row.html"
    assert "HX-Trigger" in res_assign.headers
    assert "GPU assigned to test_admin_htmx" in res_assign.headers["HX-Trigger"]
    assert "userListUpdated" in res_assign.headers["HX-Trigger"]
    print("HTMX GPU assign returns correct partial and headers!")
    
    # 7. Test HTMX GPU Select Partial
    print("\n[6] Testing HTMX GPU select partial...")
    res_select = admin_gpu_select_partial(request=req_htmx, admin_user=None)
    assert res_select.template.name == "partials/_admin_gpu_select.html"
    print("HTMX GPU select partial returns correct template!")
    
    # 8. Test HTMX GPU Reset
    print("\n[7] Testing HTMX GPU Reset...")
    res_reset = admin_reset_gpu(username="test_admin_htmx", request=req_htmx, admin_user=None)
    assert res_reset.template.name == "partials/_admin_user_row.html"
    assert "HX-Trigger" in res_reset.headers
    assert "GPU status reset for test_admin_htmx" in res_reset.headers["HX-Trigger"]
    assert "userListUpdated" in res_reset.headers["HX-Trigger"]
    print("HTMX GPU reset returns correct partial and headers!")
    
    # 9. Test HTMX Delete User
    print("\n[8] Testing HTMX delete user...")
    res_delete = admin_delete_user(username="test_admin_htmx", delete_files="true", request=req_htmx, admin_user=None)
    assert res_delete.status_code == 200
    assert res_delete.body == b""
    assert "HX-Trigger" in res_delete.headers
    assert "Deleted user test_admin_htmx" in res_delete.headers["HX-Trigger"]
    assert "userListUpdated" in res_delete.headers["HX-Trigger"]
    print("HTMX delete user returns empty body and headers!")
    
    print("\n--- ALL HTMX ADMIN CONTROL TESTS PASSED! ---")

if __name__ == "__main__":
    try:
        run_test()
    except AssertionError as e:
        print(f"\n❌ ASSERTION ERROR: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ UNEXPECTED ERROR: {e}")
        sys.exit(1)
    sys.exit(0)
