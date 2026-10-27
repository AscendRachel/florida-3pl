"""The Dashboard: the day's numbers, the same as the Dashboard tab of the Google Sheet.

Everything is counted from the orders for ONE day in US Eastern time,
which is how every date and time in the app is recorded.
Operators are the columns of the hourly table. Each one is a name for the person plus the sign-in names or e-mail
addresses that mean them (the sheet matched "Updated by" with an e-mail address). An admin edits the list; it is kept
in data/dashboard.json, apart from the orders, so an import never changes it.
"""
import json
import os
import re
from datetime import datetime

FILE = None  # set by server.py
DEFAULT_OPERATORS = [
    {"label": "Carlos", "match": []},
    {"label": "Bernardo", "match": []},
]


def operators():
    try:
        ops = json.loads(FILE.read_text(encoding="utf-8"))["operators"]
    except (OSError, ValueError, KeyError, TypeError):
        return [dict(o, match=list(o["match"])) for o in DEFAULT_OPERATORS]
    return ops


def save_operators(items):
    """Keep at most 8 operators, each with a name and the sign-in names / e-mails that mean them."""
    if not isinstance(items, list):
        raise ValueError("Send the list of operators.")
    out, seen = [], set()
    for it in items[:8]:
        label = str((it or {}).get("label", "")).strip()[:40]
        match = [m.strip() for m in (it or {}).get("match", []) if isinstance(m, str) and m.strip()][:10]
        if not label:
            continue
        for m in match:
            if m.lower() in seen:
                raise ValueError(f"“{m}” is listed for two operators.")
            seen.add(m.lower())
        out.append({"label": label, "match": match})
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"operators": out}), encoding="utf-8")
    os.replace(tmp, FILE)
    return out


def _hours(rows, ops):
    """rows: (hour, who, n) -> 24 rows of {"total", "by": [count per operator], "other"}."""
    who = {m.lower(): i for i, o in enumerate(ops) for m in o["match"] + [o["label"]]}
    table = [{"total": 0, "by": [0] * len(ops), "other": 0} for _ in range(24)]
    for hour, name, n in rows:
        if not str(hour).isdigit() or int(hour) > 23:
            continue
        t = table[int(hour)]
        t["total"] += n
        i = who.get(str(name or "").strip().lower())
        if i is None:
            t["other"] += n
        else:
            t["by"][i] += n
    return table


def _by_hour(db, col, stamp_name, kind, day):
    """(hour, operator, count) of the packages stamped on `day`. The operator is the one who did THAT shipping step (the ship
    record), so a later scan by someone else (a return to Amazon) does not take the count away; older rows fall back to Updated by."""
    c = col[stamp_name]
    return db.execute(
        f"SELECT substr(o.{c}, 12, 2), COALESCE((SELECT e.operator FROM ship_events e WHERE e.rn = o.rn AND e.kind = ? AND e.at = o.{c} "
        f"ORDER BY e.id DESC LIMIT 1), o.{col['Updated by']}), COUNT(*) FROM orders o WHERE substr(o.{c}, 1, 10) = ? GROUP BY 1, 2",
        (kind, day)).fetchall()


def compute(day, col, orders_db):
    """`col` maps the sheet's column names to the column holding them in the orders table (c12 ...)."""
    if not re.fullmatch(r"\d{4}-\d\d-\d\d", day or ""):
        raise ValueError("Pick a date.")
    datetime.strptime(day, "%Y-%m-%d")
    ops = operators()
    on = lambda c: f"substr({col[c]}, 1, 10) = ?"

    def one(sql, *args):
        return orders_db.execute(sql, args).fetchone()[0] or 0

    rows = _by_hour(orders_db, col, "SHIPPED TO  CUSTOMER DATE", "customer", day)
    hourly = _hours(rows, ops)
    store = _hours(_by_hour(orders_db, col, "SHIPPED TO  AMAZON DATE", "amazon", day), ops)
    cards = [
        {"key": "estimated", "label": "Estimated Delivery", "n": one(f"SELECT COUNT(*) FROM orders WHERE {on('Delivery Date')}", day)},
        {"key": "warehouse", "label": "Total Packages in Warehouse", "n": one(
            f"SELECT COUNT(*) FROM orders WHERE {col['Source Order Status']} = 'Delivered' AND {col['Shipped to Customer']} != 'TRUE' "
            f"AND {col['Package Not Received']} != 'TRUE' AND {col['Tracking Status']} = 'Preshipment'"), "note": "right now, not by day"},
        {"key": "hold", "label": "On Hold Orders", "n": one(f"SELECT COUNT(*) FROM orders WHERE {on('Hold Date')}", day)},
        {"key": "customer", "label": "Total Shipped to Customer", "n": sum(h["total"] for h in hourly)},
        {"key": "amazon", "label": "Total Shipped to Amazon", "n": one(f"SELECT COUNT(*) FROM orders WHERE {on('SHIPPED TO  AMAZON DATE')}", day)},
        {"key": "arrived", "label": "Packages Arrived Today", "n": one(f"SELECT COUNT(*) FROM orders WHERE {on('Delivered to Warehouse Date')}", day)},
    ]
    # the sheet's counter columns (RTS / RTA / Item on Hold / Store Returns / All Orders / Stock Counter): live totals, not by day
    open_ = f"{col['Shipped to Amazon']} != 'TRUE' AND {col['Stock']} != 'TRUE'"
    status = lambda v: one(f"SELECT COUNT(*) FROM orders WHERE {col['Tracking Status']} = '{v}' AND {open_}")
    has_order = f"{col['Store Order No.']} != ''"
    counters = [
        {"key": "rts", "label": "RTS Counter", "note": "Return to Sender, not yet shipped to Amazon", "n": status("Return to Sender")},
        {"key": "rta", "label": "RTA Counter", "note": "Return to Amazon, not yet shipped to Amazon", "n": status("Return to Amazon")},
        {"key": "holdc", "label": "Item on Hold Counter", "note": "Items ticked on hold", "n": one(f"SELECT COUNT(*) FROM orders WHERE {col['ITEM ON HOLD']} = 'TRUE'")},
        {"key": "storec", "label": "Store Returns Counter", "note": "Store Returns, not yet shipped to Amazon", "n": status("Store Returns")},
        {"key": "allc", "label": "All Orders Counter", "note": "Orders not yet shipped to the customer", "n": one(f"SELECT COUNT(*) FROM orders WHERE {has_order} AND {col['Shipped to Customer']} != 'TRUE'")},
        {"key": "stockc", "label": "Stock Counter", "note": "Orders taken from stock", "n": one(f"SELECT COUNT(*) FROM orders WHERE {has_order} AND {col['Stock']} = 'TRUE'")},
    ]
    return {"date": day, "cards": cards, "counters": counters, "operators": [o["label"] for o in ops], "orders": hourly, "returns": store,
            "orders_total": sum(h["total"] for h in hourly), "returns_total": sum(h["total"] for h in store)}
