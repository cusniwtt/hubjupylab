import os
import subprocess
from pathlib import Path
from datetime import datetime, timezone, timedelta
import db
import config

SSH_KEY_PATH = '/home/hubjupylab/.ssh/id_ed25519'
SSH_USER = 'root'
REMOTE_BASE_DIR = '/workspace'

def test_gpu_ssh(ssh_host: str = None, ssh_port: int = None) -> tuple[bool, str]:
    """Test SSH connectivity to GPU VM."""
    host = ssh_host
    port = ssh_port or 22

    if not host or not os.path.exists(SSH_KEY_PATH):
        return False, "GPU SSH not configured or key not found"

    cmd = [
        "ssh", "-p", str(port),
        "-i", SSH_KEY_PATH,
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=10",
        f"{SSH_USER}@{host}",
        "echo ok"
    ]

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return False, "SSH connection timed out"

    if res.returncode != 0:
        return False, f"SSH failed: {res.stderr}"

    return True, "SSH connection OK"

def stop_gpu_session(username: str) -> tuple[bool, str]:
    """Stop GPU session (tmux kill-session). Returns (success, message)."""
    user = db.get_user_by_username(username)
    if not user:
        return False, f"User {username} not found"
        
    ssh_host = user['gpu_ssh_host']
    ssh_port = user['gpu_ssh_port'] or 22
    
    if not ssh_host or not os.path.exists(SSH_KEY_PATH):
        return False, "GPU SSH not configured for user"
        
    cmd = [
        "ssh", "-p", str(ssh_port),
        "-i", SSH_KEY_PATH,
        "-o", "StrictHostKeyChecking=no",
        f"{SSH_USER}@{ssh_host}",
        f"tmux kill-session -t gpu_{username}"
    ]
    
    try:
        subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        db.update_gpu_init_status(username, 'stopped')
        return True, "GPU session stopped"
    except Exception as e:
        return False, f"Failed to stop GPU session: {str(e)}"

def gpu_init_generator(username: str, host: str, port: int, key_path: str, ssh_user: str, token: str, endpoint: str):
    """Generator that runs the GPU initialization steps via SSH and streams progress."""
    now_tz7 = datetime.now(timezone(timedelta(hours=7)))
    timestamp = now_tz7.strftime("%Y%m%d-%H%M%S")
    log_dir = Path(config.BASE_DIR) / ".gpu_logs"
    os.makedirs(log_dir, exist_ok=True)
    log_file_path = log_dir / f"{username}-{timestamp}-gpu.log"
    
    db.update_gpu_init_status(username, 'running')
    
    with open(log_file_path, "w") as log_file:
        def log_and_yield(message: str):
            ts = datetime.now(timezone(timedelta(hours=7))).strftime("%Y-%m-%d %H:%M:%S")
            line = f"[{ts}] {message}\n"
            log_file.write(line)
            log_file.flush()
            return f"data: {message}\n\n"

        yield log_and_yield("Starting GPU initialization...")
        
        # Test basic connection first
        success, msg = test_gpu_ssh(host, port)
        if not success:
            log_and_yield(f"SSH connection test failed: {msg}")
            db.update_gpu_init_status(username, 'failed')
            yield log_and_yield("Initialization FAILED")
            return
            
        log_and_yield("SSH connection OK. Beginning environment setup.")

        def run_step(step_name: str, remote_cmd: str):
            yield log_and_yield(f"--- {step_name} ---")
            ssh_cmd = [
                "ssh", "-p", str(port),
                "-i", key_path,
                "-o", "StrictHostKeyChecking=no",
                f"{ssh_user}@{host}",
                remote_cmd
            ]
            process = subprocess.Popen(
                ssh_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1
            )
            for line in process.stdout:
                yield log_and_yield(f"  [{step_name}] {line.rstrip()}")
            process.wait()
            if process.returncode != 0:
                raise Exception(f"{step_name} failed with exit status {process.returncode}")

        try:
            # 1. apt update
            for output in run_step("apt-update", "apt-get update -y"):
                yield output
                
            # 2. install tmux, vim, btop, rsync
            for output in run_step("apt-install", "apt-get install -y tmux vim btop rsync"):
                yield output
                
            # 3. install uv
            for output in run_step("install-uv", "curl -LsSf https://astral.sh/uv/install.sh | sh"):
                yield output
                
            # 4. mkdir /workspace/{username}
            for output in run_step("mkdir-workspace", f"mkdir -p {REMOTE_BASE_DIR}/{username}"):
                yield output
                
            # 5. create uv venv
            for output in run_step("create-venv", f"$HOME/.local/bin/uv venv --clear --python {config.PYTHON_VERSION} {REMOTE_BASE_DIR}/{username}/.venv"):
                yield output
                
            # 6. install jupyterlab
            for output in run_step("install-jupyter", f"$HOME/.local/bin/uv pip install jupyterlab=={config.JUPYTERLAB_VERSION} --python {REMOTE_BASE_DIR}/{username}/.venv/bin/python"):
                yield output
                
            # 7. kill existing tmux session if any
            for output in run_step("kill-existing-tmux", f"tmux kill-session -t gpu_{username} 2>/dev/null || true"):
                yield output
                
            # 8. spawn jupyterlab inside tmux
            jupyter_cmd = (
                f"cd {REMOTE_BASE_DIR}/{username} && "
                f"exec {REMOTE_BASE_DIR}/{username}/.venv/bin/jupyter lab "
                f"--no-browser "
                f"--port=8888 "
                f"--ServerApp.allow_origin='{endpoint}' "
                f"--ip=0.0.0.0 "
                f"--allow-root "
                f"--IdentityProvider.token={token} "
                f"--notebook-dir={REMOTE_BASE_DIR}/{username}"
            )
            spawn_cmd = f'tmux new-session -d -s gpu_{username} "{jupyter_cmd}"'
            for output in run_step("spawn-jupyter", spawn_cmd):
                yield output
                
            # 9. verify tmux session exists
            for output in run_step("verify-tmux", f"tmux has-session -t gpu_{username}"):
                yield output

        except Exception as e:
            log_and_yield(f"Error: {str(e)}")
            db.update_gpu_init_status(username, 'failed')
            yield log_and_yield("Initialization FAILED")
            return

        db.update_gpu_init_status(username, 'ready')
        yield log_and_yield("Initialization SUCCESSFUL! GPU JupyterLab is now running.")

def rsync_to_gpu_generator(username: str):
    """Generator that runs rsync to upload workspace to GPU VM."""
    now_tz7 = datetime.now(timezone(timedelta(hours=7)))
    timestamp = now_tz7.strftime("%Y%m%d-%H%M%S")
    log_dir = Path(config.BASE_DIR) / ".rsync_logs"
    os.makedirs(log_dir, exist_ok=True)
    log_file_path = log_dir / f"{username}-{timestamp}-rsync-to.log"
    
    user = db.get_user_by_username(username)
    if not user:
        yield "data: Error: User not found\n\n"
        return

    ssh_host = user['gpu_ssh_host']
    ssh_port = user['gpu_ssh_port'] or 22
    
    if not ssh_host or not os.path.exists(SSH_KEY_PATH):
        yield "data: Error: GPU SSH not configured\n\n"
        return

    user_dir = Path(config.BASE_DIR) / username
    if not user_dir.exists():
        yield "data: Error: User directory not found\n\n"
        return

    remote_path = f"{SSH_USER}@{ssh_host}:{REMOTE_BASE_DIR}/{username}/"

    # Pre-create remote directory via ssh
    mkdir_cmd = [
        "ssh", "-p", str(ssh_port),
        "-i", SSH_KEY_PATH,
        "-o", "StrictHostKeyChecking=no",
        f"{SSH_USER}@{ssh_host}",
        f"mkdir -p {REMOTE_BASE_DIR}/{username}/"
    ]
    subprocess.run(mkdir_cmd, capture_output=True)

    cmd = [
        "rsync", "-avz", "--delete", "-P",
        "--exclude", ".venv/",
        "--exclude", "__pycache__/",
        "-e", f"ssh -p {ssh_port} -i {SSH_KEY_PATH} -o StrictHostKeyChecking=no",
        f"{user_dir}/",
        remote_path
    ]

    with open(log_file_path, "w") as log_file:
        def log_and_yield(message: str):
            ts = datetime.now(timezone(timedelta(hours=7))).strftime("%Y-%m-%d %H:%M:%S")
            line = f"[{ts}] {message}\n"
            log_file.write(line)
            log_file.flush()
            return f"data: {message}\n\n"

        yield log_and_yield("Starting rsync to GPU...")
        
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        
        for line in process.stdout:
            yield log_and_yield(line.rstrip())
            
        process.wait()
        
        if process.returncode == 0:
            yield log_and_yield("Sync complete SUCCESS")
        else:
            yield log_and_yield(f"Sync failed with exit code {process.returncode}")

def rsync_from_gpu_generator(username: str):
    """Generator that runs rsync to download workspace from GPU VM."""
    now_tz7 = datetime.now(timezone(timedelta(hours=7)))
    timestamp = now_tz7.strftime("%Y%m%d-%H%M%S")
    log_dir = Path(config.BASE_DIR) / ".rsync_logs"
    os.makedirs(log_dir, exist_ok=True)
    log_file_path = log_dir / f"{username}-{timestamp}-rsync-from.log"
    
    user = db.get_user_by_username(username)
    if not user:
        yield "data: Error: User not found\n\n"
        return

    ssh_host = user['gpu_ssh_host']
    ssh_port = user['gpu_ssh_port'] or 22
    
    if not ssh_host or not os.path.exists(SSH_KEY_PATH):
        yield "data: Error: GPU SSH not configured\n\n"
        return

    user_dir = Path(config.BASE_DIR) / username
    if not user_dir.exists():
        yield "data: Error: User directory not found\n\n"
        return

    remote_path = f"{SSH_USER}@{ssh_host}:{REMOTE_BASE_DIR}/{username}/"

    cmd = [
        "rsync", "-avz", "--delete", "-P",
        "--exclude", ".venv/",
        "--exclude", "__pycache__/",
        "-e", f"ssh -p {ssh_port} -i {SSH_KEY_PATH} -o StrictHostKeyChecking=no",
        remote_path,
        f"{user_dir}/"
    ]

    with open(log_file_path, "w") as log_file:
        def log_and_yield(message: str):
            ts = datetime.now(timezone(timedelta(hours=7))).strftime("%Y-%m-%d %H:%M:%S")
            line = f"[{ts}] {message}\n"
            log_file.write(line)
            log_file.flush()
            return f"data: {message}\n\n"

        yield log_and_yield("Starting rsync from GPU...")
        
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1
        )
        
        for line in process.stdout:
            yield log_and_yield(line.rstrip())
            
        process.wait()
        
        if process.returncode == 0:
            yield log_and_yield("Sync back complete SUCCESS")
        else:
            yield log_and_yield(f"Sync back failed with exit status {process.returncode}")

def rsync_user_to_gpu(username: str) -> tuple[bool, str]:
    """Compatibility wrapper using rsync generator."""
    success = True
    msg = ""
    for chunk in rsync_to_gpu_generator(username):
        content = chunk.replace("data: ", "").strip()
        if "Error:" in content or "failed" in content:
            success = False
            msg = content
        elif "Sync complete SUCCESS" in content:
            msg = "Sync complete"
    if not msg:
        msg = "Sync complete" if success else "rsync failed"
    return success, msg

def rsync_gpu_to_user(username: str) -> tuple[bool, str]:
    """Compatibility wrapper using rsync generator."""
    success = True
    msg = ""
    for chunk in rsync_from_gpu_generator(username):
        content = chunk.replace("data: ", "").strip()
        if "Error:" in content or "failed" in content:
            success = False
            msg = content
        elif "Sync back complete SUCCESS" in content:
            msg = "Sync back complete"
    if not msg:
        msg = "Sync back complete" if success else "rsync back failed"
    return success, msg
