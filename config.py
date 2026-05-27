import os
from pathlib import Path
from dotenv import load_dotenv

# Load .env file if it exists
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    load_dotenv(dotenv_path=env_path)
else:
    load_dotenv()

ADMIN_USER = os.getenv("ADMIN_USER", "admin")
ADMIN_PASS = os.getenv("ADMIN_PASS", "admin")
SECRET_KEY = os.getenv("SECRET_KEY", "dev-secret-key-please-change-in-prod")
HUB_PORT = int(os.getenv("HUB_PORT", "8080"))
HOST_IP = os.getenv("HOST_IP", "")
BASE_DIR = os.getenv("BASE_DIR", "/home/hubjupylab")
JUPYTERLAB_VERSION = os.getenv("JUPYTERLAB_VERSION", "4.4.1")
PYTHON_VERSION = os.getenv("PYTHON_VERSION", "3.14")

JUPYTER_PORT_START = 8081
JUPYTER_PORT_END = 8089

# Ensure BASE_DIR exists
os.makedirs(BASE_DIR, exist_ok=True)
