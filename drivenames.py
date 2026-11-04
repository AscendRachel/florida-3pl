"""Names of the Google Drive files behind the Shipping Label Link column.

The label PDFs are named after the customer and the tracking number ("Lisa-Norris---9334611043900227102757.pdf"), so the name is how
the team checks that the attached link is the right one. A file shared by link shows its name in the title of its Drive page; the
app reads that title once, in the background, and keeps it in data/drive.db. Files that cannot be read (private, deleted) are tried
again after an hour. Nothing here sends any of the app's data to Google: only the file id in the link is asked for.
"""
import html
import queue
import re
import sqlite3
import threading
import time
import urllib.request

DB = None  # set by server.py
ID_RE = re.compile(r"^[-\w]{25,}$")
RETRY = 3600  # seconds before a file that could not be read is tried again
WORKERS = 4
_lock = threading.Lock()
_todo = queue.Queue()
_queued = set()
_started = False


def _connect():
    db = sqlite3.connect(DB, timeout=10)
    db.execute("CREATE TABLE IF NOT EXISTS drive_names (id TEXT PRIMARY KEY, name TEXT, at REAL)")
    return db


def fetch_name(fid):
    """The file's name from the title of its Drive page, or "" when it cannot be read."""
    try:
        req = urllib.request.Request(f"https://drive.google.com/file/d/{fid}/view", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            page = r.read(80000).decode("utf-8", "ignore")
    except Exception:
        return ""
    m = re.search(r"<title>(.*?)</title>", page, re.S)
    title = html.unescape(m.group(1)).strip() if m else ""
    title = re.sub(r"\s*-\s*Google Drive\s*$", "", title)
    return "" if not title or title.lower() in ("google drive", "sign in", "google drive: sign-in") or "sign in" in title.lower() else title


def _worker():
    while True:
        fid = _todo.get()
        try:
            name = fetch_name(fid)
            with _lock:
                db = _connect()
                try:
                    db.execute("INSERT OR REPLACE INTO drive_names (id, name, at) VALUES (?,?,?)", (fid, name, time.time()))
                    db.commit()
                finally:
                    db.close()
        except Exception:
            pass
        finally:
            _queued.discard(fid)


def _start():
    global _started
    if not _started:
        _started = True
        for _ in range(WORKERS):
            threading.Thread(target=_worker, daemon=True).start()


def names(ids):
    """{id: name} for the files already known, and how many are still being looked up (the page asks again in a moment)."""
    ids = [i for i in dict.fromkeys(ids) if isinstance(i, str) and ID_RE.match(i)][:80]
    got, pending = {}, 0
    with _lock:
        db = _connect()
        try:
            known = {r[0]: (r[1], r[2]) for r in db.execute(f"SELECT id, name, at FROM drive_names WHERE id IN ({','.join('?' * len(ids))})", ids)} if ids else {}
        finally:
            db.close()
    now = time.time()
    for i in ids:
        row = known.get(i)
        if row and (row[0] or now - row[1] < RETRY):
            got[i] = row[0]
        else:
            pending += 1
            if i not in _queued:
                _queued.add(i)
                _start()
                _todo.put(i)
    return {"names": got, "pending": pending}
