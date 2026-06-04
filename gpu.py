import subprocess
from pathlib import Path
import db
import config

def rsync_user_to_gpu(username: str) -> tuple[bool, str]:
    """Rsync user directory to GPU VM. Returns (success, message)."""
    gpu_conf = db.get_gpu_config()
    if not gpu_conf['ssh_host'] or not gpu_conf['ssh_key_path']:
        return False, "GPU SSH not configured"

    user_dir = Path(config.BASE_DIR) / username
    if not user_dir.exists():
        return False, f"User directory not found: {user_dir}"

    remote_path = f"{gpu_conf['ssh_user']}@{gpu_conf['ssh_host']}:{gpu_conf['remote_base_dir']}/{username}/"

    cmd = [
        "rsync", "-avz", "--delete",
        "-e", f"ssh -p {gpu_conf['ssh_port']} -i {gpu_conf['ssh_key_path']} -o StrictHostKeyChecking=no",
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

def test_gpu_ssh() -> tuple[bool, str]:
    """Test SSH connectivity to GPU VM."""
    gpu_conf = db.get_gpu_config()
    if not gpu_conf['ssh_host'] or not gpu_conf['ssh_key_path']:
        return False, "GPU SSH not configured"

    cmd = [
        "ssh", "-p", str(gpu_conf['ssh_port']),
        "-i", gpu_conf['ssh_key_path'],
        "-o", "StrictHostKeyChecking=no",
        "-o", "ConnectTimeout=10",
        f"{gpu_conf['ssh_user']}@{gpu_conf['ssh_host']}",
        "echo ok"
    ]

    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        return False, "SSH connection timed out"

    if res.returncode != 0:
        return False, f"SSH failed: {res.stderr}"

    return True, "SSH connection OK"
