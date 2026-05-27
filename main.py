import secrets
from fastapi import FastAPI, Request, Form, Depends, HTTPException, status
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from itsdangerous import Signer, BadSignature
import config
import db
import spawner

app = FastAPI(title="HubJupyLab")

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Setup templates
templates = Jinja2Templates(directory="templates")

# Signer for session cookie
signer = Signer(config.SECRET_KEY)

def get_current_user(request: Request):
    session_cookie = request.cookies.get("hub_session")
    if not session_cookie:
        return None
    try:
        username = signer.unsign(session_cookie).decode('utf-8')
        user = db.get_user_by_username(username)
        return user
    except (BadSignature, Exception):
        return None

def require_auth(request: Request):
    user = get_current_user(request)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_307_TEMPORARY_REDIRECT,
            headers={"Location": "/"}
        )
    return user

def require_admin(request: Request):
    user = require_auth(request)
    if user['role'] != 'admin':
        raise HTTPException(
            status_code=status.HTTP_307_TEMPORARY_REDIRECT,
            headers={"Location": "/dashboard"}
        )
    return user

@app.on_event("startup")
def startup_event():
    db.init_db()
    spawner.sync_sessions()

# --- HTTP GET Routes ---

@app.get("/", response_class=HTMLResponse)
def login_page(request: Request, error: str = None, success: str = None):
    user = get_current_user(request)
    if user:
        if user['role'] == 'admin':
            return RedirectResponse(url="/admin")
        return RedirectResponse(url="/dashboard")
    return templates.TemplateResponse(
        request=request,
        name="login.html",
        context={"user": None, "error": error, "success": success}
    )

@app.post("/login")
def login(request: Request, username: str = Form(...), password: str = Form(...)):
    user = db.get_user_by_username(username)
    if not user or not db.verify_password(password, user['password_hash']):
        return RedirectResponse(url="/?error=Invalid+credentials", status_code=status.HTTP_303_SEE_OTHER)
    
    # Create signed session cookie
    signed_session = signer.sign(username.encode('utf-8')).decode('utf-8')
    
    redirect_url = "/admin" if user['role'] == 'admin' else "/dashboard"
    response = RedirectResponse(url=redirect_url, status_code=status.HTTP_303_SEE_OTHER)
    response.set_cookie(
        key="hub_session",
        value=signed_session,
        httponly=True,
        samesite="lax"
    )
    return response

@app.get("/logout")
def logout():
    response = RedirectResponse(url="/")
    response.delete_cookie("hub_session")
    return response

@app.get("/admin", response_class=HTMLResponse)
def admin_dashboard(request: Request, error: str = None, success: str = None, admin_user=Depends(require_admin)):
    users_list = db.list_users()
    
    # Enrich user list with dynamic status & url
    enriched_users = []
    host_ip = config.HOST_IP if config.HOST_IP else request.base_url.hostname
    
    for u in users_list:
        user_dict = dict(u)
        user_dict['is_running'] = spawner.is_session_running(u['username'])
        if user_dict['is_running'] and u['token']:
            user_dict['jupyter_url'] = f"http://{host_ip}:{u['port']}/lab?token={u['token']}"
        else:
            user_dict['jupyter_url'] = ""
        enriched_users.append(user_dict)
        
    return templates.TemplateResponse(
        request=request,
        name="admin.html",
        context={"user": admin_user, "users": enriched_users, "error": error, "success": success}
    )

@app.get("/dashboard", response_class=HTMLResponse)
def user_dashboard(request: Request, error: str = None, success: str = None, current_user=Depends(require_auth)):
    if current_user['role'] == 'admin':
        return RedirectResponse(url="/admin")
        
    username = current_user['username']
    is_running = spawner.is_session_running(username)
    host_ip = config.HOST_IP if config.HOST_IP else request.base_url.hostname
    
    jupyter_url = ""
    if is_running and current_user['token']:
        jupyter_url = f"http://{host_ip}:{current_user['port']}/lab?token={current_user['token']}"
        
    return templates.TemplateResponse(
        request=request,
        name="dashboard.html",
        context={
            "user": current_user, 
            "is_running": is_running, 
            "user_port": current_user['port'],
            "jupyter_url": jupyter_url,
            "error": error,
            "success": success
        }
    )

# --- Admin API Routes ---

@app.post("/admin/users")
def admin_create_user(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    admin_user=Depends(require_admin)
):
    # Validate username length/charset
    if not username.isalnum() and "_" not in username and "-" not in username:
        return RedirectResponse(url="/admin?error=Username+must+be+alphanumeric", status_code=status.HTTP_303_SEE_OTHER)
        
    port = spawner.get_next_port()
    if not port:
        return RedirectResponse(url="/admin?error=No+available+ports+left+(limit+9)", status_code=status.HTTP_303_SEE_OTHER)
        
    # Attempt to create in DB
    created = db.create_user(username, password, role='user', port=port)
    if not created:
        return RedirectResponse(url="/admin?error=Username+already+exists", status_code=status.HTTP_303_SEE_OTHER)
        
    # Setup venv in background/sync
    success = spawner.setup_user_env(username)
    if not success:
        db.delete_user(username)
        return RedirectResponse(url="/admin?error=Failed+to+initialize+venv+for+user", status_code=status.HTTP_303_SEE_OTHER)
        
    return RedirectResponse(url=f"/admin?success=Created+user+{username}", status_code=status.HTTP_303_SEE_OTHER)

@app.post("/admin/users/{username}")
def admin_delete_user(
    username: str,
    delete_files: str = Form(None),
    admin_user=Depends(require_admin)
):
    # 1. Stop session
    spawner.stop_session(username)
    
    # 2. Optionally delete files
    if delete_files == "true":
        spawner.cleanup_user_files(username)
        msg = f"Deleted+user+{username}+and+all+files"
    else:
        msg = f"Deleted+user+{username}+(files+preserved)"
        
    # 3. Delete from DB
    db.delete_user(username)
    
    return RedirectResponse(url=f"/admin?success={msg}", status_code=status.HTTP_303_SEE_OTHER)

# --- Admin Session Controls ---

@app.post("/admin/session/start/{username}")
def admin_start_session(username: str, admin_user=Depends(require_admin)):
    user = db.get_user_by_username(username)
    if not user:
        return RedirectResponse(url="/admin?error=User+not+found", status_code=status.HTTP_303_SEE_OTHER)
        
    port = user['port']
    token = secrets.token_urlsafe(16)
    
    success = spawner.spawn_session(username, port, token)
    if not success:
        return RedirectResponse(url=f"/admin?error=Failed+to+start+session+for+{username}", status_code=status.HTTP_303_SEE_OTHER)
        
    db.update_token(username, token)
    return RedirectResponse(url=f"/admin?success=JupyterLab+started+for+{username}", status_code=status.HTTP_303_SEE_OTHER)

@app.post("/admin/session/stop/{username}")
def admin_stop_session(username: str, admin_user=Depends(require_admin)):
    user = db.get_user_by_username(username)
    if not user:
        return RedirectResponse(url="/admin?error=User+not+found", status_code=status.HTTP_303_SEE_OTHER)
        
    success = spawner.stop_session(username)
    if not success:
        return RedirectResponse(url=f"/admin?error=Failed+to+stop+session+for+{username}", status_code=status.HTTP_303_SEE_OTHER)
        
    db.update_token(username, None)
    return RedirectResponse(url=f"/admin?success=JupyterLab+stopped+for+{username}", status_code=status.HTTP_303_SEE_OTHER)

@app.post("/admin/session/restart/{username}")
def admin_restart_session(username: str, admin_user=Depends(require_admin)):
    user = db.get_user_by_username(username)
    if not user:
        return RedirectResponse(url="/admin?error=User+not+found", status_code=status.HTTP_303_SEE_OTHER)
        
    port = user['port']
    token = secrets.token_urlsafe(16)
    
    # Stop first
    spawner.stop_session(username)
    # Start again
    success = spawner.spawn_session(username, port, token)
    if not success:
        db.update_token(username, None)
        return RedirectResponse(url=f"/admin?error=Failed+to+restart+session+for+{username}", status_code=status.HTTP_303_SEE_OTHER)
        
    db.update_token(username, token)
    return RedirectResponse(url=f"/admin?success=JupyterLab+restarted+for+{username}", status_code=status.HTTP_303_SEE_OTHER)

# --- User Session Controls ---

@app.post("/session/start")
def user_start_session(current_user=Depends(require_auth)):
    if current_user['role'] == 'admin':
        return RedirectResponse(url="/admin")
        
    username = current_user['username']
    port = current_user['port']
    
    # Generate new token
    token = secrets.token_urlsafe(16)
    
    success = spawner.spawn_session(username, port, token)
    if not success:
        return RedirectResponse(url="/dashboard?error=Failed+to+start+JupyterLab+session", status_code=status.HTTP_303_SEE_OTHER)
        
    db.update_token(username, token)
    return RedirectResponse(url="/dashboard?success=JupyterLab+started", status_code=status.HTTP_303_SEE_OTHER)

@app.post("/session/stop")
def user_stop_session(current_user=Depends(require_auth)):
    if current_user['role'] == 'admin':
        return RedirectResponse(url="/admin")
        
    username = current_user['username']
    success = spawner.stop_session(username)
    if not success:
        return RedirectResponse(url="/dashboard?error=Failed+to+stop+JupyterLab+session", status_code=status.HTTP_303_SEE_OTHER)
        
    db.update_token(username, None)
    return RedirectResponse(url="/dashboard?success=JupyterLab+stopped", status_code=status.HTTP_303_SEE_OTHER)

@app.post("/session/restart")
def user_restart_session(current_user=Depends(require_auth)):
    if current_user['role'] == 'admin':
        return RedirectResponse(url="/admin")
        
    username = current_user['username']
    port = current_user['port']
    token = secrets.token_urlsafe(16)
    
    # Stop first
    spawner.stop_session(username)
    # Start again
    success = spawner.spawn_session(username, port, token)
    if not success:
        db.update_token(username, None)
        return RedirectResponse(url="/dashboard?error=Failed+to+restart+JupyterLab+session", status_code=status.HTTP_303_SEE_OTHER)
        
    db.update_token(username, token)
    return RedirectResponse(url="/dashboard?success=JupyterLab+restarted", status_code=status.HTTP_303_SEE_OTHER)

# Catch redirection exceptions and map them to HTTP responses
@app.exception_handler(HTTPException)
def http_exception_handler(request: Request, exc: HTTPException):
    if exc.status_code == status.HTTP_307_TEMPORARY_REDIRECT:
        return RedirectResponse(url=exc.headers.get("Location"))
    raise exc
