import os
import shutil
import subprocess
import secrets
from pathlib import Path
import config
import db

def get_user_dir(username: str) -> Path:
    return Path(config.BASE_DIR) / username

def setup_user_env(username: str) -> bool:
    user_dir = get_user_dir(username)
    os.makedirs(user_dir, exist_ok=True)
    
    venv_dir = user_dir / ".venv"
    if not venv_dir.exists():
        # 1. Create venv using uv
        cmd_venv = ["uv", "venv", "--python", config.PYTHON_VERSION, str(venv_dir)]
        res_venv = subprocess.run(cmd_venv, capture_output=True, text=True)
        if res_venv.returncode != 0:
            print(f"Error creating venv for {username}: {res_venv.stderr}")
            return False
        
        # 2. Install jupyterlab using uv pip inside the venv
        uv_bin = venv_dir / "bin" / "uv"
        # If uv is not copied to venv, use active system uv with --venv option or direct path
        # Simplest: use uv pip install with --python pointing to venv interpreter
        python_bin = venv_dir / "bin" / "python"
        cmd_install = ["uv", "pip", "install", f"jupyterlab=={config.JUPYTERLAB_VERSION}", "--python", str(python_bin)]
        res_install = subprocess.run(cmd_install, capture_output=True, text=True)
        if res_install.returncode != 0:
            print(f"Error installing jupyterlab for {username}: {res_install.stderr}")
            return False
            
    return True

def get_session_name(username: str) -> str:
    return f"hub_{username}"

def is_session_running(username: str) -> bool:
    session_name = get_session_name(username)
    cmd = ["tmux", "has-session", "-t", session_name]
    res = subprocess.run(cmd, capture_output=True)
    return res.returncode == 0

def spawn_session(username: str, port: int, token: str) -> bool:
    if not setup_user_env(username):
        return False
        
    if is_session_running(username):
        stop_session(username)
        
    session_name = get_session_name(username)
    user_dir = get_user_dir(username)
    jupyter_bin = user_dir / ".venv" / "bin" / "jupyter"
    
    # Construct the jupyter lab startup command
    # cd into user_dir first so JupyterLab terminal opens in user's directory
    jupyter_cmd = (
        f"cd {user_dir} && "
        f"exec {jupyter_bin} lab "
        f"--ip=127.0.0.1 "
        f"--port={port} "
        f"--IdentityProvider.token={token} "
        f"--no-browser "
        f"--notebook-dir={user_dir}"
    )
    
    # Spawn via tmux
    # -d means detached
    # -s session_name
    # command is executed inside the shell in tmux session
    cmd = ["tmux", "new-session", "-d", "-s", session_name, jupyter_cmd]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        print(f"Error spawning tmux session for {username}: {res.stderr}")
        return False
        
    return True

def stop_session(username: str) -> bool:
    if not is_session_running(username):
        return True
    session_name = get_session_name(username)
    cmd = ["tmux", "kill-session", "-t", session_name]
    res = subprocess.run(cmd, capture_output=True)
    return res.returncode == 0

def cleanup_user_files(username: str):
    user_dir = get_user_dir(username)
    if user_dir.exists():
        shutil.rmtree(user_dir)

def get_next_port() -> int:
    used_ports = set(db.get_used_ports())
    for port in range(config.JUPYTER_PORT_START, config.JUPYTER_PORT_END + 1):
        if port not in used_ports:
            return port
    return None

def sync_sessions():
    """Startup reconciliation: check all DB users against running tmux sessions and update tokens if stopped."""
    users = db.list_users()
    for user in users:
        username = user['username']
        if not is_session_running(username) and user['token'] is not None:
            # Session died while hub was offline, clear token in DB
            db.update_token(username, None)
