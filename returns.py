"""Returns: the warehouse's list of customer returns (the sheet's RETURNS tab).

The rows come from a master returns sheet shared with "anyone with the link" (the sheet's IMPORTRANGE source),
keeping only the rows of this warehouse. The app reads that sheet by itself on a timer. What the warehouse does with
a return (Shipped to Amazon, who processed it and when, its own notes) lives only here, so a sync never overwrites it.
Everything is stored in data/returns.db, apart from the orders, so importing orders never touches it.
"""
import clock
import csv
import io
import json
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

DB = None  # set by server.py
ON_CHANGE = None  # set by server.py: called after a timed sync so open pages refresh by themselves
LOCK = threading.Lock()
on_change = lambda: None  # server.py: tells open pages to refresh

DEFAULTS = {
    "source_url": "https://docs.google.com/spreadsheets/d/1aBeg0dhwkBGBvC5H3CbTP_LUXlmBUDo6xiGfxn0mKh0/edit",
    "source_tab": "RETURNS",
    "warehouse": "FLORIDA",
    "interval_min": 30,
    "seed_url": "https://docs.google.com/spreadsheets/d/1M_1k_91nymXWt0SDt3aS5ZCaC8k3rr-hdos1qQee97M/edit",
    "seed_tab": "RETURNS",
}
INTERVALS = [0, 5, 10, 15, 30, 60, 180, 360, 720, 1440]  # minutes; 0 = only when someone presses Sync now

SOURCE_FIELDS = ["store", "po", "product", "qty", "customer", "address", "return_date", "tracking", "status_cx", "label_link",
                 "due_date", "notes", "status_wh", "refunded", "reason"]
DATE_FIELDS = {"return_date", "due_date", "processed_at"}
SCHEMA = [
    """CREATE TABLE IF NOT EXISTS returns (
        id INTEGER PRIMARY KEY AUTOINCREMENT, rid TEXT, key TEXT UNIQUE,
        store TEXT DEFAULT '', po TEXT DEFAULT '', product TEXT DEFAULT '', qty TEXT DEFAULT '', customer TEXT DEFAULT '',
        address TEXT DEFAULT '', return_date TEXT DEFAULT '', tracking TEXT DEFAULT '', status_cx TEXT DEFAULT '',
        label_link TEXT DEFAULT '', due_date TEXT DEFAULT '', notes TEXT DEFAULT '', status_wh TEXT DEFAULT '',
        refunded TEXT DEFAULT '', reason TEXT DEFAULT '',
        shipped TEXT DEFAULT 'FALSE', processed_at TEXT DEFAULT '', processed_by TEXT DEFAULT '', wh_notes TEXT DEFAULT '',
        removed INTEGER DEFAULT 0, first_seen TEXT, last_seen TEXT)""",
    "CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)",
    """CREATE TABLE IF NOT EXISTS sync_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, ok INTEGER, trigger TEXT,
        message TEXT, read INTEGER DEFAULT 0, added INTEGER DEFAULT 0, updated INTEGER DEFAULT 0, removed INTEGER DEFAULT 0)""",
]
SHEET_RE = re.compile(r"/spreadsheets/d/([A-Za-z0-9_-]{20,})")


def connect():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    for q in SCHEMA:
        db.execute(q)
    if "ovr" not in {r[1] for r in db.execute("PRAGMA table_info(returns)")}:
        db.execute("ALTER TABLE returns ADD COLUMN ovr TEXT DEFAULT ''")  # what people typed over the master sheet's values
    return db


def stamp(dt=None):
    return (dt or clock.now()).strftime("%Y-%m-%d %H:%M")


# ---------------------------------------------------------------- settings

def get_settings(db):
    out = dict(DEFAULTS)
    for r in db.execute("SELECT k, v FROM settings"):
        out[r["k"]] = json.loads(r["v"])
    return out


def save_settings(db, new):
    cur = get_settings(db)
    for k in ("source_url", "seed_url"):
        v = str(new.get(k, cur[k])).strip()
        if v and not SHEET_RE.search(v):
            raise ValueError("That is not a Google Sheets link. It should look like https://docs.google.com/spreadsheets/d/…")
        cur[k] = v
    for k in ("source_tab", "seed_tab", "warehouse"):
        v = str(new.get(k, cur[k])).strip()[:60]
        if not v:
            raise ValueError("Tab name and warehouse name cannot be empty.")
        cur[k] = v
    interval = int(new.get("interval_min", cur["interval_min"]))
    if interval not in INTERVALS:
        raise ValueError("Pick one of the listed sync intervals.")
    cur["interval_min"] = interval
    for k, v in cur.items():
        db.execute("INSERT OR REPLACE INTO settings VALUES (?, ?)", (k, json.dumps(v)))
    db.commit()
    return cur


# ---------------------------------------------------------------- reading a sheet

def fetch_csv(url, tab):
    m = SHEET_RE.search(url or "")
    if not m:
        raise ValueError("The sheet link is not a Google Sheets link.")
    u = f"https://docs.google.com/spreadsheets/d/{m.group(1)}/gviz/tq?tqx=out:csv&sheet={urllib.parse.quote(tab)}"
    try:
        with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Florida3PL"}), timeout=90) as resp:
            text = resp.read().decode("utf-8-sig")
    except urllib.error.HTTPError as e:
        raise ValueError(f"Google refused to share the sheet (error {e.code}). It must be shared as \"Anyone with the link can view\".") from None
    except (urllib.error.URLError, TimeoutError) as e:
        raise ValueError(f"Could not reach Google Sheets ({getattr(e, 'reason', e)}).") from None
    if text.lstrip().startswith("<"):
        raise ValueError("Google did not return the sheet. It must be shared as \"Anyone with the link can view\".")
    return list(csv.reader(io.StringIO(text, newline="")))


def field_of(header):
    h = " ".join(str(header).lower().split())
    if h == "return id": return "rid"
    if h == "store": return "store"
    if h.startswith("p.o"): return "po"
    if h == "product name": return "product"
    if h == "qty": return "qty"
    if h == "customer name": return "customer"
    if h == "address": return "address"
    if h == "return date": return "return_date"
    if h.startswith("tracking"): return "tracking"
    if h == "return status" or h.startswith("return status from cx"): return "status_cx"
    if h == "return label link": return "label_link"
    if h == "return due date": return "due_date"
    if h == "notes": return "notes"
    if h == "status" or h.startswith("return status from warehouse"): return "status_wh"
    if h.startswith("source refund"): return "refunded"
    if h == "reason": return "reason"
    if h == "shipped to amazon": return "shipped"
    if h.startswith("processed date"): return "processed_at"
    if h.startswith("processed by"): return "processed_by"
    return None


def norm_when(s):
    s = (s or "").strip()
    for fmt in ("%B %d, %Y", "%b %d, %Y", "%Y-%m-%d", "%m/%d/%Y", "%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y %H:%M:%S", "%m/%d/%Y %H:%M"):
        try:
            d = datetime.strptime(s, fmt)
        except ValueError:
            continue
        return d.strftime("%Y-%m-%d %H:%M") if ("%H" in fmt) else d.strftime("%Y-%m-%d")
    return s


def records(rows, warehouse=None):
    """CSV rows -> [{field: value}]. With `warehouse`, only the rows whose first column holds that name (the master sheet)."""
    if not rows:
        raise ValueError("The sheet is empty.")
    fields = [field_of(h) for h in rows[0]]
    if "po" not in fields or "product" not in fields:
        raise ValueError("That tab does not look like a returns tab (no P.O NUMBER / PRODUCT NAME columns). Check the tab name.")
    out = []
    for r in rows[1:]:
        if warehouse and (not r or r[0].strip().upper() != warehouse.strip().upper()):
            continue
        rec = {f: (r[i].strip() if i < len(r) else "") for i, f in enumerate(fields) if f}
        if not (rec.get("po") or rec.get("tracking") or rec.get("product")):
            continue
        for f in DATE_FIELDS:
            if rec.get(f):
                rec[f] = norm_when(rec[f])
        for f in ("refunded", "shipped"):
            if f in rec:
                rec[f] = "TRUE" if rec[f].strip().upper() == "TRUE" else "FALSE"
        out.append(rec)
    return out


def make_key(rec):
    return "|".join(" ".join(str(rec.get(f, "")).lower().split()) for f in ("po", "tracking", "product"))


def next_rid(db):
    top = 0
    for (rid,) in db.execute("SELECT rid FROM returns"):
        m = re.search(r"(\d+)$", rid or "")
        top = max(top, int(m.group(1)) if m else 0)
    return f"STR-{top + 1:02d}"


# ---------------------------------------------------------------- sync

def _insert(db, rec, key, now):
    cols = ["rid", "key", *SOURCE_FIELDS, "shipped", "processed_at", "processed_by", "first_seen", "last_seen"]
    vals = [rec.get("rid") or next_rid(db), key, *[rec.get(f, "") for f in SOURCE_FIELDS], rec.get("shipped", "FALSE"),
            rec.get("processed_at", ""), rec.get("processed_by", ""), now, now]
    db.execute(f"INSERT INTO returns ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", vals)


def sync(trigger="manual"):
    """Read the master sheet and bring the returns up to date. Returns the log row; raises ValueError on failure (also logged)."""
    with LOCK:
        db = connect()
        cfg = get_settings(db)
        db.close()
    added = updated = removed = read = 0
    notes = []
    try:
        master = records(fetch_csv(cfg["source_url"], cfg["source_tab"]), cfg["warehouse"])
        read = len(master)
        seed = []
        with LOCK:
            db = connect()
            first_time = db.execute("SELECT COUNT(*) FROM returns").fetchone()[0] == 0
            db.close()
        if first_time and cfg["seed_url"]:  # start from the 3PL sheet's own RETURNS tab, so Return IDs and Shipped to Amazon carry over
            try:
                seed = records(fetch_csv(cfg["seed_url"], cfg["seed_tab"]))
            except ValueError as e:
                notes.append(f"Could not copy the 3PL sheet's current progress: {e}")
        now = stamp()
        with LOCK:
            db = connect()
            try:
                seen = set()
                for rec in seed:
                    key = make_key(rec)
                    if key not in seen and rec.get("rid"):
                        seen.add(key)
                        _insert(db, rec, key, now)
                if seed:
                    notes.append(f"Copied {len(seen)} returns with their progress from the 3PL sheet.")
                existing = {r["key"]: r for r in db.execute("SELECT * FROM returns")}
                seen = set()
                for rec in master:
                    key = make_key(rec)
                    n = 1
                    while key in seen:
                        n += 1
                        key = f"{make_key(rec)}#{n}"
                    seen.add(key)
                    row = existing.get(key)
                    if row is None:
                        _insert(db, rec, key, now)
                        added += 1
                    else:
                        changed = {f: rec.get(f, "") for f in SOURCE_FIELDS if (row[f] or "") != rec.get(f, "")}
                        if changed or row["removed"]:
                            sets = ", ".join(f"{f} = ?" for f in changed) + (", " if changed else "") + "removed = 0, last_seen = ?"
                            db.execute(f"UPDATE returns SET {sets} WHERE id = ?", [*changed.values(), now, row["id"]])
                            updated += 1
                        else:
                            db.execute("UPDATE returns SET last_seen = ? WHERE id = ?", (now, row["id"]))
                for key, row in existing.items():
                    if key not in seen and not row["removed"]:
                        db.execute("UPDATE returns SET removed = 1 WHERE id = ?", (row["id"],))
                        removed += 1
                msg = " ".join(notes) or "OK"
                db.execute("INSERT INTO sync_log (at, ok, trigger, message, read, added, updated, removed) VALUES (?,?,?,?,?,?,?,?)",
                           (now, 1, trigger, msg, read, added, updated, removed))
                db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()
        if added or updated or removed or seed:
            on_change()
        return {"ok": True, "at": now, "read": read, "added": added, "updated": updated, "removed": removed, "message": " ".join(notes)}
    except ValueError as e:
        with LOCK:
            db = connect()
            db.execute("INSERT INTO sync_log (at, ok, trigger, message, read) VALUES (?,?,?,?,?)", (stamp(), 0, trigger, str(e), read))
            db.commit()
            db.close()
        raise


def scheduler(stop):
    """Runs in the background: every so often checks whether a timed sync is due."""
    last = None
    while not stop.wait(20):
        try:
            with LOCK:
                db = connect()
                cfg = get_settings(db)
                row = db.execute("SELECT at FROM sync_log ORDER BY id DESC LIMIT 1").fetchone()
                db.close()
            if not cfg["interval_min"]:
                continue
            if last is None and row:
                last = time.time() - (clock.now() - datetime.strptime(row["at"], "%Y-%m-%d %H:%M")).total_seconds()
            if last is None or time.time() - last >= cfg["interval_min"] * 60:
                last = time.time()
                try:
                    sync("auto")
                    if ON_CHANGE:
                        ON_CHANGE()
                except ValueError:
                    pass  # logged; tried again at the next interval
        except Exception:  # noqa: BLE001 - the timer must never die
            time.sleep(60)


def status(db):
    cfg = get_settings(db)
    last = db.execute("SELECT * FROM sync_log ORDER BY id DESC LIMIT 1").fetchone()
    good = db.execute("SELECT * FROM sync_log WHERE ok = 1 ORDER BY id DESC LIMIT 1").fetchone()
    log = [dict(r) for r in db.execute("SELECT * FROM sync_log ORDER BY id DESC LIMIT 12")]
    return {"settings": cfg, "last": dict(last) if last else None, "last_ok": dict(good) if good else None, "log": log}


# ---------------------------------------------------------------- reading and editing returns

def words(s):
    return set(re.findall(r"[a-z0-9]{3,}", (s or "").lower()))


def images(rows, orders_db):
    """The product picture of each return, found among the orders by P.O NUMBER (Store Order No.)."""
    pos = sorted({r["po"] for r in rows if r["po"]})
    found = {}
    if not pos or not orders_db or not Path(orders_db).exists():
        return {}
    try:
        db = sqlite3.connect(f"file:{orders_db}?mode=ro", uri=True)
        for i in range(0, len(pos), 400):
            chunk = pos[i:i + 400]
            for po, name, img in db.execute(f"SELECT c2, c3, c12 FROM orders WHERE c2 IN ({','.join('?' * len(chunk))}) AND c12 <> ''", chunk):
                found.setdefault(po, []).append((name or "", img))
        db.close()
    except sqlite3.Error:
        return {}
    out = {}
    for r in rows:
        cands = found.get(r["po"])
        if cands:
            mine = words(r["product"])
            out[r["id"]] = max(cands, key=lambda c: len(mine & words(c[0])))[1]
    return out


def public_row(r):
    """A return as the page sees it: the master sheet's values with what people typed over them on top."""
    d = dict(r)
    d.pop("key", None)
    ovr = json.loads(d.pop("ovr", "") or "{}")
    d["overridden"] = {f: d.get(f, "") for f in ovr}  # the master sheet's value of each cell that was typed over
    d.update(ovr)
    return d


def list_rows(db, orders_db):
    rows = [public_row(r) for r in db.execute("SELECT * FROM returns ORDER BY id")]
    imgs = images(rows, orders_db)
    for r in rows:
        r["image"] = imgs.get(r["id"], "")
    return rows


def clean_value(field, v):
    v = str(v if v is not None else "").strip()
    if field in DATE_FIELDS:
        v = norm_when(v)
        if v and not re.fullmatch(r"\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?", v):
            raise ValueError("Use a date like Sep 23, 2026.")
    elif field == "qty":
        if v and not re.fullmatch(r"\d+", v):
            raise ValueError("QTY takes a whole number.")
    elif field == "refunded":
        low = v.lower()
        if low in ("true", "yes", "y", "1", "x", "checked"):
            v = "TRUE"
        elif low in ("false", "no", "n", "0", ""):
            v = "FALSE"
        else:
            raise ValueError("A checkbox takes TRUE or FALSE.")
    return v[:2000]


def edit(db, rid, field, value, operator, revert=False):
    row = db.execute("SELECT * FROM returns WHERE rid = ?", (rid,)).fetchone()
    if not row:
        raise ValueError("That return no longer exists.")
    if field == "shipped":
        on = bool(value)
        if on and not operator.strip():
            raise ValueError("Enter your name first, so it is recorded who processed this return.")
        db.execute("UPDATE returns SET shipped = ?, processed_at = ?, processed_by = ? WHERE rid = ?",
                   ("TRUE" if on else "FALSE", stamp() if on else "", operator.strip()[:60] if on else "", rid))
    elif field == "wh_notes":
        db.execute("UPDATE returns SET wh_notes = ? WHERE rid = ?", (str(value or "").strip()[:2000], rid))
    elif field in ("processed_at", "processed_by"):
        v = clean_value(field, value)[:60] if field == "processed_by" else clean_value(field, value)
        db.execute(f"UPDATE returns SET {field} = ? WHERE rid = ?", (v, rid))
    elif field in SOURCE_FIELDS:
        ovr = json.loads(row["ovr"] or "{}")
        if revert:
            ovr.pop(field, None)
        else:
            v = clean_value(field, value)
            if v == (row[field] or ""):
                ovr.pop(field, None)  # typed back to the master sheet's value: nothing left to remember
            else:
                ovr[field] = v
        db.execute("UPDATE returns SET ovr = ? WHERE rid = ?", (json.dumps(ovr) if ovr else "", rid))
    else:
        raise ValueError("That column cannot be edited.")
    db.commit()
    return public_row(db.execute("SELECT * FROM returns WHERE rid = ?", (rid,)).fetchone())
