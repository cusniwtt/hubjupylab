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
    cursor.execute("SELECT * FROM users WHERE role != 'admin' ORDER BY username ASC")
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
