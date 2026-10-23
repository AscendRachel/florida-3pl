"""The scan flow of the 3PL (the old "Tracking Number Sorter"): scan a TBA number, decide what happens to each order
row that is in that package, and record it.

Flow, per order row found for the scanned number:
  Return to Amazon  -> print the return label, do not ship to the customer
  Label Voided      -> VOIDED / REFUNDED, stop
  Package Not Rec.  -> FLAGGED, stop and tell the PH team
  Label Used        -> ALREADY PROCESSED, stop
  otherwise count the box (Boxes Received + 1), then
    received >= expected  -> COMPLETE: print the label, mark shipped
    received <  expected  -> HOLD (set Item On Hold + Hold Date); if it has been on hold more than 24 hours: OVERDUE,
                             ship it now and mark the missing pieces as Package Not Received

Everything here works on an open sqlite connection; server.py owns the locking and the HTTP side.
"""
import clock
import re
import urllib.error
import urllib.request
from datetime import datetime, timedelta

# the date column stamped by each shipping step -> the kind of ship event
SHIP_KINDS = {"SHIPPED TO  CUSTOMER DATE": "customer", "SHIPPED TO  AMAZON DATE": "amazon"}
OVERDUE_HOURS = 24
DRIVE_ID = re.compile(r"/d/([-\w]{25,})")
TBA_SEPARATOR = "|"

SCAN_SQL = [
    "CREATE TABLE IF NOT EXISTS boxes (rn INTEGER, code TEXT, at TEXT, PRIMARY KEY (rn, code))",
    # who shipped what and when: one row each time Shipped to Customer / Shipped to Amazon is stamped (right-click Updated by > Show shipping record)
    "CREATE TABLE IF NOT EXISTS ship_events (id INTEGER PRIMARY KEY AUTOINCREMENT, rn INTEGER, kind TEXT, at TEXT, operator TEXT, note TEXT)",
    "CREATE INDEX IF NOT EXISTS ix_ship_events ON ship_events (rn, kind, at)",
    "CREATE TABLE IF NOT EXISTS scans (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, operator TEXT, code TEXT, rn INTEGER, outcome TEXT, note TEXT)",
]

# outcome -> (title, tone, what to print)
OUTCOMES = {
    "return": ("RETURN TO AMAZON", "violet", "return"),
    "voided": ("VOIDED / REFUNDED", "crit", None),
    "pnr": ("FLAGGED: PACKAGE NOT RECEIVED", "crit", None),
    "processed": ("ALREADY PROCESSED", "warn", None),
    "complete": ("PRODUCT COMPLETE: SHIP NOW", "ok", "ship"),
    "hold": ("HOLD: MORE PIECES COMING", "warn", None),
    "overdue": ("OVERDUE HOLD WARNING", "crit", "ship_overdue"),
    "nolabel": ("NO LABEL FOUND", "crit", None),
}
_label_cache = {}


def now():
    return clock.now().replace(second=0, microsecond=0)


def stamp(dt):
    return dt.strftime("%Y-%m-%d %H:%M")


def parse_stamp(s):
    s = s.strip()
    for text, fmt in ((s[:16], "%Y-%m-%d %H:%M"), (s[:10], "%Y-%m-%d")):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def tokens(k):
    """The TBA numbers listed in Source Tracking Number (separated by |), without repeats."""
    out = []
    for t in (k or "").split(TBA_SEPARATOR):
        t = t.strip().upper()
        if t and t not in out:
            out.append(t)
    return out


def to_int(v, default=0):
    try:
        return int(float(str(v).replace(",", "")))
    except ValueError:
        return default


class Orders:
    """Read and write order rows by column name."""

    def __init__(self, db, ix, who=""):
        self.db, self.ix, self.who = db, ix, who
        self.select = "rn, " + ", ".join(f"c{i}" for i in range(max(ix.values()) + 1))

    def dict(self, r):
        d = {name: (r[i + 1] or "") for name, i in self.ix.items()}
        d["rn"] = r[0]
        return d

    def get(self, rn):
        r = self.db.execute(f"SELECT {self.select} FROM orders WHERE rn = ?", (rn,)).fetchone()
        return self.dict(r) if r else None

    def set(self, rn, values, note=""):
        """Write cells of one order and put every real change in the edit history (cell, old value, new value, who, why)."""
        if not values:
            return
        old = self.db.execute(f"SELECT {', '.join(f'c{self.ix[k]}' for k in values)} FROM orders WHERE rn = ?", (rn,)).fetchone()
        sets = ", ".join(f"c{self.ix[k]} = ?" for k in values)
        self.db.execute(f"UPDATE orders SET {sets} WHERE rn = ?", [*values.values(), rn])
        for key, kind in SHIP_KINDS.items():
            if values.get(key):
                self.db.execute("INSERT INTO ship_events (rn, kind, at, operator, note) VALUES (?,?,?,?,?)", (rn, kind, values[key], self.who, note))
        for k, before in zip(values, old or []):
            if (before or "") != values[k] and k != "Updated by":
                self.db.execute("INSERT INTO edit_log (at, who, rn, col, old, new, note) VALUES (?,?,?,?,?,?,?)",
                                (stamp(now()), self.who, rn, self.ix[k], before or "", values[k], note))


def log(db, operator, code, rn, outcome, note=""):
    db.execute("INSERT INTO scans (at, operator, code, rn, outcome, note) VALUES (?,?,?,?,?,?)",
               (stamp(now()), operator, code, rn, outcome, note))


def describe(d):
    return {
        "rn": d["rn"], "label": d["Label Number"], "product": d["Product Name"], "brand": d["Brand"], "qty": d["QTY"],
        "customer": d["Customer Name"], "store_order": d["Store Order No."], "source_order": d["Source Order Number"],
        "image": d["Product Image Link"], "has_label": bool(DRIVE_ID.search(d["Shipping Label Link"])),
        "store": d["Store"], "notes": d["Notes"],
    }


def result_for(d, outcome, message, **extra):
    title, tone, prints = OUTCOMES[outcome]
    return {**describe(d), "outcome": outcome, "title": title, "tone": tone, "message": message, "print": prints, **extra}


def hold_hours(d):
    since = parse_stamp(d["Hold Date"]) if d["ITEM ON HOLD"] == "TRUE" and d["Hold Date"] else None
    return None if since is None else (now() - since).total_seconds() / 3600


def siblings_on_hold(orders, d):
    """Other items of the same customer order that are waiting on a hold (the sheet's 'Hold Warning')."""
    if not d["Store Order No."]:
        return []
    rows = orders.db.execute(f"SELECT {orders.select} FROM orders WHERE c{orders.ix['Store Order No.']} = ? AND rn <> ? AND c{orders.ix['ITEM ON HOLD']} = 'TRUE'",
                             (d["Store Order No."], d["rn"])).fetchall()
    return [{"label": x["Label Number"], "product": x["Product Name"]} for x in map(orders.dict, rows)]


def evaluate(orders, d, code, dry):
    """Decide the outcome for one order row and apply the box count / hold changes. Returns the result dict."""
    db = orders.db
    if d["Tracking Status"] == "Return to Amazon":
        note = "It was already marked shipped to Amazon before." if d["Shipped to Amazon"] == "TRUE" else ""
        return result_for(d, "return", "Print the return label. Do not ship to the customer. Put it in the returns area. It is marked shipped to Amazon once the label prints. " + note)
    if d["Label Voided"] == "TRUE":
        return result_for(d, "voided", "Do not process or ship this item.")
    if d["Package Not Received"] == "TRUE":
        return result_for(d, "pnr", "Stop. Notify the PH team.")
    if d["Label Used"] == "TRUE":
        return result_for(d, "processed", "The label was already printed for this item. Stop.")

    listed = tokens(d["Source Tracking Number"])
    expected = len(listed) if listed else max(1, to_int(d["Boxes Expected"], 1))
    received = to_int(d["Boxes Received"])
    seen = db.execute("SELECT 1 FROM boxes WHERE rn = ? AND code = ?", (d["rn"], code)).fetchone()
    writes = {}
    if not seen:
        received += 1
        writes["Boxes Received"] = str(received)
        if not dry:
            db.execute("INSERT INTO boxes VALUES (?,?,?)", (d["rn"], code, stamp(now())))
    if d["Boxes Expected"] != str(expected):
        writes["Boxes Expected"] = str(expected)
    boxes = {"received": received, "expected": expected, "remaining": max(0, expected - received)}
    extra = {"boxes": boxes, "duplicate": bool(seen)}

    if received >= expected:
        if not DRIVE_ID.search(d["Shipping Label Link"]):
            if not dry:
                orders.set(d["rn"], writes, note=f"Scan {code}")
            return result_for(d, "nolabel", "This order has no shipping label link. Tell the PH team.", **extra)
        if not dry:
            orders.set(d["rn"], writes, note=f"Scan {code}")
        warn = siblings_on_hold(orders, d)
        return result_for(d, "complete", "All boxes are here. The label prints and the item is marked shipped.", siblings=warn, **extra)

    hours = hold_hours(d)
    if hours is not None and hours > OVERDUE_HOURS:
        if not dry:
            orders.set(d["rn"], writes, note=f"Scan {code}")
        return result_for(d, "overdue", f"On hold for {int(hours)} hours. Ship it now. The missing pieces will be marked Package Not Received.",
                          hold_hours=round(hours, 1), **extra)
    writes["ITEM ON HOLD"] = "TRUE"
    if not d["Hold Date"] or d["ITEM ON HOLD"] != "TRUE":
        writes["Hold Date"] = stamp(now())
    if not dry:
        orders.set(d["rn"], writes, note=f"Scan {code}")
    left = boxes["remaining"]
    return result_for(d, "hold", f"{left} more box{'es' if left != 1 else ''} expected. Put the item on the hold shelf.", siblings=siblings_on_hold(orders, d), **extra)


def scan(db, ix, code, operator, dry):
    code = (code or "").strip().upper()
    if not code:
        raise ValueError("Scan or type a tracking number.")
    if not dry and not operator.strip():
        raise ValueError("Enter your name first, so the scan is recorded under you.")
    orders = Orders(db, ix, operator)
    found = []
    for r in db.execute(f"SELECT {orders.select} FROM orders WHERE _s LIKE ?", (f"%{code.lower()}%",)):
        d = orders.dict(r)
        if code in tokens(d["Source Tracking Number"]) or d["Store Order No."].upper() == code:
            found.append(d)
        if len(found) >= 40:
            break
    results = []
    for d in found:
        res = evaluate(orders, d, code, dry)
        results.append(res)
        if not dry:
            log(db, operator, code, d["rn"], res["outcome"], res["message"][:200])
    if not found and not dry:
        log(db, operator, code, None, "notfound", "")
    return {"code": code, "found": bool(found), "practice": dry, "results": results}


def release(db, ix, rn, operator, dry):
    """Ship an overdue hold from the On hold list (the same result a scan of it would give after 24 hours)."""
    orders = Orders(db, ix)
    d = orders.get(rn)
    if not d or d["ITEM ON HOLD"] != "TRUE" or d["Label Used"] == "TRUE":
        raise ValueError("That item is not on hold any more.")
    hours = hold_hours(d)
    if hours is None or hours <= OVERDUE_HOURS:
        raise ValueError(f"It has not been on hold for {OVERDUE_HOURS} hours yet.")
    if not DRIVE_ID.search(d["Shipping Label Link"]):
        return {"code": "", "found": True, "practice": dry, "results": [result_for(d, "nolabel", "This order has no shipping label link. Tell the PH team.")]}
    return {"code": "", "found": True, "practice": dry, "results": [result_for(
        d, "overdue", f"On hold for {int(hours)} hours. Ship it now. The missing pieces will be marked Package Not Received.", hold_hours=round(hours, 1))]}


def confirm(db, ix, rn, kind, operator, dry, code=""):
    """The label went to the printer: record it."""
    orders = Orders(db, ix, operator)
    d = orders.get(rn)
    if not d:
        raise ValueError("That order no longer exists.")
    if kind in ("ship", "ship_overdue"):
        if d["Label Used"] == "TRUE":
            return {"already": True}
        writes = {"Label Used": "TRUE", "Shipped to Customer": "TRUE", "ITEM ON HOLD": "FALSE", "Hold Date": "",
                  "SHIPPED TO  CUSTOMER DATE": stamp(now()), "Updated by": operator}
        if d["Shipped to Amazon"] == "TRUE":  # the newest scan event wins: it is shipped to the customer now, not to Amazon (the old date is kept)
            writes["Shipped to Amazon"] = "FALSE"  # the date stays: it still counts as shipped by that operator
        if kind == "ship_overdue":
            writes["Package Not Received"] = "TRUE"
    elif kind == "return":
        if d["Shipped to Amazon"] == "TRUE":
            return {"already": True}
        writes = {"Shipped to Amazon": "TRUE", "SHIPPED TO  AMAZON DATE": stamp(now()), "Updated by": operator}
        if d["Shipped to Customer"] == "TRUE":  # the newest scan event wins: it went back to Amazon, so the tick goes, the date stays
            writes["Shipped to Customer"] = "FALSE"  # the date stays: it still counts as shipped by that operator
    else:
        raise ValueError("Unknown print kind.")
    if not dry:
        orders.set(rn, writes, note="Label printed" if kind == "ship" else "Overdue hold shipped" if kind == "ship_overdue" else "Return label printed")
        log(db, operator, code, rn, "printed" if kind != "ship_overdue" else "printed_overdue", kind)
    return {"ok": True}


RESTORABLE = ("Label Used", "Shipped to Customer", "SHIPPED TO  CUSTOMER DATE")


def mark_pnr(db, ix, rn, flag, operator, dry, code="", restore=None):
    """The operator found a product missing from the package: tick Package Not Received on that order.
    If the order was already marked shipped (its label printed on the scan), Label Used and Shipped to Customer are
    unticked again, and the old values are handed back so an Undo can put them back."""
    orders = Orders(db, ix, operator)
    d = orders.get(rn)
    if not d:
        raise ValueError("That order no longer exists.")
    writes = {"Package Not Received": "TRUE" if flag else "FALSE", "Updated by": operator}
    saved = {}
    if flag:
        if d["Label Used"] == "TRUE" or d["Shipped to Customer"] == "TRUE":
            for name in RESTORABLE:
                if d[name]:
                    saved[name] = d[name]
            writes.update({"Label Used": "FALSE", "Shipped to Customer": "FALSE", "SHIPPED TO  CUSTOMER DATE": ""})
    else:
        for name, value in (restore or {}).items():
            if name in RESTORABLE and isinstance(value, str) and len(value) <= 20:
                writes[name] = value
    if not dry:
        orders.set(rn, writes, note="Package not received" if flag else "Package not received flag removed")
        log(db, operator, code, rn, "pnr_marked" if flag else "pnr_cleared", "unshipped" if saved else "")
    return {"ok": True, "flag": flag, "unshipped": bool(saved), "restore": saved}


def holds(db, ix):
    orders = Orders(db, ix)
    out = []
    for r in db.execute(f"SELECT {orders.select} FROM orders WHERE c{ix['ITEM ON HOLD']} = 'TRUE' AND c{ix['Label Used']} <> 'TRUE' AND c{ix['Label Voided']} <> 'TRUE'"):
        d = orders.dict(r)
        listed = tokens(d["Source Tracking Number"])
        expected = len(listed) if listed else max(1, to_int(d["Boxes Expected"], 1))
        hours = hold_hours(d)
        out.append({**describe(d), "received": to_int(d["Boxes Received"]), "expected": expected, "tracking": d["Source Tracking Number"],
                    "since": d["Hold Date"], "hours": None if hours is None else round(hours, 1),
                    "overdue": hours is not None and hours > OVERDUE_HOURS})
    out.sort(key=lambda x: (x["hours"] is None, -(x["hours"] or 0)))
    return out


def recent(db, limit=60):
    return [dict(r) for r in db.execute(
        "SELECT s.id, s.at, s.operator, s.code, s.rn, s.outcome, s.note FROM scans s ORDER BY s.id DESC LIMIT ?", (limit,))]


def samples(db, ix):
    """One real example per situation, so the flow can be tried in practice mode without a scanner."""
    def c(n):
        return f"c{ix[n]}"
    base = f"{c('Label Used')} <> 'TRUE' AND {c('Label Voided')} <> 'TRUE' AND {c('Package Not Received')} <> 'TRUE' AND {c('Tracking Status')} <> 'Return to Amazon' AND {c('Shipping Label Link')} LIKE 'https://drive.google.com/%' AND {c('Boxes Received')} = ''"
    queries = [
        ("Complete: one box, ships now", f"{base} AND {c('Source Tracking Number')} LIKE 'TBA%' AND {c('Source Tracking Number')} NOT LIKE '%|%'"),
        ("Hold: this box is only one of several", f"{base} AND {c('Source Tracking Number')} LIKE 'TBA%|%TBA%'"),
        ("Voided / refunded", f"{c('Label Voided')} = 'TRUE' AND {c('Tracking Status')} <> 'Return to Amazon' AND {c('Source Tracking Number')} LIKE 'TBA%'"),
        ("Package not received (flagged)", f"{c('Package Not Received')} = 'TRUE' AND {c('Label Voided')} <> 'TRUE' AND {c('Tracking Status')} <> 'Return to Amazon' AND {c('Source Tracking Number')} LIKE 'TBA%'"),
        ("Already processed", f"{c('Label Used')} = 'TRUE' AND {c('Label Voided')} <> 'TRUE' AND {c('Package Not Received')} <> 'TRUE' AND {c('Tracking Status')} <> 'Return to Amazon' AND {c('Source Tracking Number')} LIKE 'TBA%'"),
        ("Return to Amazon", f"{c('Tracking Status')} = 'Return to Amazon' AND {c('Source Tracking Number')} LIKE 'TBA%'"),
    ]
    out = []
    for title, where in queries:
        r = db.execute(f"SELECT {c('Source Tracking Number')}, {c('Product Name')} FROM orders WHERE {where} ORDER BY rn LIMIT 1").fetchone()
        if r:
            out.append({"scenario": title, "code": tokens(r[0])[0], "product": r[1]})
    out.append({"scenario": "Not found", "code": "TBA000000000000", "product": ""})
    return out


def fetch_label(link, key):
    """Download a shipping label PDF from its Google Drive link (files shared with 'anyone with the link')."""
    if key in _label_cache:
        return _label_cache[key]
    m = DRIVE_ID.search(link or "")
    if not m:
        raise ValueError("This order has no shipping label link.")
    req = urllib.request.Request(f"https://drive.google.com/uc?export=download&id={m.group(1)}", headers={"User-Agent": "Florida3PL"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read(20 * 1024 * 1024)
    except (urllib.error.URLError, TimeoutError) as e:
        raise ValueError(f"Could not download the label from Google Drive ({e}).") from None
    if not data.startswith(b"%PDF"):
        raise ValueError("Google Drive did not return a PDF. Check that the label file is shared with 'anyone with the link'.")
    if len(_label_cache) > 60:
        _label_cache.pop(next(iter(_label_cache)))
    _label_cache[key] = data
    return data
