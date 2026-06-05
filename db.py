import sqlite3
from pathlib import Path
import bcrypt
import config

DB_PATH = Path(config.BASE_DIR) / "hubjupylab.db"

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def hash_password(password: str) -> str:
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode('utf-8'), salt).decode('utf-8')

def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))

def init_db():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'user',
            port INTEGER UNIQUE,
            token TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()

    # Add GPU columns to existing users table
    for col in ["gpu_endpoint TEXT", "gpu_token TEXT", "gpu_ssh_host TEXT", "gpu_ssh_port INTEGER", "gpu_init_status TEXT"]:
        try:
            cursor.execute(f"ALTER TABLE users ADD COLUMN {col}")
            conn.commit()
        except sqlite3.OperationalError:
            pass  # Column already exists

    # GPU SSH config table (single row)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS gpu_config (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            ssh_host TEXT NOT NULL DEFAULT '',
            ssh_port INTEGER NOT NULL DEFAULT 22,
            ssh_user TEXT NOT NULL DEFAULT 'root',
            ssh_key_path TEXT NOT NULL DEFAULT '',
            remote_base_dir TEXT NOT NULL DEFAULT '/workspace'
        )
    """)
    cursor.execute("INSERT OR IGNORE INTO gpu_config (id) VALUES (1)")
    conn.commit()

    # Check if admin user exists, if not seed it
    cursor.execute("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1")
    if not cursor.fetchone():
        hashed_admin_pass = hash_password(config.ADMIN_PASS)
        cursor.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')",
            (config.ADMIN_USER, hashed_admin_pass)
        )
        conn.commit()
        
    conn.close()

def create_user(username: str, password_plain: str, role: str = 'user', port: int = None) -> bool:
    hashed = hash_password(password_plain)
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO users (username, password_hash, role, port) VALUES (?, ?, ?, ?)",
            (username, hashed, role, port)
        )
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        return False
    finally:
        conn.close()

def delete_user(username: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM users WHERE username = ?", (username,))
    conn.commit()
    conn.close()

def get_user_by_username(username: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE username = ?", (username,))
    user = cursor.fetchone()
    conn.close()
    return user

def list_users():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE role != 'admin' ORDER BY port ASC")
    users = cursor.fetchall()
    conn.close()
    return users

def update_token(username: str, token: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET token = ? WHERE username = ?", (token, username))
    conn.commit()
    conn.close()

def get_used_ports():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT port FROM users WHERE port IS NOT NULL")
    ports = [row['port'] for row in cursor.fetchall()]
    conn.close()
    return ports

def get_gpu_config():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM gpu_config WHERE id = 1")
    row = cursor.fetchone()
    conn.close()
    if row:
        return dict(row)
    return {
        'ssh_host': '', 'ssh_port': 22, 'ssh_user': 'root',
        'ssh_key_path': '', 'remote_base_dir': '/workspace'
    }

def save_gpu_config(ssh_host: str, ssh_port: int, ssh_user: str, ssh_key_path: str, remote_base_dir: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO gpu_config (id, ssh_host, ssh_port, ssh_user, ssh_key_path, remote_base_dir)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            ssh_host = excluded.ssh_host,
            ssh_port = excluded.ssh_port,
            ssh_user = excluded.ssh_user,
            ssh_key_path = excluded.ssh_key_path,
            remote_base_dir = excluded.remote_base_dir
    """, (ssh_host, ssh_port, ssh_user, ssh_key_path, remote_base_dir))
    conn.commit()
    conn.close()

def assign_gpu(username: str, gpu_endpoint: str, gpu_token: str, gpu_ssh_host: str, gpu_ssh_port: int):
    user = get_user_by_username(username)
    new_status = 'pending'
    if user:
        if user['gpu_ssh_host'] == gpu_ssh_host and user['gpu_ssh_port'] == gpu_ssh_port and user['gpu_init_status']:
            new_status = user['gpu_init_status']

    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE users SET gpu_endpoint = ?, gpu_token = ?, gpu_ssh_host = ?, gpu_ssh_port = ?, gpu_init_status = ? WHERE username = ?",
        (gpu_endpoint, gpu_token, gpu_ssh_host, gpu_ssh_port, new_status, username)
    )
    conn.commit()
    conn.close()

def unassign_gpu(username: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE users SET gpu_endpoint = NULL, gpu_token = NULL, gpu_ssh_host = NULL, gpu_ssh_port = NULL, gpu_init_status = NULL WHERE username = ?",
        (username,)
    )
    conn.commit()
    conn.close()

def update_gpu_init_status(username: str, status: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE users SET gpu_init_status = ? WHERE username = ?",
        (status, username)
    )
    conn.commit()
    conn.close()
