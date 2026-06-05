import sys
from pathlib import Path

# Add root directory to path to import modules
sys.path.append(str(Path(__file__).parent.parent))

from fastapi import Request
from main import user_start_session, user_stop_session, user_restart_session
import db
import spawner

# Mock Request object
class MockRequest:
    def __init__(self, headers):
        self.headers = headers
        self.base_url = type('BaseUrl', (object,), {'hostname': '127.0.0.1'})

def run_test():
    print("--- HubJupyLab HTMX User Control Flow Verification ---")
    
    # 1. Init DB and cleanup
    db.init_db()
    db.delete_user('test_htmx')
    spawner.stop_session('test_htmx')
    spawner.cleanup_user_files('test_htmx')
    
    # 2. Create test user
    db.create_user('test_htmx', 'pass123', role='user', port=8085)
    spawner.setup_user_env('test_htmx')
    
    # Get user dict from DB to match structure
    user_dict = db.get_user_by_username('test_htmx')
    
    # 3. Test non-HTMX start session
    print("\n[1] Testing non-HTMX start session...")
    req_normal = MockRequest(headers={})
    res_normal = user_start_session(req_normal, current_user=user_dict)
    assert res_normal.status_code == 303
    assert "success=JupyterLab+started" in res_normal.headers.get('location')
    print("Non-HTMX start session returns correct RedirectResponse")

    # Update user dict in memory to reflect started state (token set)
    user_dict = db.get_user_by_username('test_htmx')

    # 4. Test HTMX restart session
    print("\n[2] Testing HTMX restart session...")
    req_htmx = MockRequest(headers={"HX-Request": "true"})
    res_htmx_restart = user_restart_session(req_htmx, current_user=user_dict)
    assert res_htmx_restart.template.name == "partials/_dashboard_status.html"
    assert "HX-Trigger" in res_htmx_restart.headers
    assert "restarted" in res_htmx_restart.headers["HX-Trigger"]
    print("HTMX restart session returns correct TemplateResponse and HX-Trigger header")

    # Update user dict
    user_dict = db.get_user_by_username('test_htmx')

    # 5. Test HTMX stop session
    print("\n[3] Testing HTMX stop session...")
    res_htmx_stop = user_stop_session(req_htmx, current_user=user_dict)
    assert res_htmx_stop.template.name == "partials/_dashboard_status.html"
    assert "HX-Trigger" in res_htmx_stop.headers
    assert "stopped" in res_htmx_stop.headers["HX-Trigger"]
    print("HTMX stop session returns correct TemplateResponse and HX-Trigger header")
    
    # 6. Clean up
    spawner.cleanup_user_files('test_htmx')
    db.delete_user('test_htmx')
    print("\n--- ALL HTMX USER CONTROL TESTS PASSED! ---")

if __name__ == "__main__":
    try:
        run_test()
    except AssertionError as e:
        print(f"\n❌ ASSERTION ERROR: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ UNEXPECTED ERROR: {e}")
        sys.exit(1)
