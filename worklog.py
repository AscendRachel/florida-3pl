"""The Work Log: what the team writes in the chat bubble on the Dashboard.

Each message is kept with who wrote it and the date and time (US Eastern, like everything else in the app), in data/worklog.db.
Everyone can write; each person sees only their own messages in the bubble. Admins read everybody's in the Work Log menu.
"""
import re
import sqlite3
import threading
from datetime import timedelta

import clock

DB = None  # set by server.py
LOCK = threading.Lock()
MAX_LEN = 1000
LIMIT = 1000  # rows the Work Log page loads at once


def connect():
    db = sqlite3.connect(DB, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, username TEXT, name TEXT, text TEXT)")
    db.execute("CREATE INDEX IF NOT EXISTS ix_messages_at ON messages (at)")
    return db


def stamp():
    return clock.now().strftime("%Y-%m-%d %H:%M:%S")


def add(db, username, name, text):
    text = str(text or "").replace("\r\n", "\n").strip()
    if not text:
        raise ValueError("Type a message first.")
    if len(text) > MAX_LEN:
        raise ValueError(f"A message can be up to {MAX_LEN} characters.")
    # a gentle brake against a stuck key or a script: 30 messages a minute
    since = (clock.now() - timedelta(seconds=60)).strftime("%Y-%m-%d %H:%M:%S")
    recent = db.execute("SELECT COUNT(*) FROM messages WHERE username = ? AND at >= ?", (username, since)).fetchone()[0]
    if recent >= 30:
        raise ValueError("Too many messages. Wait a moment.")
    cur = db.execute("INSERT INTO messages (at, username, name, text) VALUES (?,?,?,?)", (stamp(), username, name, text))
    db.commit()
    return dict(db.execute("SELECT id, at, username, name, text FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone())


def mine(db, username, day):
    """One person's messages of one day, oldest first (what the bubble shows)."""
    return [dict(r) for r in db.execute("SELECT id, at, username, name, text FROM messages WHERE username = ? AND substr(at, 1, 10) = ? ORDER BY id LIMIT 300", (username, day))]


def search(db, day="", username="", q=""):
    """The Work Log page: newest first, filtered by date, person and words."""
    where, args = [], []
    if day:
        if not re.fullmatch(r"\d{4}-\d\d-\d\d", day):
            raise ValueError("Pick a date.")
        where.append("substr(at, 1, 10) = ?")
        args.append(day)
    if username:
        where.append("username = ?")
        args.append(username)
    for w in str(q or "").lower().split()[:8]:
        where.append("(lower(text) LIKE ? OR lower(name) LIKE ?)")
        args += [f"%{w}%", f"%{w}%"]
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    total = db.execute(f"SELECT COUNT(*) FROM messages{clause}", args).fetchone()[0]
    rows = [dict(r) for r in db.execute(f"SELECT id, at, username, name, text FROM messages{clause} ORDER BY id DESC LIMIT {LIMIT}", args)]
    people = [dict(r) for r in db.execute("SELECT username, MAX(name) AS name FROM messages GROUP BY username ORDER BY MAX(name)")]
    return {"items": rows, "total": total, "people": people}
