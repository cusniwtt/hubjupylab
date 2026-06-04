import subprocess
from pathlib import Path
import db
import config

def rsync_user_to_gpu(username: str) -> tuple[bool, str]:
    """Rsync user directory to GPU VM. Returns (success, message)."""
    user = db.get_user_by_username(username)
    if not user:
        return False, f"User {username} not found"

    ssh_host = user['gpu_ssh_host']
    ssh_port = user['gpu_ssh_port'] or 22

    gpu_conf = db.get_gpu_config()
    if not ssh_host or not gpu_conf['ssh_key_path']:
        return False, "GPU SSH host or key not configured for user"

    user_dir = Path(config.BASE_DIR) / username
    if not user_dir.exists():
        return False, f"User directory not found: {user_dir}"

    remote_path = f"{gpu_conf['ssh_user']}@{ssh_host}:{gpu_conf['remote_base_dir']}/{username}/"

    cmd = [
        "rsync", "-avz", "--delete",
        "--exclude", ".venv/",
        "--exclude", "__pycache__/",
        "-e", f"ssh -p {ssh_port} -i {gpu_conf['ssh_key_path']} -o StrictHostKeyChecking=no",
        f"{user_dir}/",
        remote_path
    ]

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return False, "rsync timed out after 300s"

    if res.returncode != 0:
        return False, f"rsync failed: {res.stderr}"

    return True, "Sync complete"

def rsync_gpu_to_user(username: str) -> tuple[bool, str]:
    """Rsync user directory from GPU VM back to local. Returns (success, message)."""
    user = db.get_user_by_username(username)
    if not user:
        return False, f"User {username} not found"

    ssh_host = user['gpu_ssh_host']
    ssh_port = user['gpu_ssh_port'] or 22

    gpu_conf = db.get_gpu_config()
    if not ssh_host or not gpu_conf['ssh_key_path']:
        return False, "GPU SSH host or key not configured for user"

    user_dir = Path(config.BASE_DIR) / username
    if not user_dir.exists():
        return False, f"User directory not found: {user_dir}"

    remote_path = f"{gpu_conf['ssh_user']}@{ssh_host}:{gpu_conf['remote_base_dir']}/{username}/"

    cmd = [
        "rsync", "-avz", "--delete",
        "--exclude", ".venv/",
        "--exclude", "__pycache__/",
        "-e", f"ssh -p {ssh_port} -i {gpu_conf['ssh_key_path']} -o StrictHostKeyChecking=no",
        remote_path,
        f"{user_dir}/"
    ]

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        return False, "rsync timed out after 300s"

    if res.returncode != 0:
        return False, f"rsync failed: {res.stderr}"

    return True, "Sync back complete"

def test_gpu_ssh(ssh_host: str = None, ssh_port: int = None) -> tuple[bool, str]:
    """Test SSH connectivity to GPU VM."""
    gpu_conf = db.get_gpu_config()
    
    host = ssh_host if ssh_host is not None else gpu_conf['ssh_host']
    port = ssh_port if ssh_port is not None else gpu_conf['ssh_port']

    if not host or not gpu_conf['ssh_key_path']:
        return False, "GPU SSH not configured"

    cmd = [
        "ssh", "-p", str(port),
        "-i", gpu_conf['ssh_key_path'],
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=10",
        f"{gpu_conf['ssh_user']}@{host}",
        "echo ok"
    ]

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return False, "SSH connection timed out"

    if res.returncode != 0:
        return False, f"SSH failed: {res.stderr}"

    return True, "SSH connection OK"
