"""Amazon order import: the orders file downloaded from Amazon Business fills in tracking numbers and delivery statuses.

Each line of the file is one item of one shipment. A line is matched to an All Orders row by its Order ID (the row's
Source Order Number). When an Amazon order holds several items, or one item was shipped in several parcels, the line is
matched by its Title (the row's Product Name), so the right row gets the right tracking number.

What it writes, per row:
  Source Tracking Number  the Carrier Tracking # (a row that ships in several parcels lists them separated by |)
  Source Order Status     from Delivery Status: Delivered / In Transit. (Unfulfilled is a row with no Amazon order number; the file never sets it.)
Rows that are already Delivered, Refunded, For Refund or Cancelled are left exactly as they are (tracking and status), because
a month's file lists finished orders again.
Several items of one Store Order No. that arrive on different days are Partially Delivered until the last one is here;
then they all become Delivered.
The import is shown as a preview first; nothing is written until an admin confirms it.
"""
import csv
import io
import re
import time
import uuid

from xlsx_reader import plain_number

TBA_SEPARATOR = "|"
HOLD = {"Refunded", "Cancelled", "For Refund"}  # set by people, never overwritten by the file
DONE = {x.lower() for x in HOLD | {"Delivered"}}  # finished rows: the file never rewrites them (a monthly file lists them again)
ARRIVED = {"Delivered", "Partially Delivered"}
PLANS = {}  # preview token -> (time, plan), kept in memory for an hour


def _words(text):
    return {w for w in re.findall(r"[a-z0-9]+", (text or "").lower()) if len(w) > 2}


def _similar(a, b):
    """0..1: how much of the shorter title's words the other title has too."""
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


def _int(v):
    try:
        return int(float(str(v).replace(",", "").strip()))
    except ValueError:
        return 0


def read_lines(data):
    """The lines of the Amazon file that have an Order ID. Raises ValueError when it is not that file."""
    text = data.decode("utf-8-sig", errors="replace")
    rd = csv.DictReader(io.StringIO(text, newline=""))
    need = {"Order ID", "Carrier Tracking #", "Delivery Status", "Title"}
    if not rd.fieldnames or not need <= set(rd.fieldnames):
        raise ValueError("This does not look like the orders file from Amazon. It needs the columns Order ID, Title, Carrier Tracking # and Delivery Status.")
    out = []
    for r in rd:
        oid = (r.get("Order ID") or "").strip()
        if not oid:
            continue
        out.append({"order": oid, "title": (r.get("Title") or "").strip(), "tracking": str(plain_number(re.sub(r'^="?|"$', "", (r.get("Carrier Tracking #") or "").strip()).strip())).upper(),
                    "delivery": (r.get("Delivery Status") or "").strip(), "shipment": (r.get("Shipment Status") or "").strip(),
                    "qty": _int(r.get("Item Quantity")) or _int(r.get("Shipment Quantity")) or 1})
    return out


def line_state(line):
    if line["delivery"].lower() == "delivered":
        return "delivered"
    if line["delivery"].lower() == "not delivered" or (line["shipment"].lower() == "shipped" and line["tracking"]):
        return "transit"
    if line["shipment"].lower() == "shipped":
        return "transit"
    return "unfulfilled"


def tokens(cell, fix=True):
    out = []
    for t in (cell or "").split(TBA_SEPARATOR):
        t = t.strip()
        t = (str(plain_number(t)) if fix else t).upper()  # 5.42923753189E11 -> 542923753189
        if t and t not in out:
            out.append(t)
    return out


def build_plan(rows, lines):
    """rows: [{rn, order, tracking, status, title, store}] from All Orders. Returns the plan (see below)."""
    by_order = {}
    for r in rows:
        if r["order"]:
            by_order.setdefault(r["order"], []).append(r)
    for r in rows:
        r["_w"] = _words(r["title"])
    lines_by_order = {}
    for ln in lines:
        lines_by_order.setdefault(ln["order"], []).append(ln)

    assigned = {}  # rn -> [lines]
    unmatched_orders, unsure = [], []
    for oid, group in lines_by_order.items():
        cands = by_order.get(oid)
        if not cands:
            unmatched_orders.append({"order": oid, "title": group[0]["title"], "lines": len(group)})
            continue
        taken = set()
        for ln in sorted(group, key=lambda x: -len(x["title"])):
            w = _words(ln["title"])
            best, best_score = None, -1.0
            for r in cands:
                score = _similar(w, r["_w"]) if len(cands) > 1 else 1.0
                if ln["tracking"] and ln["tracking"] in tokens(r["tracking"]):
                    score += 1
                if r["rn"] in taken:
                    score -= 0.5  # another item of this order goes to a row that is still free
                if score > best_score:
                    best, best_score = r, score
            if len(cands) > 1 and best_score <= 0.1:
                unsure.append({"order": oid, "title": ln["title"], "why": "no row of this order has a similar product name"})
                continue
            taken.add(best["rn"])
            assigned.setdefault(best["rn"], []).append(ln)

    row_by_rn = {r["rn"]: r for r in rows}
    changes, new_status = {}, {}
    skipped_done = 0
    for rn, got in assigned.items():
        r = row_by_rn[rn]
        if r["status"].lower() in DONE:
            skipped_done += 1
            continue
        have = tokens(r["tracking"])
        merged = list(have)
        for ln in got:
            if ln["tracking"] and ln["tracking"] not in merged:
                merged.append(ln["tracking"])
        states = [line_state(ln) for ln in got]
        # An order line can hold 2 of the same product that ship separately: the row is Delivered only when the delivered
        # quantity covers the row's QTY, otherwise it stays Partially Delivered (the file lists only what has shipped).
        got_qty = sum(ln["qty"] for ln in got)
        need = max(_int(r.get("qty")), got_qty)
        delivered_qty = sum(ln["qty"] for ln, st in zip(got, states) if st == "delivered")
        if delivered_qty >= need:
            want = "Delivered"
        elif delivered_qty > 0:
            want = "Partially Delivered"
        elif any(s == "transit" for s in states):
            want = "In Transit"
        else:
            want = "Unfulfilled"
        # what the operator counted in the Scan tab (Items Received) beats the file for what physically arrived
        counted = _int(r.get("items"))
        if counted and want in ("Delivered", "Partially Delivered"):
            want = "Delivered" if counted >= max(_int(r.get("qty")), 1) else "Partially Delivered"
        cur = r["status"]
        status = cur
        if cur in HOLD:
            status = cur
        elif want in ("Delivered", "Partially Delivered"):
            status = want
        elif want == "In Transit" and cur in ("", "Unfulfilled", "In Transit"):
            status = want
        # "Unfulfilled" means the row has no Amazon order number yet. A row that is in this file has one, so the file never sets it.
        ch = {}
        if merged != tokens(r["tracking"], fix=False):  # also rewrites a cell that Excel had turned into 5.4E11
            ch["Source Tracking Number"] = TBA_SEPARATOR.join(merged)
        if status != cur:
            ch["Source Order Status"] = status
        new_status[rn] = status
        if ch:
            changes[rn] = ch

    # items of one Store Order No. that arrive on different days: Partially Delivered until the last one is here
    stores = {}
    for r in rows:
        if r["store"]:
            stores.setdefault(r["store"], []).append(r)
    touched = {row_by_rn[rn]["store"] for rn in assigned if row_by_rn[rn]["store"]}
    for store in touched:
        group = [r for r in stores[store] if new_status.get(r["rn"], r["status"]) not in HOLD]
        if len(group) < 2:
            continue
        sts = {r["rn"]: new_status.get(r["rn"], r["status"]) for r in group}
        arrived = [rn for rn, s in sts.items() if s in ARRIVED]
        if not arrived:
            continue
        want = "Delivered" if len(arrived) == len(group) else "Partially Delivered"
        for rn in arrived:
            if row_by_rn[rn]["status"].lower() in DONE:
                continue  # already finished: counted as arrived, never rewritten
            if sts[rn] != want:
                new_status[rn] = want
                cur = row_by_rn[rn]["status"]
                ch = changes.setdefault(rn, {})
                if want != cur:
                    ch["Source Order Status"] = want
                else:
                    ch.pop("Source Order Status", None)
                if not ch:
                    changes.pop(rn, None)

    moves = {}
    for rn, ch in changes.items():
        if "Source Order Status" in ch:
            k = f"{row_by_rn[rn]['status'] or '(blank)'} → {ch['Source Order Status']}"
            moves[k] = moves.get(k, 0) + 1
    return {
        "lines": len(lines), "orders": len(lines_by_order), "matched_rows": len(assigned), "skipped_done": skipped_done,
        "tracking_added": sum(1 for c in changes.values() if "Source Tracking Number" in c),
        "status_changed": sum(1 for c in changes.values() if "Source Order Status" in c),
        "moves": sorted(({"move": k, "n": v} for k, v in moves.items()), key=lambda x: -x["n"]),
        "unmatched_orders": unmatched_orders, "unsure": unsure,
        "changes": {rn: {"changes": ch, "label": row_by_rn[rn]["label"], "order": row_by_rn[rn]["order"], "title": row_by_rn[rn]["title"],
                         "was": {"Source Tracking Number": row_by_rn[rn]["tracking"], "Source Order Status": row_by_rn[rn]["status"]}}
                    for rn, ch in changes.items()},
    }


def keep(plan):
    now = time.time()
    for k in [k for k, (t, _) in PLANS.items() if now - t > 3600]:
        del PLANS[k]
    token = uuid.uuid4().hex
    PLANS[token] = (now, plan)
    return token
