"""Materials: the packaging supplies the warehouse keeps (poly mailers, bubble wrap, tape, boxes, labels ...).

A list kept by hand, in data/materials.db, apart from the orders. The Stock Status is worked out from the numbers, so it is never typed:
no stock left is OUT OF STOCK, at or under the Minimum Stock is CRITICAL, at or under the Alert Level is REORDER ALERT, otherwise GOOD.
"""
import re
import sqlite3
import threading

import clock

DB = None  # set by server.py
LOCK = threading.Lock()

TEXT = {"mid": 20, "image": 600, "name": 200, "spec": 200, "unit": 30, "pack": 60, "ordered": 12, "current": 12, "alert": 12, "minimum": 12, "notes": 2000}
NUMBERS = ("ordered", "current", "alert", "minimum")
UNITS = ["Pack", "Roll", "Box", "Each"]


def connect():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    db.execute("""CREATE TABLE IF NOT EXISTS materials (
        id INTEGER PRIMARY KEY AUTOINCREMENT, mid TEXT DEFAULT '', image TEXT DEFAULT '', name TEXT DEFAULT '', spec TEXT DEFAULT '',
        unit TEXT DEFAULT '', pack TEXT DEFAULT '', ordered TEXT DEFAULT '', current TEXT DEFAULT '', alert TEXT DEFAULT '',
        minimum TEXT DEFAULT '', status TEXT DEFAULT '', updated_at TEXT DEFAULT '', updated_by TEXT DEFAULT '', notes TEXT DEFAULT '')""")
    return db


def stamp():
    return clock.now().strftime("%Y-%m-%d %H:%M:%S")


def _num(v):
    try:
        return float(str(v).replace(",", "").strip())
    except ValueError:
        return None


def status_of(current, alert, minimum):
    cur, al, mn = _num(current), _num(alert), _num(minimum)
    if cur is None:
        return ""
    if cur <= 0:
        return "OUT OF STOCK"
    if mn is not None and cur <= mn:
        return "CRITICAL"
    if al is not None and cur <= al:
        return "REORDER ALERT"
    return "GOOD"


def _clean(field, value):
    if field not in TEXT:
        raise ValueError("That column cannot be edited.")
    v = str(value if value is not None else "").strip()[:TEXT[field]]
    if field in NUMBERS and v and _num(v) is None:
        raise ValueError(f"{field.capitalize()} must be a number.")
    return v


def list_rows(db):
    return {"rows": [dict(r) for r in db.execute("SELECT * FROM materials ORDER BY id")],
            "units": sorted({*UNITS, *(r[0] for r in db.execute("SELECT DISTINCT unit FROM materials WHERE unit <> ''"))})}


def next_mid(db):
    top = 0
    for (m,) in db.execute("SELECT mid FROM materials"):
        g = re.fullmatch(r"MAT-(\d+)", m or "")
        top = max(top, int(g.group(1)) if g else 0)
    return f"MAT-{top + 1:03d}"


def _refresh(db, id_, operator, touch):
    r = db.execute("SELECT current, alert, minimum FROM materials WHERE id = ?", (id_,)).fetchone()
    db.execute("UPDATE materials SET status = ? WHERE id = ?", (status_of(r["current"], r["alert"], r["minimum"]), id_))
    if touch:
        db.execute("UPDATE materials SET updated_at = ?, updated_by = ? WHERE id = ?", (stamp(), operator, id_))


def add(db, operator, values=None):
    v = {k: "" for k in TEXT}
    for k, val in (values or {}).items():
        if k in TEXT:
            v[k] = _clean(k, val)
    v["mid"] = v["mid"] or next_mid(db)
    cur = db.execute("INSERT INTO materials (mid, image, name, spec, unit, pack, ordered, current, alert, minimum, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                     tuple(v[k] for k in ("mid", "image", "name", "spec", "unit", "pack", "ordered", "current", "alert", "minimum", "notes")))
    _refresh(db, cur.lastrowid, operator, True)
    db.commit()
    return dict(db.execute("SELECT * FROM materials WHERE id = ?", (cur.lastrowid,)).fetchone())


def edit(db, id_, field, value, operator):
    if not db.execute("SELECT 1 FROM materials WHERE id = ?", (id_,)).fetchone():
        raise ValueError("That row no longer exists.")
    v = _clean(field, value)  # raises for a column that cannot be edited, so the name below is always one of TEXT
    db.execute(f"UPDATE materials SET {field} = ? WHERE id = ?", (v, id_))
    _refresh(db, id_, operator, field != "notes")
    db.commit()
    return dict(db.execute("SELECT * FROM materials WHERE id = ?", (id_,)).fetchone())


def delete(db, id_):
    db.execute("DELETE FROM materials WHERE id = ?", (id_,))
    db.commit()


def bulk(db, operator, edits, new_rows):
    """A paste: cells of existing rows (edits: [{id, field, value}]) and whole new rows. Returns every row that was touched."""
    ids = []
    for e in edits[:5000]:
        f, i = str(e.get("field", "")), int(e.get("id", 0))
        v = _clean(f, e.get("value"))
        db.execute(f"UPDATE materials SET {f} = ? WHERE id = ?", (v, i))
        _refresh(db, i, operator, f != "notes")
        ids.append(i)
    for values in new_rows[:5000]:
        ids.append(add(db, operator, values)["id"])
    db.commit()
    return [dict(r) for i in dict.fromkeys(ids) for r in db.execute("SELECT * FROM materials WHERE id = ?", (i,))]
