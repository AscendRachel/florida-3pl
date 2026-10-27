"""Florida 3PL orders: local web app. "All Orders" is the grid, "Import" loads an Excel / CSV export of the 3PL sheet.

Standard library only. Run `python server.py`, then open http://localhost:8765
"""
import amazon
import base64
import clock
import dashboard
import csv, hashlib, io, json, getpass, os, re, sys, sqlite3, tempfile, threading, time, urllib.error, urllib.parse, urllib.request, uuid
from datetime import datetime
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import auth
import locks
import returns
import scan
from xlsx_reader import Workbook, col_index, plain_number

ROOT = Path(__file__).parent
WEB = ROOT / "web"
DATA = ROOT / "data"
DB = DATA / "orders.db"
UPLOADS = DATA / "uploads"
returns.DB = DATA / "returns.db"
auth.DB = DATA / "auth.db"
locks.FILE = DATA / "locks.json"
# only admins may do these: they change what everybody sees or how the data is loaded
ADMIN_POST = {"/api/upload", "/api/upload-link", "/api/import", "/api/dropdown", "/api/returns/settings", "/api/dashboard/operators", "/api/returns/labels", "/api/branding"}  # and everything under /api/columns/ and /api/team/
# the checkbox that stamps a date and time when it is ticked -> the column that holds the stamp
SHIP_STAMP = {"Shipped to Customer": "SHIPPED TO  CUSTOMER DATE", "Shipped to Amazon": "SHIPPED TO  AMAZON DATE",
              "ITEM ON HOLD": "Hold Date"}
SHIP_OTHER = {"Shipped to Customer": "Shipped to Amazon", "Shipped to Amazon": "Shipped to Customer"}
dashboard.FILE = DATA / "dashboard.json"
BRANDING_FILE = DATA / "branding.json"  # the app's name, initials, colour and logo (an admin edits them in the Team tab)
LOGO_FILE = DATA / "branding_logo.bin"
DEFAULT_BRANDING = {"name": "Florida 3PL", "initials": "F3", "color": "#1f7a4d", "logo": "", "v": 0}
RETURN_LABELS_FILE = DATA / "return_labels.json"  # new names an admin gave the Returns columns {field: name}
VIEWS_FILE = DATA / "views.json"  # saved filter views, kept apart from the orders so an import never deletes them
SCHEMA_FILE = DATA / "schema.json"  # the list of columns: what the admins added and deleted
PORT = int(os.environ.get("PORT", "8765"))
MAX_UPLOAD = 300 * 1024 * 1024

csv.field_size_limit(10**9)
lock = threading.Lock()
uploads = {}  # upload id -> (path, original file name)
VERSION = [int(time.time())]  # goes up with every change to the orders, so open pages know when to refresh


def build_id():
    """A short fingerprint of everything in web/, so open pages can tell when a new version of the app is ready."""
    h = hashlib.md5()
    for f in sorted(WEB.rglob("*")):
        if f.is_file():
            st = f.stat()
            h.update(f"{f.relative_to(WEB)}:{st.st_mtime_ns}:{st.st_size}".encode())
    return h.hexdigest()[:12]


def watch_code():
    """Restart the app (exit code 3, which start.bat answers by starting it again) when its Python files change."""
    files = [ROOT / n for n in ("server.py", "scan.py", "returns.py", "auth.py", "locks.py", "xlsx_reader.py")]
    seen = {f: f.stat().st_mtime_ns for f in files}
    while True:
        time.sleep(2)
        try:
            if any(f.stat().st_mtime_ns != seen[f] for f in files):
                print("The app's code changed: restarting…", flush=True)
                os._exit(3)
        except OSError:
            continue


def bump():
    VERSION[0] += 1
    return VERSION[0]

returns.ON_CHANGE = bump


# The columns of the orders table, in this order. An import matches the file's header row to these by name.
DEFAULT_COLUMNS = [
    "Label Number", "Gift Note", "Store Order No.", "Product Name", "Brand", "QTY", "Customer Name", "Address",
    "Source Order Date", "Source Order Number", "Source Tracking Number", "Shipping Label Link", "Product Image Link",
    "Source Order Status", "Package Not Received", "To Void", "ITEM ON HOLD", "Stock", "Label Used",
    "Shipped to Customer", "Shipped to Amazon", "Label Voided", "Tracking Number To Customer", "Delivery Date",
    "Tracking Status", "Notes", "Store", "PH Team Internal Notes", "Days In Transit", "Number of Orders", "Print Link",
    "\U0001f510 Softr Record ID", "Number of Items", "Boxes Received", "Boxes Expected", "Hold Warning", "Hold Date",
    "SKU", "STOCK NO.", "TAPICKER STATUS", "TAPICKER SHIPPED DATE", "TAPICKER DELIVERY DATE", "Label Chip",
    "SHIPPED TO  CUSTOMER DATE", "SHIPPED TO  AMAZON DATE", "RTS COUNTER", "RTA COUNTER", "Item on Hold Counter",
    "Store Returns Counter", "All Orders Counter", "Stock Counter", "Updated by", "Delivered to Warehouse Date",
    "Items Received",
]
BOOLS = ["Package Not Received", "To Void", "ITEM ON HOLD", "Stock", "Label Used", "Shipped to Customer",
         "Shipped to Amazon", "Label Voided"]
DATES = ["Source Order Date", "Delivery Date", "Hold Date", "TAPICKER SHIPPED DATE", "TAPICKER DELIVERY DATE",
         "SHIPPED TO  CUSTOMER DATE", "SHIPPED TO  AMAZON DATE", "Delivered to Warehouse Date"]
NUMS = ["QTY", "Items Received", "Number of Orders", "Number of Items", "Boxes Received", "Boxes Expected", "RTS COUNTER",
        "RTA COUNTER", "Item on Hold Counter", "Store Returns Counter", "All Orders Counter", "Stock Counter"]
SELECTS = ["Source Order Status", "Tracking Status", "Store"]
SEARCH = ["Label Number", "Store Order No.", "Product Name", "Brand", "Customer Name", "Address",
          "Source Order Number", "Source Tracking Number", "Tracking Number To Customer", "Notes",
          "PH Team Internal Notes", "SKU", "Label Chip"]

MONTHS = {m: i + 1 for i, m in enumerate("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split())}
DATE_RE = re.compile(r"^\s*([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM))?\s*$")
ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$")
TRUE_WORDS = {"true", "yes", "y", "1", "x", "checked"}
FALSE_WORDS = {"false", "no", "n", "0"}


def fix_text(s):
    """Some exports have UTF-8 text that was read as Windows-1252 (e.g. 'â€“')."""
    if any(c in s for c in "âðÃ"):
        try:
            return s.encode("cp1252").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return s


def norm_date(s):
    m = DATE_RE.match(s)
    if not m or m.group(1) not in MONTHS:
        return s
    out = f"{int(m.group(3)):04d}-{MONTHS[m.group(1)]:02d}-{int(m.group(2)):02d}"
    if m.group(4):
        h = int(m.group(4)) % 12 + (12 if m.group(6) == "PM" else 0)
        out += f" {h:02d}:{m.group(5)}"
    return out


def kind_of(name):
    if name in BOOLS: return "bool"
    if name in DATES: return "date"
    if name in NUMS: return "num"
    if name in SELECTS: return "select"
    if name == "Product Image Link": return "img"
    if name in ("Shipping Label Link", "Print Link"): return "link"
    return "text"


# The orders table has one text column per entry below (c0, c1, ...). A column an admin deletes keeps its slot (so every
# other column keeps its number) but is emptied, renamed and left out of everything. New columns are added at the end.
COLUMNS, KINDS, ACTIVE, ENTRIES = [], [], [], []
IX, COLUMN_BY_KEY, SEARCH_IDX = {}, {}, []


def key_of(header):
    """Header cells match by name ignoring case, spacing and the emoji / encoding of the Softr column."""
    k = " ".join(fix_text(str(header)).split()).lower()
    return "softr record id" if "softr" in k else k


# Columns the Scan flow and the summary cards read by name: deleting one would break them.
PROTECTED = {
    n: "The Scan page reads it" for n in (
        "Label Number", "Store Order No.", "Product Name", "Brand", "QTY", "Customer Name", "Source Order Number",
        "Source Tracking Number", "Shipping Label Link", "Product Image Link", "Package Not Received", "Label Used",
        "Shipped to Customer", "Shipped to Amazon", "Label Voided", "Boxes Received", "Boxes Expected", "Hold Date",
        "Updated by", "SHIPPED TO  CUSTOMER DATE", "SHIPPED TO  AMAZON DATE", "Store", "Notes", "Items Received")}
PROTECTED.update({n: "A summary card on All Orders counts it" for n in ("Tracking Status", "ITEM ON HOLD", "To Void", "Stock")})
CUSTOM_KINDS = ("text", "num", "date", "bool", "dropdown")
# Calculated columns: the column on the left is always the columns on the right written one after the other (in the Google
# Sheet, Gift Note is =Label Number & Customer Name). Nobody types in them; they follow when their sources change.
FORMULAS = {"Gift Note": ["Label Number", "Customer Name"]}


def formula_cols():
    return {IX[t] for t, src in FORMULAS.items() if t in IX and all(s in IX for s in src)}


def formula_sources():
    return {IX[s] for t, src in FORMULAS.items() if t in IX and all(s in IX for s in src) for s in src}


def formula_text(name):
    return " + ".join(FORMULAS[name]) if name in FORMULAS else ""


def recompute_formulas(db, rns=None):
    """Fill every calculated column from its sources, for all rows or only the given row numbers."""
    for target, sources in FORMULAS.items():
        if target not in IX or any(s not in IX for s in sources):
            continue
        sql = f"UPDATE orders SET c{IX[target]} = " + " || ".join(f"COALESCE(c{IX[s]}, '')" for s in sources)
        if rns is None:
            db.execute(sql)
        else:
            rns = list(rns)
            for i in range(0, len(rns), 500):
                chunk = rns[i:i + 500]
                db.execute(sql + f" WHERE rn IN ({','.join('?' * len(chunk))})", chunk)


def apply_schema(entries):
    ENTRIES[:] = entries
    COLUMNS[:] = [e["name"] for e in entries]
    KINDS[:] = [e["kind"] for e in entries]
    ACTIVE[:] = [not e.get("deleted") for e in entries]
    IX.clear()
    IX.update({e["name"]: i for i, e in enumerate(entries) if not e.get("deleted")})
    COLUMN_BY_KEY.clear()
    COLUMN_BY_KEY.update({key_of(e["name"]): i for i, e in enumerate(entries) if not e.get("deleted")})
    # a renamed column also answers to its new name (an import file may use either)
    COLUMN_BY_KEY.update({key_of(e["label"]): i for i, e in enumerate(entries) if e.get("label") and not e.get("deleted") and key_of(e["label"]) not in COLUMN_BY_KEY})
    SEARCH_IDX[:] = [IX[n] for n in SEARCH if n in IX]


def load_schema():
    try:
        entries = json.loads(SCHEMA_FILE.read_text(encoding="utf-8"))["columns"]
    except (OSError, ValueError, KeyError):
        entries = [{"name": n, "kind": kind_of(n)} for n in DEFAULT_COLUMNS]
    apply_schema(entries)


def save_schema():
    tmp = SCHEMA_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({"columns": ENTRIES}, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, SCHEMA_FILE)


load_schema()

EDITS_SQL = "CREATE TABLE IF NOT EXISTS edits (rn INTEGER, col INTEGER, value TEXT, at TEXT, PRIMARY KEY (rn, col))"
# dropdown (list validation) rules: each cell points at a list of allowed values
DD_SQL = ["CREATE TABLE IF NOT EXISTS lists (id INTEGER PRIMARY KEY, options TEXT, strict INTEGER)",
          "CREATE TABLE IF NOT EXISTS dv (rn INTEGER, col INTEGER, list_id INTEGER, PRIMARY KEY (rn, col))",
          # every change to a cell: who, when, from what to what (right-click a cell > Show edit history)
          "CREATE TABLE IF NOT EXISTS edit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, who TEXT, rn INTEGER, col INTEGER, old TEXT, new TEXT, note TEXT)",
          "CREATE INDEX IF NOT EXISTS ix_edit_log ON edit_log (rn, col)",
          # rows an admin deleted, kept whole so they can be restored
          "CREATE TABLE IF NOT EXISTS trash_rows (rn INTEGER PRIMARY KEY, label TEXT, product TEXT, customer TEXT, data TEXT, by TEXT, at TEXT)"]


def clean_value(kind, v):
    """Normalise what someone typed into a cell; raise ValueError with a plain message if it does not fit."""
    v = v.replace("\r\n", "\n").strip()
    if kind == "bool":
        w = v.lower()
        if w in TRUE_WORDS: return "TRUE"
        if w in FALSE_WORDS: return "FALSE"
        if w == "": return ""
        raise ValueError("a checkbox column only takes TRUE or FALSE")
    if kind == "num" and v:
        try:
            f = float(v.replace(",", ""))
        except ValueError:
            raise ValueError("this column only takes numbers") from None
        return str(int(f)) if f == int(f) else str(f)
    if kind == "date" and v:
        d = norm_date(v)
        if not ISO_RE.match(d):
            raise ValueError("use a date like Mar 6, 2026")
        return d
    return v


def check_dropdown(db, rn, col, v):
    """If the cell has a dropdown, return the matching choice (fixing the capitals), or refuse a value that is not one."""
    row = db.execute("SELECT l.options, l.strict FROM dv JOIN lists l ON l.id = dv.list_id WHERE dv.rn = ? AND dv.col = ?", (rn, col)).fetchone()
    if not row or v == "":
        return v
    options = json.loads(row[0])
    for o in options:
        if o.lower() == v.lower():
            return o
    if row[1]:
        raise ValueError("choose one of: " + ", ".join(options))
    return v


def init_db(path):
    """Create an empty orders database with the fixed set of columns."""
    if path.exists():
        path.unlink()
    db = sqlite3.connect(path)
    db.execute(f"CREATE TABLE orders (rn INTEGER PRIMARY KEY, {', '.join(f'c{i} TEXT' for i in range(len(COLUMNS)))}, _s TEXT)")
    db.execute("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)")
    db.execute(EDITS_SQL)
    for q in DD_SQL + scan.SCAN_SQL:
        db.execute(q)
    for j, k in enumerate(KINDS):
        if k in ("bool", "select"):
            db.execute(f"CREATE INDEX i{j} ON orders(c{j})")
    db.commit()
    db.close()


def sync_table_columns():
    """Add any column the schema has but the table lacks (for example after restoring an older database file)."""
    db = sqlite3.connect(DB)
    have = {r[1] for r in db.execute("PRAGMA table_info(orders)")}
    for i in range(len(COLUMNS)):
        if f"c{i}" not in have:
            db.execute(f"ALTER TABLE orders ADD COLUMN c{i} TEXT DEFAULT ''")
    db.commit()
    db.close()


def attach_custom_dropdowns(db):
    """Give every order a dropdown in each added 'Dropdown' column (new rows from an import included)."""
    for i, e in enumerate(ENTRIES):
        if e.get("deleted") or not e.get("dropdown"):
            continue
        opts = json.dumps(e["options"])
        row = db.execute("SELECT id FROM lists WHERE options = ? AND strict = 1", (opts,)).fetchone()
        lid = row[0] if row else db.execute("INSERT INTO lists (options, strict) VALUES (?, 1)", (opts,)).lastrowid
        db.execute("INSERT OR IGNORE INTO dv (rn, col, list_id) SELECT rn, ?, ? FROM orders", (i, lid))


def connect(path=None):
    db = sqlite3.connect(path or DB)
    db.row_factory = sqlite3.Row
    db.execute(EDITS_SQL)
    for q in DD_SQL + scan.SCAN_SQL:
        db.execute(q)
    return db


def ensure_items_column():
    """Orders made before the Scan tab counted items have no "Items Received" column: add it to the schema (the table follows)."""
    if "Items Received" in IX or any(e.get("was") == "Items Received" for e in ENTRIES):
        return
    apply_schema([*ENTRIES, {"name": "Items Received", "kind": "num"}])
    save_schema()


def ensure_db():
    DATA.mkdir(exist_ok=True)
    UPLOADS.mkdir(exist_ok=True)
    for f in UPLOADS.iterdir():  # files uploaded but never imported
        f.unlink(missing_ok=True)
    if not DB.exists():
        init_db(DB)
    ensure_items_column()
    sync_table_columns()
    db = sqlite3.connect(DB)
    recompute_formulas(db)
    db.commit()
    db.close()


# ---------------------------------------------------------------- import

def read_sheet_rows(path, sheet, rules=None):
    """Yield (row number, [cells]) for the chosen sheet of an .xlsx, or for a .csv file.
    When `rules` is a list, the sheet's dropdown rules are added to it once every row has been read."""
    if path.suffix.lower() == ".csv":
        with open(path, encoding="utf-8-sig", newline="") as f:
            for n, r in enumerate(csv.reader(f), start=1):
                if any(c.strip() for c in r):
                    yield n, r
    else:
        wb = Workbook(path)
        target = dict(wb.sheets())[sheet]
        yield from wb.rows(target)
        if rules is not None:
            rules.extend(wb.validations)


def find_header(rows):
    """First row (within the first 15) that contains a 'Label Number' cell -> (row number, column map) or None."""
    for n, r in rows:
        if n > 15:
            return None
        keys = [key_of(c) for c in r]
        if "label number" in keys:
            return n, keys
    return None


def preview(path):
    """Describe the file: which tabs look like the orders tab."""
    if path.suffix.lower() == ".csv":
        found = find_header(read_sheet_rows(path, None))
        return [{"name": "CSV file", "ok": bool(found), "matched": sum(k in COLUMN_BY_KEY for k in found[1]) if found else 0}]
    wb = Workbook(path)
    out = []
    for name, target in wb.sheets():
        found = find_header(wb.rows(target, limit=15))
        out.append({"name": name, "ok": bool(found), "matched": sum(k in COLUMN_BY_KEY for k in found[1]) if found else 0})
    return out


def parse_orders(path, sheet):
    """Read the orders out of a sheet -> (rows aligned to COLUMNS keyed by their row number, report)."""
    rules = []
    rows = read_sheet_rows(path, sheet, rules)
    found = find_header(rows)
    if not found:
        raise ValueError(f"The tab \"{sheet}\" has no header row with a \"Label Number\" column in its first 15 rows.")
    _header_row, keys = found
    pos = {}  # file column -> our column
    for fc, k in enumerate(keys):
        if k in COLUMN_BY_KEY and COLUMN_BY_KEY[k] not in pos.values():
            pos[fc] = COLUMN_BY_KEY[k]
    ignored = [k for k in keys if k and k not in COLUMN_BY_KEY]
    out, skipped = [], 0
    for n, r in rows:  # the same generator: carries on right after the header row
        vals = [""] * len(COLUMNS)
        for fc, oc in pos.items():
            if fc < len(r):
                vals[oc] = plain_number(fix_text(str(r[fc])).strip())
        if not any(vals) or vals[0] == "Counters":
            skipped += 1
            continue
        for j, k in enumerate(KINDS):
            if k == "date" and vals[j]:
                vals[j] = norm_date(vals[j])
            elif k == "bool":
                vals[j] = vals[j].upper() if vals[j].upper() in ("TRUE", "FALSE") else ""
        out.append((n, vals))
    missing = [COLUMNS[i] for i in range(len(COLUMNS)) if ACTIVE[i] and not ENTRIES[i].get("custom") and i not in pos.values()]
    dropdowns, unsupported = parse_dropdowns(rules)
    return out, {"matched": len(pos), "ignored": ignored, "missing": missing, "skipped": skipped,
                 "dropdowns_unsupported": unsupported}, (dropdowns, pos)


CELL_RE = re.compile(r"^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$")


def parse_dropdowns(rules):
    """The sheet's list validations -> ([{options, strict, cells: [(col1, col2, row1, row2)]}], number skipped).
    Only lists typed into the rule ("Yes,No,Maybe") are supported; lists that point at a range of cells are skipped."""
    out, skipped = [], 0
    for d in rules:
        if d["type"] != "list":
            continue
        f = d["formula"].strip()
        if not (len(f) >= 2 and f[0] == f[-1] == '"'):
            skipped += 1
            continue
        options = [o.strip() for o in f[1:-1].replace('""', '"').split(",") if o.strip()]
        cells = []
        for tok in d["sqref"].split():
            m = CELL_RE.match(tok)
            if m:
                c1 = col_index(m.group(1))
                cells.append((c1, col_index(m.group(3)) if m.group(3) else c1, int(m.group(2)), int(m.group(4) or m.group(2))))
        if options and cells:
            out.append({"options": options, "strict": d["strict"], "cells": cells})
    return out, skipped


def insert_orders(db, rows, start_rn=None):
    """rows: [(row number, values)]. With start_rn the row numbers are renumbered from there (for 'add to existing')."""
    ph = ",".join("?" * (len(COLUMNS) + 2))
    names = "rn, " + ", ".join(f"c{i}" for i in range(len(COLUMNS))) + ", _s"
    batch, rn_of = [], {}
    for i, (n, vals) in enumerate(rows):
        rn = start_rn + i if start_rn is not None else n
        rn_of[n] = rn
        batch.append((rn, *vals, " ".join(vals[j] for j in SEARCH_IDX).lower()))
        if len(batch) >= 2000:
            db.executemany(f"INSERT INTO orders ({names}) VALUES ({ph})", batch)
            batch = []
    if batch:
        db.executemany(f"INSERT INTO orders ({names}) VALUES ({ph})", batch)
    return rn_of


def insert_dropdowns(db, dropdowns, pos, rn_of):
    """Attach each dropdown list to the cells it covers. Returns (lists used, cells covered)."""
    ids = {(r[1], r[2]): r[0] for r in db.execute("SELECT id, options, strict FROM lists")}
    cells, used = {}, set()
    last = max(rn_of) if rn_of else 0
    for d in dropdowns:
        key = (json.dumps(d["options"]), int(d["strict"]))
        if key not in ids:
            ids[key] = db.execute("INSERT INTO lists (options, strict) VALUES (?, ?)", key).lastrowid
        for c1, c2, r1, r2 in d["cells"]:
            for fc in range(c1, c2 + 1):
                if fc not in pos:
                    continue
                for n in range(r1, min(r2, last) + 1):
                    if n in rn_of:
                        cells[(rn_of[n], pos[fc])] = ids[key]
                        used.add(ids[key])
    db.executemany("INSERT OR REPLACE INTO dv VALUES (?,?,?)", [(rn, c, lid) for (rn, c), lid in cells.items()])
    return len(used), len(cells)


def save_upload(data, name):
    """Keep an uploaded file until it is imported -> {id, file, sheets, pick}."""
    ext = Path(name).suffix.lower()
    if ext not in (".xlsx", ".csv"):
        raise ValueError("Upload an Excel .xlsx file or a .csv file. (In Google Sheets: File > Download > Microsoft Excel.)")
    uid = uuid.uuid4().hex
    path = UPLOADS / f"{uid}{ext}"
    path.write_bytes(data)
    try:
        sheets = preview(path)
    except Exception as e:  # noqa: BLE001 - a corrupt or renamed file
        path.unlink(missing_ok=True)
        raise ValueError(f"Could not read that file as {ext}: {e}") from None
    uploads[uid] = (path, name)
    pick = next((s["name"] for s in sheets if s["ok"] and s["name"].lower() == "march"), None)         or next((s["name"] for s in sheets if s["ok"]), None)
    return {"id": uid, "file": name, "sheets": sheets, "pick": pick}


def run_import(upload_id, sheet, mode):
    if upload_id not in uploads:
        raise ValueError("That upload is no longer on the server. Choose the file again.")
    path, filename = uploads[upload_id]
    rows, report, (dropdowns, pos) = parse_orders(path, sheet)
    if not rows:
        raise ValueError("The tab has a header row but no orders under it.")
    stamp = json.dumps({"file": filename, "sheet": sheet, "mode": mode, "at": clock.now().isoformat(timespec="seconds")})
    if mode == "dropdowns":
        # keep the orders and edits as they are; only reload the dropdown lists. Rows are matched by sheet row number
        # (which is how a "replace" import numbers them), and checked against the Label Number so a wrong file is caught.
        with lock:
            db = connect()
            label = {r[0]: r[1] for r in db.execute("SELECT rn, c0 FROM orders")}
            rn_of = {n: n for n, vals in rows if label.get(n) == vals[0]}
            if len(rn_of) < 0.9 * len(label):
                db.close()
                raise ValueError("This file does not line up with the orders in the app (the Label Numbers differ), so its dropdowns were not applied. Use it with 'Replace everything' instead.")
            db.execute("DELETE FROM dv")
            db.execute("DELETE FROM lists")
            lists, dd_cells = insert_dropdowns(db, dropdowns, pos, rn_of)
            attach_custom_dropdowns(db)
            db.commit()
            db.close()
        try:
            path.unlink()
        except OSError:
            pass
        del uploads[upload_id]
        return {"rows": 0, **report, "dropdown_lists": lists, "dropdown_cells": dd_cells}
    if mode == "replace":
        tmp = Path(tempfile.mkdtemp(dir=DATA)) / "new.db"
        init_db(tmp)
        db = sqlite3.connect(tmp)
        lists, dd_cells = insert_dropdowns(db, dropdowns, pos, insert_orders(db, rows))
        attach_custom_dropdowns(db)
        recompute_formulas(db)
        db.execute("INSERT INTO meta VALUES ('imported', ?)", (stamp,))
        db.commit()
        db.close()
        with lock:
            os.replace(tmp, DB)
        tmp.parent.rmdir()
    else:
        with lock:
            db = connect()
            nxt = max(db.execute("SELECT MAX(rn) FROM orders").fetchone()[0] or 2, db.execute("SELECT MAX(rn) FROM trash_rows").fetchone()[0] or 2) + 1
            lists, dd_cells = insert_dropdowns(db, dropdowns, pos, insert_orders(db, rows, start_rn=nxt))
            attach_custom_dropdowns(db)
            recompute_formulas(db)
            db.execute("INSERT OR REPLACE INTO meta VALUES ('imported', ?)", (stamp,))
            db.commit()
            db.close()
    try:
        path.unlink()
    except OSError:
        pass
    del uploads[upload_id]
    return {"rows": len(rows), **report, "dropdown_lists": lists, "dropdown_cells": dd_cells}


# ---------------------------------------------------------------- queries

def header_info():
    return COLUMNS, KINDS


# Quick-filter cards on top of the page: (key, label, hint, tone, column, value)
CARDS = [
    ("all", "All orders", "Every order", "neutral", None, None),
    ("delivered", "Delivered", "Tracking status", "ok", "Tracking Status", "Delivered"),
    ("transit", "In transit", "Tracking status", "info", "Tracking Status", "In Transit"),
    ("preship", "Pre-shipment", "Label made, not yet scanned", "violet", "Tracking Status", "Preshipment"),
    ("shipped", "Shipped to customer", "Ticked on the sheet", "ok", "Shipped to Customer", "TRUE"),
    ("amazon", "Shipped to Amazon", "Ticked on the sheet", "info", "Shipped to Amazon", "TRUE"),
    ("hold", "Item on hold", "Needs a decision", "warn", "ITEM ON HOLD", "TRUE"),
    ("void", "To void", "Label to cancel", "crit", "To Void", "TRUE"),
    ("notrec", "Package not received", "Waiting at the warehouse", "crit", "Package Not Received", "TRUE"),
    ("stock", "Stock", "Item taken from stock", "violet", "Stock", "TRUE"),
    ("returns", "Store returns", "Tracking status", "warn", "Tracking Status", "Store Returns"),
    ("rts", "Return to sender", "Tracking status", "warn", "Tracking Status", "Return to Sender"),
]


def like_arg(text):
    return "%" + text.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def column_conditions(j, f):
    """SQL for one column's filter: f = {"c": {op, a, b} (condition), "v": {mode: "in"|"out", list: [...]} (values)}."""
    out, args = [], []
    col, kind = f"c{j}", KINDS[j]
    c = f.get("c")
    if c and c.get("op"):
        op, a, b = c["op"], str(c.get("a", "")).strip(), str(c.get("b", "")).strip()
        if op == "empty":
            out.append(f"{col} = ''")
        elif op == "notempty":
            out.append(f"{col} <> ''")
        elif kind == "num":
            sym = {"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}
            try:
                x = float(a.replace(",", ""))
                y = float(b.replace(",", "")) if op == "between" else 0
            except ValueError:
                raise ValueError(f"{COLUMNS[j]}: enter a number for the filter.") from None
            if op == "between":
                out.append(f"{col} <> '' AND CAST({col} AS REAL) BETWEEN ? AND ?")
                args += [min(x, y), max(x, y)]
            elif op in sym:
                out.append(f"{col} <> '' AND CAST({col} AS REAL) {sym[op]} ?")
                args.append(x)
        elif kind == "date":
            if not ISO_RE.match(a) and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", a):
                raise ValueError(f"{COLUMNS[j]}: pick a date for the filter.")
            sym = {"eq": "=", "lt": "<", "gt": ">"}
            expr = f"substr({col}, 1, 10)"
            guard = f"{col} GLOB '[0-9][0-9][0-9][0-9]-*'"
            if op == "between":
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", b[:10]):
                    raise ValueError(f"{COLUMNS[j]}: pick the second date too.")
                out.append(f"{guard} AND {expr} BETWEEN ? AND ?")
                args += [min(a[:10], b[:10]), max(a[:10], b[:10])]
            elif op in sym:
                out.append(f"{guard} AND {expr} {sym[op]} ?")
                args.append(a[:10])
        else:
            if op == "contains":
                out.append(f"LOWER({col}) LIKE ? ESCAPE '\\'")
                args.append(like_arg(a))
            elif op == "notcontains":
                out.append(f"LOWER({col}) NOT LIKE ? ESCAPE '\\'")
                args.append(like_arg(a))
            elif op == "starts":
                out.append(f"LOWER({col}) LIKE ? ESCAPE '\\'")
                args.append(like_arg(a)[1:])
            elif op == "ends":
                out.append(f"LOWER({col}) LIKE ? ESCAPE '\\'")
                args.append(like_arg(a)[:-1])
            elif op == "eq":
                out.append(f"LOWER({col}) = ?")
                args.append(a.lower())
    v = f.get("v")
    if v:
        vals = [str(x) for x in (v.get("list") or [])]
        if len(vals) > 20000:
            raise ValueError("Too many values are selected in one filter.")
        if v.get("mode") == "in":
            if vals:
                out.append(f"{col} IN ({','.join('?' * len(vals))})")
                args += vals
            else:
                out.append("0")
        elif vals:
            out.append(f"{col} NOT IN ({','.join('?' * len(vals))})")
            args += vals
    return out, args


def build_where(p, skip=None):
    """p: {q, card, flt: {column index: filter}}. `skip` leaves one column's own filter out (for its value list)."""
    where, args = [], []
    for term in str(p.get("q", "")).strip().lower().split():
        where.append("_s LIKE ?")
        args.append(f"%{term}%")
    card = p.get("card", "")
    for key, _l, _h, _t, col, val in CARDS:
        if key == card and col:
            where.append(f"c{COLUMNS.index(col)} = ?")
            args.append(val)
    for key, f in (p.get("flt") or {}).items():
        if not str(key).isdigit() or int(key) >= len(COLUMNS) or not ACTIVE[int(key)] or int(key) == skip or not isinstance(f, dict):
            continue
        w, a = column_conditions(int(key), f)
        where += w
        args += a
    return (" WHERE " + " AND ".join(f"({w})" for w in where)) if where else "", args


def flatten(params):
    """A GET query string -> the same dict a POST body gives."""
    p = {k: v[0] for k, v in params.items()}
    p["flt"] = json.loads(p.get("flt") or "{}")
    return p


def load_branding():
    try:
        return {**DEFAULT_BRANDING, **json.loads(BRANDING_FILE.read_text(encoding="utf-8"))}
    except (OSError, ValueError):
        return dict(DEFAULT_BRANDING)


IMAGE_TYPES = ((b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg"), (b"GIF8", "image/gif"))


def save_branding(b):
    cur = load_branding()
    name = " ".join(str(b.get("name", "")).split())[:40]
    initials = "".join(str(b.get("initials", "")).split())[:3]
    color = str(b.get("color", "")).strip().lower()
    if not name:
        raise ValueError("Give the app a name.")
    if not re.fullmatch(r"#[0-9a-f]{6}", color):
        raise ValueError("Pick a colour.")
    new = {"name": name, "initials": initials or name[:2].upper(), "color": color, "logo": cur["logo"], "v": cur["v"]}
    logo = b.get("logo")
    if b.get("remove_logo"):
        new["logo"] = ""
        LOGO_FILE.unlink(missing_ok=True)
        new["v"] += 1
    elif logo:
        try:
            raw = base64.b64decode(str(logo).split(",", 1)[-1], validate=False)
        except ValueError:
            raise ValueError("That image could not be read.") from None
        kind = next((t for sig, t in IMAGE_TYPES if raw.startswith(sig)), "image/webp" if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP" else "")
        if not kind:
            raise ValueError("Use a PNG, JPG, GIF or WebP image.")
        if len(raw) > 1_500_000:
            raise ValueError("The logo can be up to 1.5 MB.")
        LOGO_FILE.write_bytes(raw)
        new["logo"], new["v"] = kind, new["v"] + 1
    tmp = BRANDING_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(new, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, BRANDING_FILE)
    bump()
    return new


def load_return_labels():
    try:
        return json.loads(RETURN_LABELS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def load_views():
    try:
        return json.loads(VIEWS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []


def clean_view(b):
    """What a filter view remembers: the search, the summary card, every column filter and the sort."""
    cf = {}
    for k, f in (b.get("cf") or {}).items():
        if not str(k).isdigit() or not isinstance(f, dict):
            continue
        c, v = f.get("c"), f.get("v")
        cond = {"op": str(c.get("op", ""))[:20], "a": str(c.get("a", ""))[:200], "b": str(c.get("b", ""))[:200]} if isinstance(c, dict) and c.get("op") else None
        vals = {"mode": "in" if v.get("mode") == "in" else "out", "list": [str(x)[:200] for x in (v.get("list") or [])[:2000]]} if isinstance(v, dict) else None
        if cond or vals:
            cf[str(k)] = {"c": cond, "v": vals}
    return {"q": str(b.get("q", ""))[:200], "card": str(b.get("card", ""))[:40], "cf": cf,
            "sort": str(b.get("sort", ""))[:4], "dir": "desc" if b.get("dir") == "desc" else "asc"}


class Handler(BaseHTTPRequestHandler):
    server_version = "Florida3PL"

    def log_message(self, fmt, *a):
        pass

    def send_json(self, obj, status=200, headers=None):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    # ---- who is asking
    def token(self):
        m = SimpleCookie(self.headers.get("Cookie") or "").get(auth.COOKIE)
        return m.value if m else None

    def client_ip(self):
        fwd = self.headers.get("X-Forwarded-For")
        return fwd.split(",")[0].strip() if fwd else self.client_address[0]

    def is_local_direct(self):
        return self.client_address[0] in ("127.0.0.1", "::1") and not self.headers.get("X-Forwarded-For")

    def https(self):
        return self.headers.get("X-Forwarded-Proto") == "https"

    def redirect(self, to):
        self.send_response(302)
        self.send_header("Location", to)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def need_user(self, admin=False):
        """The signed-in user, or None after answering the request with 401 / 403 / a redirect to the sign-in page."""
        u = auth.session_user(self.token())
        if not u:
            if urllib.parse.urlparse(self.path).path.startswith("/api/"):
                self.send_json({"error": "Please sign in."}, 401)
            else:
                self.redirect("/login")
            return None
        if admin and u["role"] != "admin":
            self.send_json({"error": "Only admins can do this."}, 403)
            return None
        self.user = u
        return u

    def session_cookie(self, username):
        return {"Set-Cookie": auth.cookie_value(auth.new_session(username), self.https())}

    # ---- GET
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(u.query)
        if u.path == "/login":
            return self.page("login.html")
        if u.path == "/api/build":
            return self.send_json({"build": build_id()})
        if u.path == "/api/branding":  # public: the sign-in page shows it too
            return self.send_json(load_branding())
        if u.path == "/branding/logo":
            b = load_branding()
            try:
                data = LOGO_FILE.read_bytes()
            except OSError:
                data = b""
            if not b["logo"] or not data:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", b["logo"])
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path == "/api/setup-needed":
            return self.send_json({"setup": auth.user_count() == 0, "allowed": self.is_local_direct()})
        if u.path.startswith("/static/"):
            return self.static(u.path)
        user = self.need_user(admin=u.path in ("/api/team", "/api/trash"))
        if not user:
            return
        try:
            if u.path == "/api/me":
                return self.send_json({**user, "tz_offset_min": clock.offset_minutes()})
            if u.path == "/api/dashboard":
                return self.send_json(self.api_dashboard(params))
            if u.path == "/api/team":
                return self.send_json({"items": auth.list_users()})
            if u.path == "/api/views":
                return self.send_json({"views": load_views()})
            if u.path == "/api/ship-events":
                return self.send_json(self.api_ship_events(params))
            if u.path == "/api/history":
                return self.send_json(self.api_history(params))
            if u.path == "/api/trash":
                return self.send_json(self.api_trash())
            if u.path == "/api/meta":
                return self.send_json(self.api_meta())
            if u.path == "/api/orders":
                return self.send_json(self.api_orders(flatten(params)))
            if u.path == "/api/values":
                return self.send_json(self.api_values(flatten(params)))
            if u.path == "/api/version":
                return self.send_json({"v": VERSION[0]})
            if u.path == "/api/returns":
                return self.send_json(self.api_returns())
            if u.path == "/api/scan/holds":
                return self.send_json({"holds": self.read_db(lambda db: scan.holds(db, IX))})
            if u.path == "/api/scan/recent":
                return self.send_json({"scans": self.read_db(lambda db: scan.recent(db))})
            if u.path == "/api/scan/samples":
                return self.send_json({"samples": self.read_db(lambda db: scan.samples(db, IX))})
            if u.path == "/api/label":
                return self.send_label(int(params.get("rn", ["0"])[0]))
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001 - report to the page instead of dropping the connection
            return self.send_json({"error": str(e)}, 500)
        if u.path in ("/", ""):
            return self.page("index.html")
        self.send_response(404)
        self.end_headers()

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_UPLOAD:
            raise ValueError("That file is too large (limit 300 MB).")
        return self.rfile.read(n)

    # ---- POST
    def do_POST(self):
        path = self.path.split("?")[0]
        try:
            if path == "/api/login":
                return self.api_login(json.loads(self.body() or b"{}"))
            if path == "/api/setup":
                return self.api_setup(json.loads(self.body() or b"{}"))
            if path == "/api/logout":
                tok = self.token()
                if tok:
                    auth.end_session(tok)
                return self.send_json({"ok": True}, headers={"Set-Cookie": auth.cookie_value("", self.https(), 0)})
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        user = self.need_user(admin=path in ADMIN_POST or path.startswith("/api/team/") or path.startswith("/api/columns/") or (path.startswith("/api/rows/") and path != "/api/rows/add") or path.startswith("/api/locks/") or path.startswith("/api/amazon/"))
        if not user:
            return
        try:
            if path == "/api/amazon/preview":
                return self.send_json(self.api_amazon_preview())
            if path == "/api/amazon/apply":
                return self.send_json(self.api_amazon_apply(json.loads(self.body() or b"{}")))
            if path == "/api/branding":
                return self.send_json(save_branding(json.loads(self.body() or b"{}")))
            if path == "/api/dashboard/operators":
                return self.send_json({"operators": dashboard.save_operators(json.loads(self.body() or b"{}").get("operators"))})
            if path == "/api/me/password":
                return self.api_change_password(json.loads(self.body() or b"{}"))
            if path.startswith("/api/team/"):
                return self.send_json(self.api_team(path, json.loads(self.body() or b"{}")))
            if path.startswith("/api/columns/"):
                return self.send_json(self.api_columns(path, json.loads(self.body() or b"{}")))
            if path.startswith("/api/rows/"):
                return self.send_json(self.api_rows(path, json.loads(self.body() or b"{}")))
            if path == "/api/locks/set":
                return self.send_json(self.api_locks_set(json.loads(self.body() or b"{}")))
            if path.startswith("/api/views/"):
                return self.send_json(self.api_views(path, json.loads(self.body() or b"{}")))
            if path == "/api/cells":
                return self.send_json(self.api_cells(json.loads(self.body() or b"{}")))
            if path == "/api/orders":
                return self.send_json(self.api_orders(json.loads(self.body() or b"{}")))
            if path == "/api/values":
                return self.send_json(self.api_values(json.loads(self.body() or b"{}")))
            if path.startswith("/api/returns/"):
                return self.send_json(self.api_returns_post(path, json.loads(self.body() or b"{}")))
            if path in ("/api/scan", "/api/scan/confirm", "/api/scan/release", "/api/scan/pnr", "/api/scan/count"):
                return self.send_json(self.api_scan(path, json.loads(self.body() or b"{}")))
            if path == "/api/dropdown":
                return self.send_json(self.api_dropdown(json.loads(self.body() or b"{}")))
            if path == "/api/upload":
                return self.send_json(self.api_upload())
            if path == "/api/upload-link":
                return self.send_json(self.api_upload_link(json.loads(self.body() or b"{}")))
            if path == "/api/import":
                b = json.loads(self.body() or b"{}")
                if b.get("mode") not in ("replace", "append", "dropdowns"):
                    raise ValueError("Choose whether to replace or add to the existing orders.")
                out = run_import(b.get("id", ""), b.get("sheet", ""), b["mode"])
                bump()
                return self.send_json(out)
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            return self.send_json({"error": f"{path}: {e}"}, 500)
        self.send_json({"error": "Not found"}, 404)

    # ---- sign in, first admin, password, team
    def api_login(self, b):
        ip = self.client_ip()
        if auth.too_many_failures(ip):
            return self.send_json({"error": "Too many failed sign-ins. Wait 10 minutes and try again."}, 429)
        u = auth.check_login(b.get("username"), b.get("password"))
        if not u:
            auth.note_failure(ip)
            return self.send_json({"error": "Wrong username or password."}, 401)
        auth.FAILED.pop(ip, None)
        self.send_json({"ok": True}, headers=self.session_cookie(u["username"]))

    def api_setup(self, b):
        if auth.user_count() > 0:
            return self.send_json({"error": "Setup is already done. Sign in instead."}, 403)
        if not self.is_local_direct():
            return self.send_json({"error": "Create the first admin on the server itself."}, 403)
        username = auth.add_user(b.get("username"), b.get("name"), b.get("password"), "admin")
        self.send_json({"ok": True}, headers=self.session_cookie(username))

    def api_change_password(self, b):
        if not auth.check_login(self.user["username"], b.get("current")):
            raise ValueError("Your current password is wrong.")
        auth.set_password(self.user["username"], b.get("new"))
        self.send_json({"ok": True}, headers=self.session_cookie(self.user["username"]))

    def api_team(self, path, b):
        me = self.user["username"]
        if path == "/api/team/add":
            auth.add_user(b.get("username"), b.get("name"), b.get("password"), b.get("role", "member"))
        elif path == "/api/team/reset":
            auth.set_password(str(b.get("username", "")), b.get("password"))
        elif path == "/api/team/remove":
            auth.remove_user(str(b.get("username", "")), me)
        elif path == "/api/team/role":
            auth.set_role(str(b.get("username", "")), str(b.get("role", "")), me)
        else:
            raise ValueError("Not found")
        return {"items": auth.list_users()}

    # ---- pages and files
    def page(self, name):
        body = (WEB / name).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def static(self, path):
        f = (WEB / path.lstrip("/")).resolve()
        if (WEB / "static").resolve() not in f.parents or not f.is_file():
            self.send_response(404)
            self.end_headers()
            return
        types = {".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript",
                 ".svg": "image/svg+xml", ".png": "image/png"}
        stat = f.stat()
        etag = '"%x-%x"' % (stat.st_mtime_ns, stat.st_size)
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return
        body = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", types.get(f.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("ETag", etag)
        self.end_headers()
        self.wfile.write(body)

    def api_dashboard(self, p):
        day = str((p.get("date") or [""])[0] or clock.now().strftime("%Y-%m-%d"))
        col = {name: f"c{IX[name]}" for name in ("Delivery Date", "Source Order Status", "Shipped to Customer", "Package Not Received",
                                                 "Tracking Status", "Hold Date", "SHIPPED TO  CUSTOMER DATE", "SHIPPED TO  AMAZON DATE",
                                                 "Delivered to Warehouse Date", "Updated by", "Shipped to Amazon", "Stock", "ITEM ON HOLD", "Store Order No.")}
        with lock:
            db = connect()
            try:
                out = dashboard.compute(day, col, db)
            finally:
                db.close()
        out["operators_list"] = dashboard.operators()
        out["today"] = clock.now().strftime("%Y-%m-%d")
        out["now"] = clock.now().strftime("%Y-%m-%d %H:%M")
        return out

    def api_meta(self):
        with lock:
            db = connect()
            sums = ", ".join(
                f"SUM(c{COLUMNS.index(col)} = '{val}')" if col else "COUNT(*)" for _k, _l, _h, _t, col, val in CARDS)
            counts = list(db.execute(f"SELECT {sums} FROM orders").fetchone())
            row = db.execute("SELECT v FROM meta WHERE k='imported'").fetchone()
            db.close()
        cards = [{"key": k, "label": lab, "hint": h, "tone": t, "n": n or 0}
                 for (k, lab, h, t, _c, _v), n in zip(CARDS, counts)]
        return {"columns": [{"i": i, "name": ENTRIES[i].get("label") or h, "key": h, "kind": k, "custom": bool(ENTRIES[i].get("custom")), "protected": PROTECTED.get(h, ""),
                             "formula": formula_text(h) if i in formula_cols() else "",
                             "formula_from": [IX[s] for s in FORMULAS[h]] if i in formula_cols() else []}
                            for i, (h, k) in enumerate(zip(COLUMNS, KINDS)) if ACTIVE[i]],
                "cards": cards, "total": cards[0]["n"], "imported": json.loads(row[0]) if row else None,
                "locks": locks.Snapshot().public("orders")}

    def api_orders(self, p):
        with lock:
            db = connect()
            where, args = build_where(p)
            total = db.execute(f"SELECT COUNT(*) FROM orders{where}", args).fetchone()[0]
            sort = str(p.get("sort", ""))
            order = "rn"
            if sort.isdigit() and int(sort) < len(COLUMNS):
                j = int(sort)
                d = "DESC" if p.get("dir") == "desc" else "ASC"
                expr = f"CAST(c{j} AS REAL)" if KINDS[j] == "num" else f"c{j}"
                order = f"(c{j} = '') ASC, {expr} {d}, rn"
            offset = max(0, int(p.get("offset", 0)))
            if p.get("rns_only"):
                got = db.execute(f"SELECT rn FROM orders{where} ORDER BY {order} LIMIT ? OFFSET ?", [*args, max(1, int(p.get("limit", 1))), offset]).fetchall()
                db.close()
                return {"rns": [r[0] for r in got]}
            limit = min(500, max(1, int(p.get("limit", 100))))
            cols = ", ".join(f"c{i}" for i in range(len(COLUMNS)))
            rows = db.execute(f"SELECT rn, {cols} FROM orders{where} ORDER BY {order} LIMIT ? OFFSET ?",
                              [*args, limit, offset]).fetchall()
            rns = [r[0] for r in rows]
            marks = ",".join("?" * len(rns))
            dv = {f"{a}:{b}": c for a, b, c in db.execute(f"SELECT rn, col, list_id FROM dv WHERE rn IN ({marks})", rns)} if rns else {}
            lists = {i: {"options": json.loads(o), "strict": bool(st)} for i, o, st in db.execute(
                f"SELECT id, options, strict FROM lists WHERE id IN ({','.join('?' * len(set(dv.values())))})", list(set(dv.values())))} if dv else {}
            db.close()
        snap = locks.Snapshot()
        rl = {rn: lid for rn in rns if (lid := snap.row_id("orders", rn))}
        lk = snap.public("orders")
        lk["defs"] = {i: lk["defs"][i] for i in set(rl.values()) | set(lk["cols"].values()) if i in lk["defs"]}
        lk["rows"] = rl
        return {"total": total, "offset": offset, "rows": [list(r) for r in rows], "dv": dv, "lists": lists, "locks": lk}

    def api_values(self, p):
        """The distinct values of one column with how many orders have each, among the orders that the OTHER filters
        leave visible (so the list in a column's filter menu only offers values that can still appear)."""
        j = int(p.get("col", 0))
        if not 0 <= j < len(COLUMNS) or not ACTIVE[j]:
            raise ValueError("bad column")
        where, args = build_where(p, skip=j)
        search = str(p.get("s", "")).strip().lower()
        if search:
            where += (" AND " if where else " WHERE ") + f"LOWER(c{j}) LIKE ? ESCAPE '\\'"
            args.append(like_arg(search))
        order = f"CAST(c{j} AS REAL)" if KINDS[j] == "num" else f"c{j} COLLATE NOCASE"
        with lock:
            db = connect()
            rows = db.execute(f"SELECT c{j}, COUNT(*) FROM orders{where} GROUP BY c{j} ORDER BY (c{j} <> ''), {order} LIMIT 501", args).fetchall()
            db.close()
        return {"values": [{"v": r[0], "n": r[1]} for r in rows[:500]], "more": len(rows) > 500}

    def api_upload(self):
        """Save the uploaded file (raw request body) and report which tabs look like the orders tab."""
        name = urllib.parse.unquote(self.headers.get("X-Filename", "upload"))
        data = self.body()
        if not data:
            raise ValueError("The file is empty.")
        return save_upload(data, name)

    def api_upload_link(self, body):
        """Download a Google Sheet as .xlsx from its link (the sheet must be shared 'Anyone with the link can view')."""
        m = re.search(r"docs\.google\.com/spreadsheets/d/([A-Za-z0-9_-]{20,})", str(body.get("url", "")))
        if not m:
            raise ValueError("That doesn't look like a Google Sheets link. It should start with https://docs.google.com/spreadsheets/d/…")
        req = urllib.request.Request(f"https://docs.google.com/spreadsheets/d/{m.group(1)}/export?format=xlsx",
                                     headers={"User-Agent": "Florida3PL"})
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                data = resp.read(MAX_UPLOAD + 1)
        except urllib.error.HTTPError as e:
            raise ValueError(f"Google refused the download (error {e.code}). Share the sheet as \"Anyone with the link can view\" and try again.") from None
        except urllib.error.URLError as e:
            raise ValueError(f"Could not reach Google Sheets: {e.reason}") from None
        if len(data) > MAX_UPLOAD:
            raise ValueError("That sheet is too large (limit 300 MB).")
        if not data.startswith(b"PK"):
            raise ValueError("Google did not return a spreadsheet. Share the sheet as \"Anyone with the link can view\" and try again.")
        return save_upload(data, "Google Sheet (" + m.group(1)[:8] + "…).xlsx")

    def api_returns(self):
        with returns.LOCK:
            db = returns.connect()
            try:
                snap = locks.Snapshot()
                lk = snap.public("returns")
                lk["rows"] = {rid: lid for lid, rids in snap.d["returns"]["rows"].items() for rid in rids}
                return {"rows": returns.list_rows(db, DB), "status": returns.status(db), "locks": lk, "labels": load_return_labels()}
            finally:
                db.close()

    def api_returns_post(self, path, b):
        if path == "/api/returns/labels":
            field = str(b.get("k", ""))
            if field not in returns.SOURCE_FIELDS and field not in ("rid", "image", "shipped", "processed_at", "processed_by", "wh_notes"):
                raise ValueError("That column does not exist.")
            label = " ".join(str(b.get("label", "")).split())
            if len(label) > 60:
                raise ValueError("The name can be up to 60 characters.")
            labels = load_return_labels()
            if label:
                labels[field] = label
            else:
                labels.pop(field, None)
            tmp = RETURN_LABELS_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(labels, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, RETURN_LABELS_FILE)
            bump()
            return {"labels": labels}
        if path == "/api/returns/sync":
            result = returns.sync("manual")
        elif path == "/api/returns/settings":
            with returns.LOCK:
                db = returns.connect()
                try:
                    returns.save_settings(db, b)
                finally:
                    db.close()
            result = {}
        elif path == "/api/returns/edit":
            with returns.LOCK:
                db = returns.connect()
                try:
                    reason = locks.Snapshot().blocked(self.user, "returns", str(b.get("field", "")), str(b.get("rid", "")))
                    if reason:
                        raise ValueError(reason)
                    row = returns.edit(db, str(b.get("rid", "")), str(b.get("field", "")), b.get("value"), self.user["name"], bool(b.get("revert")))
                finally:
                    db.close()
            bump()
            return {"row": row, "v": VERSION[0]}
        else:
            raise ValueError("Not found")
        with returns.LOCK:
            db = returns.connect()
            try:
                return {**result, "status": returns.status(db)}
            finally:
                db.close()

    def read_db(self, fn):
        with lock:
            db = connect()
            try:
                return fn(db)
            finally:
                db.close()

    def api_scan(self, path, b):
        operator, dry = self.user["name"][:60], bool(b.get("dry"))
        with lock:
            db = connect()
            try:
                if path == "/api/scan":
                    out = scan.scan(db, IX, str(b.get("code", "")), operator, dry)
                elif path == "/api/scan/count":
                    out = scan.count_items(db, IX, int(b["rn"]), str(b.get("code", "")), int(b.get("items", -1)), operator, dry)
                elif path == "/api/scan/release":
                    out = scan.release(db, IX, int(b["rn"]), operator, dry)
                elif path == "/api/scan/pnr":
                    if not dry and not operator:
                        raise ValueError("Enter your name first, so this is recorded under you.")
                    out = scan.mark_pnr(db, IX, int(b["rn"]), bool(b.get("flag", True)), operator, dry, str(b.get("code", "")), b.get("restore"))
                else:
                    out = scan.confirm(db, IX, int(b["rn"]), str(b.get("kind", "")), operator, dry, str(b.get("code", "")))
                db.commit()
                if not dry and path != "/api/scan/release":
                    bump()
                return out
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()

    def send_label(self, rn):
        """The shipping label PDF of an order, fetched from Google Drive, so the browser can print it."""
        with lock:
            db = connect()
            try:
                d = scan.Orders(db, IX).get(rn)
            finally:
                db.close()
        if not d:
            raise ValueError("That order no longer exists.")
        data = scan.fetch_label(d["Shipping Label Link"], rn)
        self.send_response(200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def api_views(self, path, b):
        me, admin = self.user, self.user["role"] == "admin"
        with lock:
            views = load_views()
            vid = str(b.get("id") or "")
            cur = next((v for v in views if v["id"] == vid), None)
            if path in ("/api/views/save", "/api/views/rename", "/api/views/delete") and cur and cur["owner"] != me["username"] and not admin:
                raise ValueError("Only the person who made this view, or an admin, can change it.")
            if path == "/api/views/delete":
                views = [v for v in views if v["id"] != vid]
            elif path in ("/api/views/save", "/api/views/rename"):
                name = str(b.get("name") or (cur["name"] if cur else "")).strip()[:80]
                if not name:
                    raise ValueError("A filter view needs a name.")
                if path == "/api/views/rename" and not cur:
                    raise ValueError("That view no longer exists.")
                rec = dict(cur) if cur else {"id": uuid.uuid4().hex[:16], "owner": me["username"], "owner_name": me["name"]}
                rec["name"] = name
                if path == "/api/views/save":
                    rec.update(clean_view(b))
                views = [rec if v["id"] == rec["id"] else v for v in views] if cur else [*views, rec]
            else:
                raise ValueError("Not found")
            tmp = VIEWS_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(views, indent=1), encoding="utf-8")
            os.replace(tmp, VIEWS_FILE)
        return {"views": views}

    def api_locks_set(self, b):
        sheet, kind, mode = str(b.get("sheet", "")), str(b.get("kind", "")), str(b.get("mode", ""))
        targets = b.get("targets") or []
        if not targets:
            raise ValueError("Nothing chosen to protect.")
        if sheet == "orders" and kind == "col":
            for t in targets:
                if not str(t).isdigit() or not 0 <= int(t) < len(COLUMNS) or not ACTIVE[int(t)]:
                    raise ValueError("That column does not exist.")
        elif sheet == "returns" and kind == "col":
            allowed = set(returns.SOURCE_FIELDS) | {"shipped", "processed_at", "processed_by", "wh_notes", "rid", "image"}
            if any(str(t) not in allowed for t in targets):
                raise ValueError("That column does not exist.")
        valid = {u["username"] for u in auth.list_users()}
        locks.set_lock(sheet, kind, targets, mode, b.get("users"), b.get("note"), self.user["name"], valid)
        bump()
        return {"ok": True}

    def api_history(self, params):
        rn, col = int(params.get("rn", ["0"])[0]), int(params.get("col", ["-1"])[0])
        if not 0 <= col < len(COLUMNS) or not ACTIVE[col]:
            raise ValueError("That column does not exist.")
        with lock:
            db = connect()
            try:
                rows = db.execute("SELECT at, who, old, new, note FROM edit_log WHERE rn = ? AND col = ? ORDER BY id DESC LIMIT 200", (rn, col)).fetchall()
            finally:
                db.close()
        return {"events": [dict(r) for r in rows]}

    def api_amazon_preview(self):
        """Read the Amazon orders file (raw request body) and show what importing it would change. Nothing is written yet."""
        data = self.body()
        if not data:
            raise ValueError("The file is empty.")
        lines = amazon.read_lines(data)
        if not lines:
            raise ValueError("The file has no orders in it.")
        names = ("Source Order Number", "Source Tracking Number", "Source Order Status", "Product Name", "Store Order No.", "Label Number", "QTY", "Items Received")
        with lock:
            db = connect()
            try:
                q = f"SELECT rn, {', '.join(f'c{IX[n]}' for n in names)} FROM orders"
                rows = [{"rn": r[0], "order": (r[1] or "").strip(), "tracking": r[2] or "", "status": (r[3] or "").strip(), "title": r[4] or "",
                         "store": (r[5] or "").strip(), "label": r[6] or "", "qty": r[7] or "", "items": r[8] or ""} for r in db.execute(q)]
            finally:
                db.close()
        plan = amazon.build_plan(rows, lines)
        token = amazon.keep(plan)
        shown = [{"rn": rn, **c} for rn, c in list(plan["changes"].items())[:300]]
        return {**{k: v for k, v in plan.items() if k != "changes"}, "unmatched_orders": plan["unmatched_orders"][:100],
                "unmatched_total": len(plan["unmatched_orders"]), "shown": shown, "changed_total": len(plan["changes"]), "token": token,
                "file": urllib.parse.unquote(self.headers.get("X-Filename", "file"))}

    def api_amazon_apply(self, b):
        entry = amazon.PLANS.get(str(b.get("token", "")))
        if not entry:
            raise ValueError("That preview has expired. Choose the file again.")
        plan = entry[1]
        with lock:
            db = connect()
            try:
                orders = scan.Orders(db, IX, self.user["name"])
                skipped = 0
                for rn, c in plan["changes"].items():
                    # a last check against the live data: a finished row is never rewritten, even by an older preview
                    now_status = (db.execute(f"SELECT c{IX['Source Order Status']} FROM orders WHERE rn = ?", (int(rn),)).fetchone() or [""])[0] or ""
                    if now_status.strip().lower() in amazon.DONE:
                        skipped += 1
                        continue
                    orders.set(int(rn), c["changes"], note="Amazon import")
                    cleaned = scan.delivered_cleanup(orders, int(rn), "Amazon import: row is Delivered") if c["changes"].get("Source Order Status") == "Delivered" else {}
                    if cleaned:
                        r = db.execute(f"SELECT {', '.join(f'c{j}' for j in SEARCH_IDX)} FROM orders WHERE rn = ?", (int(rn),)).fetchone()
                        db.execute("UPDATE orders SET _s = ? WHERE rn = ?", (" ".join(x or "" for x in r).lower(), int(rn)))
                    if any(IX[k] in SEARCH_IDX for k in c["changes"]):
                        r = db.execute(f"SELECT {', '.join(f'c{j}' for j in SEARCH_IDX)} FROM orders WHERE rn = ?", (int(rn),)).fetchone()
                        db.execute("UPDATE orders SET _s = ? WHERE rn = ?", (" ".join(x or "" for x in r).lower(), int(rn)))
                db.commit()
                bump()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()
        amazon.PLANS.pop(str(b.get("token")), None)
        return {"ok": True, "rows": len(plan["changes"]) - skipped, "tracking_added": plan["tracking_added"], "status_changed": plan["status_changed"]}

    def api_ship_events(self, params):
        rn = int(params.get("rn", ["0"])[0])
        with lock:
            db = connect()
            try:
                rows = db.execute("SELECT at, kind, operator, note FROM ship_events WHERE rn = ? ORDER BY id DESC LIMIT 100", (rn,)).fetchall()
            finally:
                db.close()
        return {"events": [dict(r) for r in rows]}

    def api_trash(self):
        with lock:
            db = connect()
            try:
                rows = [dict(r) for r in db.execute("SELECT rn, label, product, customer, by, at FROM trash_rows ORDER BY at DESC, rn DESC LIMIT 500")]
                total = db.execute("SELECT COUNT(*) FROM trash_rows").fetchone()[0]
            finally:
                db.close()
        cols = [{"i": i, "name": e.get("was", ""), "by": e.get("deleted_by", ""), "at": e.get("deleted_at", ""), "custom": bool(e.get("custom"))}
                for i, e in enumerate(ENTRIES) if e.get("deleted")]
        return {"rows": rows, "total": total, "columns": cols}

    def add_rows(self, rows):
        """New rows at the bottom. Each row is {column number: value}; columns not mentioned start empty."""
        rows = [r for r in rows if isinstance(r, dict)][:500]
        snap0 = locks.Snapshot()
        if not rows:
            raise ValueError("No rows to add.")
        names = ", ".join(f"c{i}" for i in range(len(COLUMNS)))
        marks = ", ".join("?" * (len(COLUMNS) + 2))
        now = clock.now().strftime("%Y-%m-%d %H:%M")
        new = []
        with lock:
            db = connect()
            try:
                top = max(db.execute("SELECT MAX(rn) FROM orders").fetchone()[0] or 2, db.execute("SELECT MAX(rn) FROM trash_rows").fetchone()[0] or 2)
                # a new row gets the dropdown that most of the column's cells have
                lists = {}
                for col, lid, _n in db.execute("SELECT col, list_id, COUNT(*) n FROM dv GROUP BY col, list_id ORDER BY n"):
                    lists[col] = lid
                for given in rows:
                    top += 1
                    vals = [""] * len(COLUMNS)
                    typed = {}
                    for k, v in given.items():
                        j = int(k)
                        if 0 <= j < len(COLUMNS) and ACTIVE[j] and str(v).strip() != "" and j not in formula_cols():
                            why = snap0.why(self.user, snap0.col_id("orders", j), "column")
                            if why:
                                raise ValueError(f"{why} ({COLUMNS[j]})")
                            try:
                                vals[j] = clean_value(KINDS[j], str(v))
                            except ValueError as e:
                                raise ValueError(f"{COLUMNS[j]}: {e}") from None
                            typed[j] = vals[j]
                    vals[IX["Updated by"]] = self.user["name"]
                    db.execute(f"INSERT INTO orders (rn, {names}, _s) VALUES ({marks})",
                               (top, *vals, " ".join(vals[j] for j in SEARCH_IDX).lower()))
                    for col, lid in lists.items():
                        if ACTIVE[col]:
                            db.execute("INSERT OR IGNORE INTO dv VALUES (?,?,?)", (top, col, lid))
                    for j, v in typed.items():
                        typed[j] = check_dropdown(db, top, j, v)  # a dropdown column only takes its choices
                        if typed[j] != vals[j]:
                            db.execute(f"UPDATE orders SET c{j} = ? WHERE rn = ?", (typed[j], top))
                        db.execute("INSERT INTO edit_log (at, who, rn, col, old, new, note) VALUES (?,?,?,?,?,?,?)",
                                   (now, self.user["name"], top, j, "", typed[j], "Row added"))
                    new.append(top)
                recompute_formulas(db, new)
                attach_custom_dropdowns(db)
                db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()
        bump()
        return {"rns": new}

    def api_rows(self, path, b):
        if path == "/api/rows/add":
            return self.add_rows(b.get("rows") or [])
        rns = sorted({int(x) for x in (b.get("rns") or [])})
        everything = path == "/api/rows/restore" and bool(b.get("all"))  # restore the whole trash, however many rows it holds
        if not rns and not everything:
            raise ValueError("No rows chosen.")
        names = ", ".join(f"c{i}" for i in range(len(COLUMNS)))
        n = 0
        with lock:
            db = connect()
            try:
                if path == "/api/rows/delete":
                    stamp_now = clock.now().strftime("%Y-%m-%d %H:%M")
                    for i in range(0, len(rns), 500):
                        chunk = rns[i:i + 500]
                        fetched = db.execute(f"SELECT rn, {names}, _s FROM orders WHERE rn IN ({','.join('?' * len(chunk))})", chunk).fetchall()
                        trash = []
                        for r in fetched:
                            r = list(r)
                            vals = [x or "" for x in r[1:-1]]
                            trash.append((r[0], vals[IX["Label Number"]], vals[IX["Product Name"]], vals[IX["Customer Name"]],
                                          json.dumps({"c": vals, "s": r[-1] or ""}), self.user["name"], stamp_now))
                        db.executemany("INSERT OR REPLACE INTO trash_rows VALUES (?,?,?,?,?,?,?)", trash)
                        db.execute(f"DELETE FROM orders WHERE rn IN ({','.join('?' * len(chunk))})", chunk)
                        n += len(trash)
                elif path == "/api/rows/restore":
                    if everything:
                        rns = [r[0] for r in db.execute("SELECT rn FROM trash_rows ORDER BY rn")]
                    top = max(db.execute("SELECT MAX(rn) FROM orders").fetchone()[0] or 2, db.execute("SELECT MAX(rn) FROM trash_rows").fetchone()[0] or 2)
                    marks = ", ".join("?" * (len(COLUMNS) + 2))
                    for rn in rns:
                        t = db.execute("SELECT data FROM trash_rows WHERE rn = ?", (rn,)).fetchone()
                        if not t:
                            continue
                        d = json.loads(t[0])
                        vals = (d["c"] + [""] * len(COLUMNS))[:len(COLUMNS)]  # columns added since come back empty
                        new_rn = rn
                        if db.execute("SELECT 1 FROM orders WHERE rn = ?", (rn,)).fetchone():
                            top += 1
                            new_rn = top
                        db.execute(f"INSERT INTO orders (rn, {names}, _s) VALUES ({marks})", (new_rn, *vals, d["s"]))
                        db.execute("DELETE FROM trash_rows WHERE rn = ?", (rn,))
                        n += 1
                else:
                    raise ValueError("Not found")
                db.commit()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()
        bump()
        return {"count": n}

    def api_columns(self, path, b):
        if path == "/api/columns/add":
            name = " ".join(str(b.get("name", "")).split())
            kind = str(b.get("kind", "text"))
            if not 1 <= len(name) <= 60:
                raise ValueError("Give the column a name (up to 60 characters).")
            if key_of(name) in COLUMN_BY_KEY:
                raise ValueError(f'There is already a column called "{name}".')
            if kind not in CUSTOM_KINDS:
                raise ValueError("Pick a column type.")
            options = []
            if kind == "dropdown":
                for o in str(b.get("options", "")).splitlines():
                    o = o.strip()
                    if o and o.lower() not in [x.lower() for x in options]:
                        options.append(o[:200])
                if not options:
                    raise ValueError("A dropdown column needs at least one choice (one per line).")
            with lock:
                db = connect()
                try:
                    n = len(COLUMNS)
                    db.execute(f"ALTER TABLE orders ADD COLUMN c{n} TEXT DEFAULT ''")
                    entry = {"name": name, "kind": "text" if kind == "dropdown" else kind, "custom": True}
                    if kind == "dropdown":
                        entry.update(dropdown=True, options=options)
                    apply_schema([*ENTRIES, entry])
                    save_schema()
                    attach_custom_dropdowns(db)
                    db.commit()
                finally:
                    db.close()
            bump()
            return {"i": n, "name": name}
        if path == "/api/columns/rename":
            i = int(b.get("i", -1))
            if not 0 <= i < len(COLUMNS) or not ACTIVE[i]:
                raise ValueError("That column does not exist.")
            label = " ".join(str(b.get("label", "")).split())
            if len(label) > 60:
                raise ValueError("The name can be up to 60 characters.")
            shown = label or COLUMNS[i]
            for j, e in enumerate(ENTRIES):
                if j != i and ACTIVE[j] and key_of(e.get("label") or e["name"]) == key_of(shown):
                    raise ValueError(f'There is already a column called "{shown}".')
            with lock:
                entries = [dict(e) for e in ENTRIES]
                if label and label != COLUMNS[i]:
                    entries[i]["label"] = label
                else:
                    entries[i].pop("label", None)
                apply_schema(entries)
                save_schema()
            bump()
            return {"i": i, "name": shown}
        if path == "/api/columns/delete":
            i = int(b.get("i", -1))
            if not 0 <= i < len(COLUMNS) or not ACTIVE[i]:
                raise ValueError("That column does not exist.")
            name = COLUMNS[i]
            if name in PROTECTED:
                raise ValueError(f'"{name}" cannot be deleted. {PROTECTED[name]}.')
            with lock:
                db = connect()
                try:
                    was_searched = i in SEARCH_IDX
                    entries = [dict(e) for e in ENTRIES]
                    entries[i].update(deleted=True, was=name, name=f"~deleted {i}~ {name}", deleted_by=self.user["name"],
                                      deleted_at=clock.now().strftime("%Y-%m-%d %H:%M"))
                    apply_schema(entries)
                    save_schema()
                    if was_searched:  # the deleted text must not stay findable through the search box
                        parts = " || ' ' || ".join(f"COALESCE(c{j}, '')" for j in SEARCH_IDX) or "''"
                        db.execute(f"UPDATE orders SET _s = lower({parts})")
                    db.commit()
                finally:
                    db.close()
            bump()
            return {"deleted": name}
        if path == "/api/columns/restore":
            i = int(b.get("i", -1))
            if not 0 <= i < len(COLUMNS) or ACTIVE[i]:
                raise ValueError("That column is not in the trash.")
            name = ENTRIES[i].get("was") or f"Column {i}"
            if key_of(name) in COLUMN_BY_KEY:  # a new column took the name meanwhile
                n, base = 2, f"{name} (restored)"
                name = base
                while key_of(name) in COLUMN_BY_KEY:
                    name, n = f"{base} {n}", n + 1
            with lock:
                db = connect()
                try:
                    entries = [dict(e) for e in ENTRIES]
                    entries[i].update(deleted=False, name=name)
                    for k in ("deleted_by", "deleted_at", "was"):
                        entries[i].pop(k, None)
                    apply_schema(entries)
                    save_schema()
                    recompute_formulas(db)
                    if name in SEARCH:  # its text is searchable again
                        parts = " || ' ' || ".join(f"COALESCE(c{j}, '')" for j in SEARCH_IDX) or "''"
                        db.execute(f"UPDATE orders SET _s = lower({parts})")
                    db.commit()
                finally:
                    db.close()
            bump()
            return {"restored": name}
        raise ValueError("Not found")

    def api_dropdown(self, body):
        """Change the choices of the dropdown on one cell. scope 'list': every cell that shares the list.
        scope 'column': every dropdown cell in that column gets the new choices."""
        options, seen = [], set()
        for o in body.get("options") or []:
            o = str(o).strip()
            if o and o.lower() not in seen:
                seen.add(o.lower())
                options.append(o)
        if not options:
            raise ValueError("A dropdown needs at least one choice.")
        if len(options) > 200 or any(len(o) > 200 for o in options):
            raise ValueError("Too many choices, or a choice is too long.")
        rn, col, scope = int(body["rn"]), int(body["col"]), body.get("scope", "list")
        with lock:
            db = connect()
            try:
                cur = db.execute("SELECT list_id FROM dv WHERE rn = ? AND col = ?", (rn, col)).fetchone()
                if not cur:
                    raise ValueError("That cell has no dropdown.")
                lid = cur[0]
                strict = db.execute("SELECT strict FROM lists WHERE id = ?", (lid,)).fetchone()[0]
                text = json.dumps(options)
                if scope == "column":
                    lid = db.execute("INSERT INTO lists (options, strict) VALUES (?, ?)", (text, strict)).lastrowid
                    db.execute("UPDATE dv SET list_id = ? WHERE col = ?", (lid, col))
                    n = db.execute("SELECT COUNT(*) FROM dv WHERE col = ?", (col,)).fetchone()[0]
                else:
                    db.execute("UPDATE lists SET options = ? WHERE id = ?", (text, lid))
                    n = db.execute("SELECT COUNT(*) FROM dv WHERE list_id = ?", (lid,)).fetchone()[0]
                db.execute("DELETE FROM lists WHERE id NOT IN (SELECT DISTINCT list_id FROM dv)")
                db.commit()
                bump()
                if scope == "column" and ENTRIES[col].get("dropdown"):  # an added dropdown column: new rows get the new choices
                    ENTRIES[col]["options"] = options
                    save_schema()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()
        return {"id": lid, "options": options, "strict": bool(strict), "cells": n, "scope": scope}

    def api_cells(self, body):
        """Save a batch of cell edits atomically: [{rn, col, value}] -> {values: [normalised value, ...]}."""
        items = body.get("edits") or []
        snap = locks.Snapshot()
        skipped, reason = 0, ""
        with lock:
            db = connect()
            now = clock.now().isoformat(timespec="seconds")
            values, touched, also, shipped_ticks, delivered = [], set(), [], set(), set()
            try:
                for it in items:
                    rn, j = int(it["rn"]), int(it["col"])
                    if not 0 <= j < len(COLUMNS) or not ACTIVE[j]:
                        raise ValueError("unknown column")
                    why = snap.blocked(self.user, "orders", j, rn)
                    if not why and j in formula_cols():
                        why = f"{COLUMNS[j]} is calculated ({formula_text(COLUMNS[j])}). Change those columns instead."
                    if why:
                        skipped += 1
                        reason = reason or why
                        cur = db.execute(f"SELECT c{j} FROM orders WHERE rn = ?", (rn,)).fetchone()
                        values.append((cur[0] or "") if cur else "")
                        continue
                    try:
                        v = clean_value(KINDS[j], str(it.get("value", "")))
                        v = check_dropdown(db, rn, j, v)
                    except ValueError as e:
                        raise ValueError(f"Row {rn}, {COLUMNS[j]}: {e}") from None
                    before = db.execute(f"SELECT c{j} FROM orders WHERE rn = ?", (rn,)).fetchone()
                    if before is None:
                        raise ValueError(f"Row {rn} no longer exists. Refresh the page.")
                    db.execute(f"UPDATE orders SET c{j} = ? WHERE rn = ?", (v, rn))
                    if (before[0] or "") != v and j != IX["Updated by"]:
                        db.execute("INSERT INTO edit_log (at, who, rn, col, old, new, note) VALUES (?,?,?,?,?,?,?)",
                                   (now.replace("T", " ")[:16], self.user["name"], rn, j, before[0] or "", v, "Edited"))
                    db.execute("INSERT OR REPLACE INTO edits VALUES (?,?,?,?)", (rn, j, v, now))
                    values.append(v)
                    # ticking Shipped to Customer / Shipped to Amazon stamps the date and time of the tick (clearing it clears the stamp)
                    stamp_col = SHIP_STAMP.get(COLUMNS[j]) and IX.get(SHIP_STAMP[COLUMNS[j]])
                    if COLUMNS[j] == "Source Order Status" and v == "Delivered" and (before[0] or "") != v:
                        delivered.add(rn)
                    if v == "TRUE" and (before[0] or "") != v and COLUMNS[j] in ("Shipped to Customer", "Shipped to Amazon"):
                        shipped_ticks.add((rn, j))
                    if stamp_col is not None and v in ("TRUE", "FALSE") and (before[0] or "") != v:
                        stamp = now.replace("T", " ")[:16] if v == "TRUE" else ""
                        old = db.execute(f"SELECT c{stamp_col} FROM orders WHERE rn = ?", (rn,)).fetchone()[0] or ""
                        db.execute(f"UPDATE orders SET c{stamp_col} = ? WHERE rn = ?", (stamp, rn))
                        if old != stamp:
                            db.execute("INSERT INTO edit_log (at, who, rn, col, old, new, note) VALUES (?,?,?,?,?,?,?)",
                                       (now.replace("T", " ")[:16], self.user["name"], rn, stamp_col, old, stamp, "Set when the checkbox was ticked" if stamp else "Cleared when the checkbox was unticked"))
                        also.append({"rn": rn, "col": stamp_col, "value": stamp})
                        if stamp and COLUMNS[j] in ("Shipped to Customer", "Shipped to Amazon"):
                            db.execute("INSERT INTO ship_events (rn, kind, at, operator, note) VALUES (?,?,?,?,?)",
                                       (rn, "customer" if COLUMNS[j] == "Shipped to Customer" else "amazon", stamp, self.user["name"], "Ticked by hand"))
                    # the newest event wins: shipped to the customer and shipped to Amazon exclude each other
                    other = SHIP_OTHER.get(COLUMNS[j])
                    if other and v == "TRUE" and (before[0] or "") != v:
                        oj = IX[other]
                        if (db.execute(f"SELECT c{oj} FROM orders WHERE rn = ?", (rn,)).fetchone()[0] or "") == "TRUE":
                            db.execute(f"UPDATE orders SET c{oj} = 'FALSE' WHERE rn = ?", (rn,))  # the date stays: it still counts as shipped
                            db.execute("INSERT INTO edit_log (at, who, rn, col, old, new, note) VALUES (?,?,?,?,?,?,?)",
                                       (now.replace("T", " ")[:16], self.user["name"], rn, oj, "TRUE", "FALSE", f"Unticked: {COLUMNS[j]} was ticked"))
                            also.append({"rn": rn, "col": oj, "value": "FALSE"})
                    if j in SEARCH_IDX:
                        touched.add(rn)
                if delivered:  # Delivered: no longer on hold, and the partial-delivery note goes
                    orders = scan.Orders(db, IX, self.user["name"])
                    for rn in delivered:
                        for name, val in scan.delivered_cleanup(orders, rn, "Row became Delivered").items():
                            also.append({"rn": rn, "col": IX[name], "value": val})
                            touched.add(rn)
                recalc = {int(it["rn"]) for it in items if int(it["col"]) in formula_sources()}
                if recalc:
                    recompute_formulas(db, recalc)
                # "Updated by" names the operator who scanned the package, and the Dashboard counts by it. A scan sets it;
                # so does ticking Shipped to Customer / Shipped to Amazon by hand, which does the same job. Other edits leave it alone.
                for rn in {rn for rn, _ in shipped_ticks}:
                    db.execute(f"UPDATE orders SET c{IX['Updated by']} = ? WHERE rn = ?", (self.user["name"], rn))
                for rn in touched:
                    r = db.execute(f"SELECT {', '.join(f'c{j}' for j in SEARCH_IDX)} FROM orders WHERE rn = ?", (rn,)).fetchone()
                    db.execute("UPDATE orders SET _s = ? WHERE rn = ?", (" ".join(r).lower(), rn))
                db.commit()
                bump()
            except Exception:
                db.rollback()
                raise
            finally:
                db.close()
        return {"values": values, "also": also, "v": VERSION[0], "skipped": skipped, "reason": reason}


class Server(ThreadingHTTPServer):
    # Windows would otherwise let a second copy of the app share the port with the first, and the browser would be
    # sent to either one (an old copy then breaks the pages). Refuse to start a second copy instead.
    allow_reuse_address = False
    allow_reuse_port = False


def create_admin():
    """python server.py create-admin: make an admin account from the command line (for a server you cannot open locally)."""
    username = input("Admin username: ").strip()
    name = input("Display name: ").strip()
    password = getpass.getpass("Password (8+ characters): ")
    auth.add_user(username, name, password, "admin")
    print("Admin account created.")


if __name__ == "__main__":
    ensure_db()
    if len(sys.argv) > 1 and sys.argv[1] == "create-admin":
        try:
            create_admin()
        except ValueError as e:
            sys.exit(str(e))
        sys.exit(0)
    returns.on_change = bump
    threading.Thread(target=returns.scheduler, args=(threading.Event(),), daemon=True).start()
    threading.Thread(target=watch_code, daemon=True).start()
    host = os.environ.get("HOST", "127.0.0.1")
    print(f"Florida 3PL running at http://localhost:{PORT}  (Ctrl+C to stop)")
    if auth.user_count() == 0:
        print("No accounts yet: open that address on this PC to create the first admin.")
    try:
        Server((host, PORT), Handler).serve_forever()
    except OSError as e:
        sys.exit(f"Port {PORT} is already in use: the app is probably already running (look for another server window). {e}")
