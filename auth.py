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
    if "tabs" not in [r[1] for r in db.execute("PRAGMA table_info(users)")]:
        db.execute("ALTER TABLE users ADD COLUMN tabs TEXT DEFAULT ''")  # '' = every tab
    return db


# The tabs an admin can hand out to a member (Amazon Orders, Import and Team are admin-only).
ROLES = ("admin", "warehouse", "member")
TABS = ("dashboard", "scan", "cards", "orders", "returns", "materials")
# Data that belongs to one tab (any of the tabs listed may read it). Shared data (orders, meta ...) stays open to every signed-in user.
API_TABS = {"/api/dashboard": ("dashboard",), "/api/materials": ("materials", "cards"), "/api/returns": ("returns", "cards"), "/api/kohls": ("returns", "cards")}


def parse_tabs(value):
    """The stored text as a list of tab keys, or None for 'every tab'."""
    got = [t for t in (value or "").split(",") if t in TABS]
    return got or None


def clean_tabs(tabs):
    got = [t for t in TABS if t in (tabs or [])]
    if not got:
        raise ValueError("Pick at least one tab.")
    return ",".join(got) if len(got) < len(TABS) else ""


def tab_allowed(user, path):
    """False when the user's tabs do not include the tab that owns this API path."""
    if user.get("role") == "admin" or not user.get("tabs"):
        return True
    for prefix, owners in API_TABS.items():
        if path == prefix or path.startswith(prefix + "/"):
            return any(t in user["tabs"] for t in owners)
    return True


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


def add_user(username, name, password, role="member", tabs=None):
    username = (username or "").strip().lower()
    tabs_text = clean_tabs(tabs) if tabs is not None and role != "admin" else ""
    if not re.fullmatch(r"[a-z0-9._\-]{3,30}", username):
        raise ValueError("Username: 3 to 30 letters, numbers, dots, dashes or underscores.")
    _check_password(password)
    if role not in ROLES:
        raise ValueError("Role must be Admin, Warehouse or Member.")
    salt = secrets.token_hex(16)
    with LOCK:
        db = conn()
        try:
            if db.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
                raise ValueError("That username is taken.")
            db.execute("INSERT INTO users (username, name, pw_hash, salt, role, created_at, tabs) VALUES (?,?,?,?,?,?,?)",
                       (username, (name or username).strip()[:60] or username, hash_pw(password, salt), salt, role,
                        clock.now().strftime("%Y-%m-%d %H:%M"), tabs_text))
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
            r = db.execute("""SELECT u.username, u.name, u.role, u.tabs FROM sessions s JOIN users u ON u.username = s.username
                WHERE s.token = ? AND s.expires > ? AND u.disabled = 0""", (token, time.time())).fetchone()
        finally:
            db.close()
    if not r:
        return None
    u = dict(r)
    u["tabs"] = None if u["role"] == "admin" else parse_tabs(u["tabs"])
    return u


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
            rows = [dict(r) for r in db.execute("SELECT username, name, role, created_at, tabs FROM users WHERE disabled = 0 ORDER BY role, username")]
        finally:
            db.close()
    for r in rows:
        r["tabs"] = None if r["role"] == "admin" else parse_tabs(r["tabs"])
    return rows


def set_tabs(username, tabs):
    text = clean_tabs(tabs)
    with LOCK:
        db = conn()
        try:
            if not db.execute("UPDATE users SET tabs = ? WHERE username = ? AND disabled = 0", (text, username)).rowcount:
                raise ValueError("No such user.")
            db.commit()
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
    if role not in ROLES:
        raise ValueError("Role must be Admin, Warehouse or Member.")
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
