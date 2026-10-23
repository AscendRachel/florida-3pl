"""Minimal .xlsx reader (standard library only): sheet names and rows as lists of strings.

Dates stored as real Excel dates come back as ISO text ("2026-03-06" or "2026-03-06 14:30"),
booleans as TRUE / FALSE, everything else as the text Excel shows for the stored value.
"""
import re
import zipfile
from datetime import datetime, timedelta
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
BUILTIN_DATE_IDS = set(range(14, 23)) | set(range(27, 37)) | set(range(45, 48)) | set(range(50, 59))
EPOCH = datetime(1899, 12, 30)


def col_index(ref):
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group():
        n = n * 26 + ord(ch) - 64
    return n - 1


def is_date_format(code):
    code = re.sub(r'"[^"]*"|\[[^\]]*\]|\\.', "", code)
    return bool(re.search(r"[ymdhs]", code, re.I))


class Workbook:
    def __init__(self, path):
        self.zf = zipfile.ZipFile(path)
        self._shared = None
        self._date_xf = None
        self.validations = []  # filled while rows() streams a whole sheet: dropdown rules found after the rows

    def sheets(self):
        """[(name, path inside the zip)] in tab order."""
        wb = ET.fromstring(self.zf.read("xl/workbook.xml"))
        rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(self.zf.read("xl/_rels/workbook.xml.rels")).iter(PKG_REL + "Relationship")}
        out = []
        for s in wb.iter(NS + "sheet"):
            target = rels[s.get(REL + "id")].lstrip("/")
            out.append((s.get("name"), target if target.startswith("xl/") else "xl/" + target))
        return out

    def shared(self):
        if self._shared is None:
            self._shared = []
            if "xl/sharedStrings.xml" in self.zf.namelist():
                with self.zf.open("xl/sharedStrings.xml") as f:
                    for _ev, el in ET.iterparse(f):
                        if el.tag == NS + "si":
                            self._shared.append("".join(t.text or "" for t in el.iter(NS + "t")))
                            el.clear()
        return self._shared

    def date_styles(self):
        if self._date_xf is None:
            self._date_xf = set()
            if "xl/styles.xml" in self.zf.namelist():
                root = ET.fromstring(self.zf.read("xl/styles.xml"))
                custom = {int(n.get("numFmtId")): n.get("formatCode", "") for n in root.iter(NS + "numFmt")}
                xfs = root.find(NS + "cellXfs")
                for i, xf in enumerate(xfs if xfs is not None else []):
                    fid = int(xf.get("numFmtId", 0))
                    if fid in BUILTIN_DATE_IDS or (fid in custom and is_date_format(custom[fid])):
                        self._date_xf.add(i)
        return self._date_xf

    def rows(self, path, limit=None):
        """Yield (row number, [cell text, ...]) for each non-empty row of a sheet."""
        shared, date_xf = self.shared(), self.date_styles()
        n = 0
        with self.zf.open(path) as f:
            for _ev, el in ET.iterparse(f):
                if el.tag == NS + "dataValidation":
                    f1 = el.find(NS + "formula1")
                    self.validations.append({
                        "type": el.get("type"), "sqref": el.get("sqref", ""), "formula": (f1.text or "") if f1 is not None else "",
                        "strict": el.get("showErrorMessage") == "1" and el.get("errorStyle", "stop") == "stop",
                    })
                    continue
                if el.tag != NS + "row":
                    continue
                cells = {}
                for c in el.iter(NS + "c"):
                    v = c.find(NS + "v")
                    t = c.get("t")
                    if t == "inlineStr":
                        val = "".join(x.text or "" for x in c.iter(NS + "t"))
                    elif v is None or v.text is None:
                        continue
                    elif t == "s":
                        val = shared[int(v.text)]
                    elif t == "b":
                        val = "TRUE" if v.text == "1" else "FALSE"
                    elif t == "e":
                        val = ""
                    elif t in ("str", "d"):
                        val = v.text
                    elif int(c.get("s", 0)) in date_xf:
                        try:
                            d = EPOCH + timedelta(days=float(v.text))
                            val = d.strftime("%Y-%m-%d %H:%M") if (d.hour or d.minute) else d.strftime("%Y-%m-%d")
                        except ValueError:
                            val = v.text
                    else:
                        val = v.text[:-2] if v.text.endswith(".0") else v.text
                    cells[col_index(c.get("r"))] = val
                row_no = int(el.get("r", 0)) or n + 1
                el.clear()
                n = row_no
                if cells:
                    out = [""] * (max(cells) + 1)
                    for i, val in cells.items():
                        out[i] = val
                    yield row_no, out
                    if limit and row_no >= limit:
                        return
