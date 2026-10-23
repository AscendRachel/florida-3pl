"""Protected columns and rows, like "Protect range" in Google Sheets.

An admin protects a column, or some rows, of the orders or of the returns, and chooses who may TYPE in them:
  nobody - nobody types in them (imports, scans and the returns sync still write)
  admins - only admins
  people - admins plus the team members the admin picked
Admins always keep control of the protection itself. Everything is kept in data/locks.json, apart from the orders,
so importing orders never removes a protection.

File layout: {"defs": {lock id: {mode, users, note, by, at}},
              "orders":  {"cols": {column number: lock id}, "rows": {lock id: [[first row number, last row number], ...]}},
              "returns": {"cols": {field name: lock id},    "rows": {lock id: [return id, ...]}}}
"""
import bisect
import clock
import json
import os
import threading
import uuid
from datetime import datetime

FILE = None  # set by server.py
LOCK = threading.Lock()
MODES = ("nobody", "admins", "people")


def _empty():
    return {"defs": {}, "orders": {"cols": {}, "rows": {}}, "returns": {"cols": {}, "rows": {}}}


def load():
    try:
        d = json.loads(FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        d = _empty()
    for k, v in _empty().items():
        d.setdefault(k, v)
    return d


def _save(d):
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(d), encoding="utf-8")
    os.replace(tmp, FILE)


def runs(nums):
    """Sorted whole numbers -> [[first, last], ...] with consecutive numbers joined."""
    out = []
    for n in sorted(set(nums)):
        if out and n == out[-1][1] + 1:
            out[-1][1] = n
        else:
            out.append([n, n])
    return out


def _expand(ranges):
    return {n for a, b in ranges for n in range(a, b + 1)}


class Snapshot:
    """The locks at one moment, with quick lookups."""

    def __init__(self, d=None):
        self.d = d or load()
        self.defs = self.d["defs"]
        self._runs = {}  # sheet -> sorted [(first, last, id)]
        self._starts = {}
        rows = self.d["orders"]["rows"]
        flat = sorted((a, b, lid) for lid, rs in rows.items() for a, b in rs)
        self._runs["orders"] = flat
        self._starts["orders"] = [x[0] for x in flat]
        self._rids = {rid: lid for lid, rids in self.d["returns"]["rows"].items() for rid in rids}

    def col_id(self, sheet, key):
        return self.d[sheet]["cols"].get(str(key))

    def row_id(self, sheet, row):
        if sheet == "returns":
            return self._rids.get(str(row))
        i = bisect.bisect_right(self._starts["orders"], int(row)) - 1
        if i >= 0:
            a, b, lid = self._runs["orders"][i]
            if a <= int(row) <= b:
                return lid
        return None

    def why(self, actor, lock_id, what):
        """'' when this person may type in it, otherwise the reason that is shown to them."""
        lock = self.defs.get(lock_id)
        if not lock:
            return ""
        admin = actor.get("role") == "admin"
        if lock["mode"] == "admins":
            return "" if admin else f"This {what} is protected: only admins can edit it."
        if lock["mode"] == "people":
            return "" if admin or actor.get("username") in lock["users"] else f"This {what} is protected: only admins and the people an admin chose can edit it."
        note = f" {lock['note']}" if lock.get("note") else ""
        return f"This {what} is protected: nobody can type in it.{note}"

    def blocked(self, actor, sheet, col, row):
        """The reason this person may not edit this cell of this sheet, or ''."""
        msg = self.why(actor, self.col_id(sheet, col), "column")
        return msg or self.why(actor, self.row_id(sheet, row), "row")

    def public(self, sheet):
        """What a page needs: the lock definitions and which column each one protects."""
        return {"defs": self.defs, "cols": self.d[sheet]["cols"]}


def set_lock(sheet, kind, targets, mode, users, note, who, valid_users):
    """Protect (or, with mode "", unprotect) columns or rows. `targets` are column keys, row numbers or return ids."""
    if sheet not in ("orders", "returns") or kind not in ("col", "row"):
        raise ValueError("That cannot be protected.")
    if mode not in ("",) + MODES:
        raise ValueError("Choose who may edit it.")
    with LOCK:
        d = load()
        part = d[sheet]
        new_id = None
        if mode:
            picked = sorted({str(u) for u in (users or []) if str(u) in valid_users}) if mode == "people" else []
            new_id = uuid.uuid4().hex[:10]
            d["defs"][new_id] = {"mode": mode, "users": picked, "note": str(note or "").strip()[:200], "by": who,
                                 "at": clock.now().strftime("%Y-%m-%d %H:%M")}
        if kind == "col":
            for t in targets:
                part["cols"].pop(str(t), None)
                if new_id:
                    part["cols"][str(t)] = new_id
        elif sheet == "orders":
            chosen = {int(t) for t in targets}
            for lid in list(part["rows"]):  # take the chosen rows out of whatever protected them before
                left = _expand(part["rows"][lid]) - chosen
                if left:
                    part["rows"][lid] = runs(left)
                else:
                    del part["rows"][lid]
            if new_id:
                part["rows"][new_id] = runs(chosen)
        else:
            chosen = {str(t) for t in targets}
            for lid in list(part["rows"]):
                left = [r for r in part["rows"][lid] if r not in chosen]
                if left:
                    part["rows"][lid] = left
                else:
                    del part["rows"][lid]
            if new_id:
                part["rows"][new_id] = sorted(chosen)
        used = {lid for sh in ("orders", "returns") for lid in d[sh]["cols"].values()} | {lid for sh in ("orders", "returns") for lid in d[sh]["rows"]}
        d["defs"] = {k: v for k, v in d["defs"].items() if k in used}
        _save(d)
    return d
