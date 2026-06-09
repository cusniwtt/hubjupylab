import secrets
import os
from pathlib import Path
from fastapi import FastAPI, Request, Form, Depends, HTTPException, status, Response
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from itsdangerous import Signer, BadSignature
import config
import db
import spawner
import gpu

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

def _build_admin_user_context(username: str, request: Request = None):
    user = db.get_user_by_username(username)
    if not user:
        return None
    user_dict = dict(user)
    user_dict['is_running'] = spawner.is_session_running(username)
    if user_dict['is_running'] and user['token']:
        host_ip = config.HOST_IP
        if not host_ip:
            host_ip = request.base_url.hostname if request else "127.0.0.1"
        user_dict['jupyter_url'] = f"http://{host_ip}:{user['port']}/lab?token={user['token']}"
    else:
        user_dict['jupyter_url'] = ""
    return user_dict

def _get_enriched_users(request: Request = None):
    users_list = db.list_users()
    enriched_users = []
    host_ip = config.HOST_IP
    if not host_ip:
        host_ip = request.base_url.hostname if request else "127.0.0.1"
    for u in users_list:
        user_dict = dict(u)
        user_dict['is_running'] = spawner.is_session_running(u['username'])
        if user_dict['is_running'] and u['token']:
            user_dict['jupyter_url'] = f"http://{host_ip}:{u['port']}/lab?token={u['token']}"
        else:
            user_dict['jupyter_url'] = ""
        enriched_users.append(user_dict)
    return enriched_users

@app.get("/admin/partials/gpu-select")
def admin_gpu_select_partial(request: Request, admin_user=Depends(require_admin)):
    users = db.list_users()
    return templates.TemplateResponse(
        request=request,
        name="partials/_admin_gpu_select.html",
        context={"users": users}
    )

@app.get("/admin/users/row/{username}")
def admin_user_row(username: str, request: Request, admin_user=Depends(require_admin)):
    enriched = _build_admin_user_context(username, request)
    if not enriched:
        raise HTTPException(status_code=404, detail="User not found")
    return templates.TemplateResponse(
        request=request,
        name="partials/_admin_user_row.html",
        context={"u": enriched}
    )


@app.get("/admin/users/status-poll")
def admin_users_status_poll(request: Request, admin_user=Depends(require_admin)):
    enriched_users = _get_enriched_users(request)
    return templates.TemplateResponse(
        request=request,
        name="partials/_admin_user_table_body.html",
        context={
            "users": enriched_users,
            "is_poll": True
        }
    )



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
        
    has_gpu = bool(current_user['gpu_endpoint'])
    gpu_endpoint = current_user['gpu_endpoint'] or ""

    return templates.TemplateResponse(
        request=request,
        name="dashboard.html",
        context={
            "user": current_user, 
            "is_running": is_running, 
            "user_port": current_user['port'],
            "jupyter_url": jupyter_url,
            "error": error,
            "success": success,
            "has_gpu": has_gpu,
            "gpu_endpoint": gpu_endpoint
        }
    )

# --- Admin API Routes ---

@app.post("/admin/users")
def admin_create_user(
    username: str = Form(...),
    password: str = Form(...),
    request: Request = None,
    admin_user=Depends(require_admin)
):
    # Validate username length/charset
    if not username.isalnum() and "_" not in username and "-" not in username:
        if request and request.headers.get("HX-Request") == "true":
            response = Response(status_code=422)
            response.headers["HX-Trigger"] = '{"showToast": {"message": "Username must be alphanumeric", "type": "error"}}'
            return response
        return RedirectResponse(url="/admin?error=Username+must+be+alphanumeric", status_code=status.HTTP_303_SEE_OTHER)
        
    port = spawner.get_next_port()
    if not port:
        if request and request.headers.get("HX-Request") == "true":
            response = Response(status_code=422)
            response.headers["HX-Trigger"] = '{"showToast": {"message": "No available ports left (limit 9)", "type": "error"}}'
            return response
        return RedirectResponse(url="/admin?error=No+available+ports+left+(limit+9)", status_code=status.HTTP_303_SEE_OTHER)
        
    # Attempt to create in DB
    created = db.create_user(username, password, role='user', port=port)
    if not created:
        if request and request.headers.get("HX-Request") == "true":
            response = Response(status_code=422)
            response.headers["HX-Trigger"] = '{"showToast": {"message": "Username already exists", "type": "error"}}'
            return response
        return RedirectResponse(url="/admin?error=Username+already+exists", status_code=status.HTTP_303_SEE_OTHER)
        
    # Setup venv in background/sync
    success = spawner.setup_user_env(username)
    if not success:
        db.delete_user(username)
        if request and request.headers.get("HX-Request") == "true":
            response = Response(status_code=422)
            response.headers["HX-Trigger"] = '{"showToast": {"message": "Failed to initialize venv for user", "type": "error"}}'
            return response
        return RedirectResponse(url="/admin?error=Failed+to+initialize+venv+for+user", status_code=status.HTTP_303_SEE_OTHER)
        
    if request and request.headers.get("HX-Request") == "true":
        enriched = _get_enriched_users(request)
        response = templates.TemplateResponse(
            request=request,
            name="partials/_admin_user_table_body.html",
            context={"users": enriched}
        )
        response.headers["HX-Trigger"] = '{"showToast": {"message": "Created user ' + username + '", "type": "success"}, "userListUpdated": null}'
        return response
        
    return RedirectResponse(url=f"/admin?success=Created+user+{username}", status_code=status.HTTP_303_SEE_OTHER)

@app.post("/admin/users/{username}")
def admin_delete_user(
    username: str,
    delete_files: str = Form(None),
    request: Request = None,
    admin_user=Depends(require_admin)
):
    # 1. Stop session
    spawner.stop_session(username)
    
    # 2. Optionally delete files
    if delete_files == "true":
        spawner.cleanup_user_files(username)
        msg = f"Deleted user {username} and all files"
    else:
        msg = f"Deleted user {username} (files preserved)"
        
    # 3. Delete from DB
    db.delete_user(username)
    
    if request and request.headers.get("HX-Request") == "true":
        response = Response(content="")
        response.headers["HX-Trigger"] = '{"showToast": {"message": "' + msg + '", "type": "success"}, "userListUpdated": null}'
        return response
        
    import urllib.parse
    return RedirectResponse(url=f"/admin?success={urllib.parse.quote_plus(msg)}", status_code=status.HTTP_303_SEE_OTHER)

# --- Admin Session Controls ---

@app.post("/admin/session/start/{username}")
def admin_start_session(username: str, request: Request = None, admin_user=Depends(require_admin)):
    user = db.get_user_by_username(username)
    if not user:
        if request and request.headers.get("HX-Request") == "true":
            response = Response(status_code=404)
            response.headers["HX-Trigger"] = '{"showToast": {"message": "User not found", "type": "error"}}'
            return response
        return RedirectResponse(url="/admin?error=User+not+found", status_code=status.HTTP_303_SEE_OTHER)
        
    port = user['port']
    token = secrets.token_urlsafe(16)
    
    success = spawner.spawn_session(username, port, token)
    if not success:
        if request and request.headers.get("HX-Request") == "true":
            response = Response(status_code=500)
            response.headers["HX-Trigger"] = '{"showToast": {"message": "Failed to start session for ' + username + '", "type": "error"}}'
            return response
        return RedirectResponse(url=f"/admin?error=Failed+to+start+session+for+{username}", status_code=status.HTTP_303_SEE_OTHER)
        
    db.update_token(username, token)
    
    if request and request.headers.get("HX-Request") == "true":
        enriched = _build_admin_user_context(username, request)
        response = templates.TemplateResponse(
            request=request,
            name="partials/_admin_user_row.html",
            context={"u": enriched}
        )
        response.headers["HX-Trigger"] = '{"showToast": {"message": "JupyterLab started for ' + username + '", "type": "success"}}'
        return response
        
    return RedirectResponse(url=f"/admin?success=JupyterLab+started+for+{username}", status_code=status.HTTP_303_SEE_OTHER)

@app.post("/admin/session/stop/{username}")
def admin_stop_session(username: str, request: Request = None, admin_user=Depends(require_admin)):
    user = db.get_user_by_username(username)
    if not user:
        if request and request.headers.get("HX-Request") == "true":
            response = Response(status_code=404)
            response.headers["HX-Trigger"] = '{"showToast": {"message": "User not found", "type": "error"}}'
            return response
        return RedirectResponse(url="/admin?error=User+not+found", status_code=status.HTTP_303_SEE_OTHER)
        
    success = spawner.stop_session(username)
    if not success:
        if request and request.headers.get("HX-Request") == "true":
            response = Response(status_code=500)
            response.headers["HX-Trigger"] = '{"showToast": {"message": "Failed to stop session for ' + username + '", "type": "error"}}'
            return response
        return RedirectResponse(url=f"/admin?error=Failed+to+stop+session+for+{username}", status_code=status.HTTP_303_SEE_OTHER)
        
    db.update_token(username, None)
    
    if request and request.headers.get("HX-Request") == "true":
        enriched = _build_admin_user_context(username, request)
        response = templates.TemplateResponse(
            request=request,
            name="partials/_admin_user_row.html",
            context={"u": enriched}
        )
        response.headers["HX-Trigger"] = '{"showToast": {"message": "JupyterLab stopped for ' + username + '", "type": "success"}}'
        return response
        
    return RedirectResponse(url=f"/admin?success=JupyterLab+stopped+for+{username}", status_code=status.HTTP_303_SEE_OTHER)

@app.post("/admin/session/restart/{username}")
def admin_restart_session(username: str, request: Request = None, admin_user=Depends(require_admin)):
    user = db.get_user_by_username(username)
    if not user:
        if request and request.headers.get("HX-Request") == "true":
            response = Response(status_code=404)
            response.headers["HX-Trigger"] = '{"showToast": {"message": "User not found", "type": "error"}}'
            return response
        return RedirectResponse(url="/admin?error=User+not+found", status_code=status.HTTP_303_SEE_OTHER)
        
    port = user['port']
    token = secrets.token_urlsafe(16)
    
    # Stop first
    spawner.stop_session(username)
    # Start again
    success = spawner.spawn_session(username, port, token)
    if not success:
        db.update_token(username, None)
        if request and request.headers.get("HX-Request") == "true":
            response = Response(status_code=500)
            response.headers["HX-Trigger"] = '{"showToast": {"message": "Failed to restart session for ' + username + '", "type": "error"}}'
            return response
        return RedirectResponse(url=f"/admin?error=Failed+to+restart+session+for+{username}", status_code=status.HTTP_303_SEE_OTHER)
        
    db.update_token(username, token)
    
    if request and request.headers.get("HX-Request") == "true":
        enriched = _build_admin_user_context(username, request)
        response = templates.TemplateResponse(
            request=request,
            name="partials/_admin_user_row.html",
            context={"u": enriched}
        )
        response.headers["HX-Trigger"] = '{"showToast": {"message": "JupyterLab restarted for ' + username + '", "type": "success"}}'
        return response
        
    return RedirectResponse(url=f"/admin?success=JupyterLab+restarted+for+{username}", status_code=status.HTTP_303_SEE_OTHER)

# --- User Session Controls ---

@app.post("/session/start")
def user_start_session(request: Request, current_user=Depends(require_auth)):
    if current_user['role'] == 'admin':
        return RedirectResponse(url="/admin")
        
    username = current_user['username']
    port = current_user['port']
    host_ip = config.HOST_IP if config.HOST_IP else request.base_url.hostname
    
    # Generate new token
    token = secrets.token_urlsafe(16)
    
    success = spawner.spawn_session(username, port, token)
    if not success:
        if request.headers.get("HX-Request") == "true":
            is_running = spawner.is_session_running(username)
            jupyter_url = ""
            if is_running and current_user['token']:
                jupyter_url = f"http://{host_ip}:{port}/lab?token={current_user['token']}"
            response = templates.TemplateResponse(
                request=request,
                name="partials/_dashboard_status.html",
                context={
                    "is_running": is_running,
                    "user_port": port,
                    "jupyter_url": jupyter_url
                }
            )
            response.headers["HX-Trigger"] = '{"showToast": {"message": "Failed to start JupyterLab session", "type": "error"}}'
            return response
        return RedirectResponse(url="/dashboard?error=Failed+to+start+JupyterLab+session", status_code=status.HTTP_303_SEE_OTHER)
        
    db.update_token(username, token)
    
    if request.headers.get("HX-Request") == "true":
        jupyter_url = f"http://{host_ip}:{port}/lab?token={token}"
        response = templates.TemplateResponse(
            request=request,
            name="partials/_dashboard_status.html",
            context={
                "is_running": True,
                "user_port": port,
                "jupyter_url": jupyter_url
            }
        )
        response.headers["HX-Trigger"] = '{"showToast": {"message": "JupyterLab started", "type": "success"}}'
        return response
    return RedirectResponse(url="/dashboard?success=JupyterLab+started", status_code=status.HTTP_303_SEE_OTHER)

@app.post("/session/stop")
def user_stop_session(request: Request, current_user=Depends(require_auth)):
    if current_user['role'] == 'admin':
        return RedirectResponse(url="/admin")
        
    username = current_user['username']
    port = current_user['port']
    host_ip = config.HOST_IP if config.HOST_IP else request.base_url.hostname
    
    success = spawner.stop_session(username)
    if not success:
        if request.headers.get("HX-Request") == "true":
            is_running = spawner.is_session_running(username)
            jupyter_url = ""
            if is_running and current_user['token']:
                jupyter_url = f"http://{host_ip}:{port}/lab?token={current_user['token']}"
            response = templates.TemplateResponse(
                request=request,
                name="partials/_dashboard_status.html",
                context={
                    "is_running": is_running,
                    "user_port": port,
                    "jupyter_url": jupyter_url
                }
            )
            response.headers["HX-Trigger"] = '{"showToast": {"message": "Failed to stop JupyterLab session", "type": "error"}}'
            return response
        return RedirectResponse(url="/dashboard?error=Failed+to+stop+JupyterLab+session", status_code=status.HTTP_303_SEE_OTHER)
        
    db.update_token(username, None)
    
    if request.headers.get("HX-Request") == "true":
        response = templates.TemplateResponse(
            request=request,
            name="partials/_dashboard_status.html",
            context={
                "is_running": False,
                "user_port": port,
                "jupyter_url": ""
            }
        )
        response.headers["HX-Trigger"] = '{"showToast": {"message": "JupyterLab stopped", "type": "success"}}'
        return response
    return RedirectResponse(url="/dashboard?success=JupyterLab+stopped", status_code=status.HTTP_303_SEE_OTHER)

@app.post("/session/restart")
def user_restart_session(request: Request, current_user=Depends(require_auth)):
    if current_user['role'] == 'admin':
        return RedirectResponse(url="/admin")
        
    username = current_user['username']
    port = current_user['port']
    host_ip = config.HOST_IP if config.HOST_IP else request.base_url.hostname
    token = secrets.token_urlsafe(16)
    
    # Stop first
    spawner.stop_session(username)
    # Start again
    success = spawner.spawn_session(username, port, token)
    if not success:
        db.update_token(username, None)
        if request.headers.get("HX-Request") == "true":
            response = templates.TemplateResponse(
                request=request,
                name="partials/_dashboard_status.html",
                context={
                    "is_running": False,
                    "user_port": port,
                    "jupyter_url": ""
                }
            )
            response.headers["HX-Trigger"] = '{"showToast": {"message": "Failed to restart JupyterLab session", "type": "error"}}'
            return response
        return RedirectResponse(url="/dashboard?error=Failed+to+restart+JupyterLab+session", status_code=status.HTTP_303_SEE_OTHER)
        
    db.update_token(username, token)
    
    if request.headers.get("HX-Request") == "true":
        jupyter_url = f"http://{host_ip}:{port}/lab?token={token}"
        response = templates.TemplateResponse(
            request=request,
            name="partials/_dashboard_status.html",
            context={
                "is_running": True,
                "user_port": port,
                "jupyter_url": jupyter_url
            }
        )
        response.headers["HX-Trigger"] = '{"showToast": {"message": "JupyterLab restarted", "type": "success"}}'
        return response
    return RedirectResponse(url="/dashboard?success=JupyterLab+restarted", status_code=status.HTTP_303_SEE_OTHER)


@app.get("/session/status")
def user_session_status(request: Request, current_user=Depends(require_auth)):
    username = current_user['username']
    port = current_user['port']
    host_ip = config.HOST_IP if config.HOST_IP else request.base_url.hostname
    is_running = spawner.is_session_running(username)
    
    jupyter_url = ""
    if is_running and current_user['token']:
        jupyter_url = f"http://{host_ip}:{port}/lab?token={current_user['token']}"
        
    has_gpu = bool(current_user['gpu_endpoint'])
    gpu_endpoint = current_user['gpu_endpoint'] or ""
    gpu_init_status = current_user['gpu_init_status'] or ""
    gpu_token = current_user['gpu_token'] or ""
    
    return templates.TemplateResponse(
        request=request,
        name="partials/_dashboard_status.html",
        context={
            "is_running": is_running,
            "user_port": port,
            "jupyter_url": jupyter_url,
            "has_gpu": has_gpu,
            "gpu_endpoint": gpu_endpoint,
            "gpu_init_status": gpu_init_status,
            "gpu_token": gpu_token,
            "user": current_user
        }
    )


@app.post("/admin/gpu/assign/{username}")
def admin_gpu_assign(
    username: str,
    request: Request = None,
    gpu_ssh_host: str = Form(""),
    gpu_ssh_port: int = Form(22),
    gpu_endpoint: str = Form(""),
    gpu_token: str = Form(""),
    admin_user=Depends(require_admin)
):
    user = db.get_user_by_username(username)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
        
    # Preserve current token if not supplied
    token_to_save = gpu_token if gpu_token else user['gpu_token']
    
    db.assign_gpu(username, gpu_endpoint, token_to_save, gpu_ssh_host, gpu_ssh_port)
    
    if request and request.headers.get("HX-Request") == "true":
        enriched = _build_admin_user_context(username, request)
        response = templates.TemplateResponse(
            request=request,
            name="partials/_admin_user_row.html",
            context={"u": enriched}
        )
        response.headers["HX-Trigger"] = '{"showToast": {"message": "GPU assigned to ' + username + '", "type": "success"}, "userListUpdated": null}'
        return response
    return RedirectResponse(url=f"/admin?success=GPU+assigned+to+{username}", status_code=status.HTTP_303_SEE_OTHER)

@app.post("/admin/gpu/unassign/{username}")
def admin_gpu_unassign(username: str, request: Request = None, admin_user=Depends(require_admin)):
    db.unassign_gpu(username)
    if request and request.headers.get("HX-Request") == "true":
        enriched = _build_admin_user_context(username, request)
        response = templates.TemplateResponse(
            request=request,
            name="partials/_admin_user_row.html",
            context={"u": enriched}
        )
        response.headers["HX-Trigger"] = '{"showToast": {"message": "GPU configuration removed for ' + username + '", "type": "success"}, "userListUpdated": null}'
        return response
    return RedirectResponse(url=f"/admin?success=GPU+configuration+removed+for+{username}", status_code=status.HTTP_303_SEE_OTHER)

@app.get("/admin/gpu/last-log/{username}")
def admin_gpu_last_log(username: str, admin_user=Depends(require_admin)):
    log_content = gpu.get_last_gpu_log(username)
    return Response(content=log_content, media_type="text/plain")



# --- GPU Management & Sync ---

@app.get("/admin/gpu/init-stream/{username}")
def admin_gpu_init_stream(username: str, admin_user=Depends(require_admin)):
    user = db.get_user_by_username(username)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user['gpu_init_status'] == 'running':
        def already_running():
            yield "data: Error: Initialization already in progress\n\n"
        return StreamingResponse(already_running(), media_type="text/event-stream")
        
    ssh_host = user['gpu_ssh_host']
    ssh_port = user['gpu_ssh_port'] or 22
    gpu_conf = db.get_gpu_config()
    
    if not ssh_host or not gpu_conf['ssh_key_path']:
        def not_configured():
            yield "data: Error: GPU SSH not configured\n\n"
        return StreamingResponse(not_configured(), media_type="text/event-stream")
        
    token = user['gpu_token']
    if not token:
        token = secrets.token_urlsafe(16)
        db.assign_gpu(username, user['gpu_endpoint'], token, ssh_host, ssh_port)
        
    return StreamingResponse(
        gpu.gpu_init_generator(
            username=username,
            host=ssh_host,
            port=ssh_port,
            key_path=gpu_conf['ssh_key_path'],
            ssh_user=gpu_conf['ssh_user'],
            token=token,
            endpoint=user['gpu_endpoint']
        ),
        media_type="text/event-stream"
    )

@app.post("/admin/gpu/stop/{username}")
def admin_stop_gpu(username: str, request: Request = None, admin_user=Depends(require_admin)):
    success, msg = gpu.stop_gpu_session(username)
    if request and request.headers.get("HX-Request") == "true":
        enriched = _build_admin_user_context(username, request)
        response = templates.TemplateResponse(
            request=request,
            name="partials/_admin_user_row.html",
            context={"u": enriched}
        )
        toast_type = "success" if success else "error"
        toast_msg = f"GPU session stopped for {username}" if success else msg
        response.headers["HX-Trigger"] = '{"showToast": {"message": "' + toast_msg + '", "type": "' + toast_type + '"}}'
        return response
    if success:
        return RedirectResponse(url=f"/admin?success=GPU+session+stopped+for+{username}", status_code=status.HTTP_303_SEE_OTHER)
    return RedirectResponse(url=f"/admin?error={msg}", status_code=status.HTTP_303_SEE_OTHER)

@app.post("/admin/gpu/reset/{username}")
def admin_reset_gpu(username: str, request: Request = None, admin_user=Depends(require_admin)):
    db.update_gpu_init_status(username, None)
    if request and request.headers.get("HX-Request") == "true":
        enriched = _build_admin_user_context(username, request)
        response = templates.TemplateResponse(
            request=request,
            name="partials/_admin_user_row.html",
            context={"u": enriched}
        )
        response.headers["HX-Trigger"] = '{"showToast": {"message": "GPU status reset for ' + username + '", "type": "success"}, "userListUpdated": null}'
        return response
    return RedirectResponse(url=f"/admin?success=GPU+status+reset+for+{username}", status_code=status.HTTP_303_SEE_OTHER)

@app.get("/admin/logs", response_class=HTMLResponse)
def admin_logs_page(request: Request, admin_user=Depends(require_admin)):
    gpu_logs_dir = Path(config.BASE_DIR) / ".gpu_logs"
    rsync_logs_dir = Path(config.BASE_DIR) / ".rsync_logs"
    
    logs = []
    
    if gpu_logs_dir.exists():
        for f in os.listdir(gpu_logs_dir):
            if f.endswith(".log"):
                file_path = gpu_logs_dir / f
                stat = file_path.stat()
                logs.append({
                    "name": f,
                    "type": "gpu-init",
                    "size": stat.st_size,
                    "mtime": stat.st_mtime
                })
                
    if rsync_logs_dir.exists():
        for f in os.listdir(rsync_logs_dir):
            if f.endswith(".log"):
                file_path = rsync_logs_dir / f
                stat = file_path.stat()
                logs.append({
                    "name": f,
                    "type": "rsync-to" if "rsync-to" in f else "rsync-from",
                    "size": stat.st_size,
                    "mtime": stat.st_mtime
                })
                
    logs.sort(key=lambda x: x["mtime"], reverse=True)
    
    return templates.TemplateResponse(
        request=request,
        name="logs.html",
        context={"user": admin_user, "logs": logs}
    )

@app.get("/admin/logs/view")
def admin_view_log(filename: str, admin_user=Depends(require_admin)):
    if ".." in filename or filename.startswith("/") or filename.startswith("\\"):
        raise HTTPException(status_code=400, detail="Invalid filename")
        
    gpu_logs_dir = Path(config.BASE_DIR) / ".gpu_logs"
    rsync_logs_dir = Path(config.BASE_DIR) / ".rsync_logs"
    
    file_path = gpu_logs_dir / filename
    if not file_path.exists():
        file_path = rsync_logs_dir / filename
        
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Log file not found")
        
    with open(file_path, "r") as f:
        content = f.read()
        
    return {"filename": filename, "content": content}

@app.get("/session/gpu/sync-to-stream")
def user_sync_to_stream(path: str = "", current_user=Depends(require_auth)):
    if current_user['role'] == 'admin':
        raise HTTPException(status_code=403, detail="Admins cannot sync workspaces")
    username = current_user['username']
    return StreamingResponse(
        gpu.rsync_to_gpu_generator(username, subpath=path),
        media_type="text/event-stream"
    )

@app.get("/session/gpu/sync-from-stream")
def user_sync_from_stream(path: str = "", current_user=Depends(require_auth)):
    if current_user['role'] == 'admin':
        raise HTTPException(status_code=403, detail="Admins cannot sync workspaces")
    username = current_user['username']
    return StreamingResponse(
        gpu.rsync_from_gpu_generator(username, subpath=path),
        media_type="text/event-stream"
    )

@app.get("/session/gpu/list-dirs")
def user_list_dirs(current_user=Depends(require_auth)):
    if current_user['role'] == 'admin':
        raise HTTPException(status_code=403, detail="Admins cannot view user directories")
    username = current_user['username']
    user_dir = Path(config.BASE_DIR) / username
    if not user_dir.exists():
        return []
    
    def get_directory_tree(path: Path, base_path: Path) -> list:
        tree = []
        try:
            items = sorted(path.iterdir(), key=lambda x: x.name.lower())
            for item in items:
                if item.is_dir():
                    if item.name in {'.git', '.venv', '__pycache__', '.ipynb_checkpoints'}:
                        continue
                    rel_path = str(item.relative_to(base_path))
                    tree.append({
                        "name": item.name,
                        "path": rel_path,
                        "children": get_directory_tree(item, base_path)
                    })
        except PermissionError:
            pass
        return tree

    return get_directory_tree(user_dir, user_dir)

# Catch redirection exceptions and map them to HTTP responses
@app.exception_handler(HTTPException)
def http_exception_handler(request: Request, exc: HTTPException):
    if exc.status_code == status.HTTP_307_TEMPORARY_REDIRECT:
        return RedirectResponse(url=exc.headers.get("Location"))
    raise exc
