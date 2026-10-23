"""Accounts and sign-in sessions.

Passwords are stored as PBKDF2-SHA256 hashes (200,000 rounds, a random salt per user), never as text.
A signed-in browser holds a random session token in an HttpOnly cookie; the token is looked up here on every request.
Accounts live in data/auth.db, apart from the orders, so importing orders never touches them.
"""
import clock
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime

DB = None  # set by server.py
LOCK = threading.Lock()
COOKIE = os.environ.get("F3PL_COOKIE", "f3pl_session")
SESSION_DAYS = 30
FAILED = {}  # ip -> times of recent failed sign-ins
MAX_FAILS, FAIL_WINDOW = 8, 600

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, name TEXT, pw_hash TEXT, salt TEXT,
        role TEXT DEFAULT 'member', disabled INTEGER DEFAULT 0, created_at TEXT)""",
    "CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, username TEXT, expires REAL)",
]


def conn():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    for q in SCHEMA:
        db.execute(q)
    return db


def hash_pw(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), 200_000).hex()


def user_count():
    with LOCK:
        db = conn()
        try:
            return db.execute("SELECT COUNT(*) FROM users WHERE disabled = 0").fetchone()[0]
        finally:
            db.close()


def _check_password(password):
    if len(password or "") < 8:
        raise ValueError("Password must be at least 8 characters.")


def add_user(username, name, password, role="member"):
    username = (username or "").strip().lower()
    if not re.fullmatch(r"[a-z0-9._\-]{3,30}", username):
        raise ValueError("Username: 3 to 30 letters, numbers, dots, dashes or underscores.")
    _check_password(password)
    if role not in ("admin", "member"):
        raise ValueError("Role must be admin or member.")
    salt = secrets.token_hex(16)
    with LOCK:
        db = conn()
        try:
            if db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
                raise ValueError("That username is taken.")
            db.execute("INSERT INTO users (username, name, pw_hash, salt, role, created_at) VALUES (?,?,?,?,?,?)",
                       (username, (name or username).strip()[:60] or username, hash_pw(password, salt), salt, role,
                        clock.now().strftime("%Y-%m-%d %H:%M")))
            db.commit()
        finally:
            db.close()
    return username


def set_password(username, password):
    _check_password(password)
    salt = secrets.token_hex(16)
    with LOCK:
        db = conn()
        try:
            n = db.execute("UPDATE users SET pw_hash = ?, salt = ? WHERE username = ? AND disabled = 0",
                           (hash_pw(password, salt), salt, username)).rowcount
            if not n:
                raise ValueError("No such user.")
            db.execute("DELETE FROM sessions WHERE username = ?", (username,))  # signs them out everywhere
            db.commit()
        finally:
            db.close()


def check_login(username, password):
    with LOCK:
        db = conn()
        try:
            u = db.execute("SELECT * FROM users WHERE username = ? AND disabled = 0", ((username or "").strip().lower(),)).fetchone()
        finally:
            db.close()
    if not u:
        hash_pw(password or "x", "00" * 16)  # the same amount of work whether or not the user exists
        return None
    return u if hmac.compare_digest(u["pw_hash"], hash_pw(password or "", u["salt"])) else None


def new_session(username):
    token = secrets.token_urlsafe(32)
    with LOCK:
        db = conn()
        try:
            db.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
            db.execute("INSERT INTO sessions VALUES (?,?,?)", (token, username, time.time() + SESSION_DAYS * 86400))
            db.commit()
        finally:
            db.close()
    return token


def session_user(token):
    if not token:
        return None
    with LOCK:
        db = conn()
        try:
            r = db.execute("""SELECT u.username, u.name, u.role FROM sessions s JOIN users u ON u.username = s.username
                WHERE s.token = ? AND s.expires > ? AND u.disabled = 0""", (token, time.time())).fetchone()
        finally:
            db.close()
    return dict(r) if r else None


def end_session(token):
    with LOCK:
        db = conn()
        try:
            db.execute("DELETE FROM sessions WHERE token = ?", (token,))
            db.commit()
        finally:
            db.close()


def list_users():
    with LOCK:
        db = conn()
        try:
            return [dict(r) for r in db.execute("SELECT username, name, role, created_at FROM users WHERE disabled = 0 ORDER BY role, username")]
        finally:
            db.close()


def _admins(db):
    return db.execute("SELECT COUNT(*) FROM users WHERE disabled = 0 AND role = 'admin'").fetchone()[0]


def remove_user(username, by):
    if username == by:
        raise ValueError("You cannot remove your own account.")
    with LOCK:
        db = conn()
        try:
            u = db.execute("SELECT role FROM users WHERE username = ? AND disabled = 0", (username,)).fetchone()
            if not u:
                raise ValueError("No such user.")
            if u["role"] == "admin" and _admins(db) <= 1:
                raise ValueError("There must always be at least one admin.")
            db.execute("UPDATE users SET disabled = 1 WHERE username = ?", (username,))
            db.execute("DELETE FROM sessions WHERE username = ?", (username,))
            db.commit()
        finally:
            db.close()


def set_role(username, role, by):
    if role not in ("admin", "member"):
        raise ValueError("Role must be admin or member.")
    with LOCK:
        db = conn()
        try:
            u = db.execute("SELECT role FROM users WHERE username = ? AND disabled = 0", (username,)).fetchone()
            if not u:
                raise ValueError("No such user.")
            if u["role"] == "admin" and role != "admin" and _admins(db) <= 1:
                raise ValueError("There must always be at least one admin.")
            db.execute("UPDATE users SET role = ? WHERE username = ?", (role, username))
            db.commit()
        finally:
            db.close()


def too_many_failures(ip):
    now = time.time()
    FAILED[ip] = [t for t in FAILED.get(ip, []) if now - t < FAIL_WINDOW]
    return len(FAILED[ip]) >= MAX_FAILS


def note_failure(ip):
    FAILED.setdefault(ip, []).append(time.time())


def cookie_value(token, https=False, max_age=None):
    age = SESSION_DAYS * 86400 if max_age is None else max_age
    return f"{COOKIE}={token}; Max-Age={age}; Path=/; HttpOnly; SameSite=Lax" + ("; Secure" if https else "")
