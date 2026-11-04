"""Notifications: somebody wrote a note on an order.

Every time a person saves a note (the Notes or PH Team Internal Notes cell of an order, from All Orders or from an Order Cards
edit window), one event is recorded here with who wrote it, which order (row number and label) and the note itself. Everybody
else who can open All Orders sees it in the bell at the top: the writer never gets their own. Each person has a "seen up to"
mark, so the bell counts only what is new for them. Kept in data/notify.db, apart from the orders.
"""
import sqlite3
import threading
from datetime import timedelta

import clock

DB = None  # set by server.py
LOCK = threading.Lock()
KEEP_DAYS = 60
SHOW = 50  # events one person's bell lists


def connect():
    db = sqlite3.connect(DB, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("""CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, by_user TEXT, by_name TEXT, by_role TEXT,
        rn INTEGER, label TEXT, customer TEXT, field TEXT, text TEXT)""")
    db.execute("CREATE TABLE IF NOT EXISTS seen (username TEXT PRIMARY KEY, last_id INTEGER)")
    return db


def add(db, by_user, by_name, by_role, notes):
    """notes: [(rn, label, customer, field, text)]"""
    now = clock.now()
    at = now.strftime("%Y-%m-%d %H:%M:%S")
    for rn, label, customer, field, text in notes[:100]:
        db.execute("INSERT INTO events (at, by_user, by_name, by_role, rn, label, customer, field, text) VALUES (?,?,?,?,?,?,?,?,?)",
                   (at, by_user, by_name, by_role, int(rn), label or "", customer or "", field, str(text)[:600]))
    db.execute("DELETE FROM events WHERE at < ?", ((now - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d %H:%M:%S"),))
    db.commit()


def _seen(db, username):
    r = db.execute("SELECT last_id FROM seen WHERE username = ?", (username,)).fetchone()
    if r:
        return r[0]
    top = db.execute("SELECT COALESCE(MAX(id), 0) FROM events").fetchone()[0]  # a new account starts with a clean bell
    db.execute("INSERT INTO seen VALUES (?, ?)", (username, top))
    db.commit()
    return top


def feed(db, username):
    """The newest notes written by other people, with which ones are new for this person."""
    last = _seen(db, username)
    rows = [dict(r) for r in db.execute("SELECT * FROM events WHERE by_user <> ? ORDER BY id DESC LIMIT ?", (username, SHOW))]
    for r in rows:
        r["unread"] = r["id"] > last
    unread = db.execute("SELECT COUNT(*) FROM events WHERE by_user <> ? AND id > ?", (username, last)).fetchone()[0]
    return {"items": rows, "unread": unread}


def mark_seen(db, username):
    top = db.execute("SELECT COALESCE(MAX(id), 0) FROM events").fetchone()[0]
    db.execute("INSERT OR REPLACE INTO seen VALUES (?, ?)", (username, top))
    db.commit()
