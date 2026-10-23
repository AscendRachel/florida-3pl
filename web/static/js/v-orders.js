// All Orders: the "March" tab as an editable spreadsheet grid (server-side search, filter and sort).
// Click a cell to select it, type or press Enter / F2 / double-click to edit, arrows / Tab to move, Ctrl+C / V / X / Z work.
import { $, ago, api, confirmBox, debounce, dialog, esc, fmt, store, toast } from "./util.js";
import { nextSeries } from "./fill.js";
import { lockReason, lockTip, protectDialog, renameDialog } from "./protect.js";

const ROW_H = 30, HEAD_H = 30, FILT_H = 0, RN_W = 52, PAGE = 100;
const WIDTHS = {
  "Label Number": 110, "Store Order No.": 190, "Product Name": 360, Brand: 130, QTY: 60,
  "Customer Name": 160, Address: 280, "Source Order Date": 130, "Source Order Number": 170,
  "Source Tracking Number": 170, "Shipping Label Link": 110, "Product Image Link": 90, "Source Order Status": 140,
  "Tracking Number To Customer": 190, "Delivery Date": 130, "Tracking Status": 140, Notes: 240, Store: 110,
  "PH Team Internal Notes": 240,
};
const DEFAULT_HIDDEN = ["Gift Note", "Print Link", "Number of Orders", "Days In Transit", "Boxes Received", "Boxes Expected",
  "RTS COUNTER", "RTA COUNTER", "Item on Hold Counter", "Store Returns Counter", "All Orders Counter", "Stock Counter",
  "Hold Warning", "Label Chip", "TAPICKER STATUS", "TAPICKER SHIPPED DATE", "TAPICKER DELIVERY DATE"];
const PILL = {
  Delivered: "s-ok", Refunded: "s-warn", "In Transit": "s-info", Cancelled: "s-neutral", Preshipment: "s-violet",
  "Store Returns": "s-warn", "Return to Sender": "s-warn", "Return to Amazon": "s-warn",
};
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const showDate = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(v);
  if (!m) return v;
  let s = `${MONTH[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
  if (m[4]) s += ` ${+m[4] % 12 || 12}:${m[5]} ${+m[4] >= 12 ? "PM" : "AM"}`;
  return s;
};
const isUrl = (v) => /^https?:\/\//.test(v);
const readJson = (k, fallback) => { try { return JSON.parse(store.get(k, "") || "null") ?? fallback; } catch { return fallback; } };

export async function mount(el, params, ctx) {
  const meta = await api("/api/meta");
  let savedViews = [];
  try { savedViews = (await api("/api/views")).views; } catch { /* the grid still works without saved views */ }
  const cols = meta.columns.filter((c) => !c.name.includes("Softr"));
  const hidden = new Set(readJson("gt_orders_hidden", DEFAULT_HIDDEN));
  const widths = readJson("gt_orders_widths", {});
  const st = { q: "", card: "", cf: {}, sort: "", dir: "asc", total: 0, act: null, anc: null, edit: null, rowSel: false };
  const pages = new Map(); // page number -> rows
  const inflight = new Set();
  const dvMap = new Map(); // "rn:col" -> id of the dropdown list on that cell
  const lists = new Map(); // dropdown list id -> {options, strict}
  let dd = null; // the open dropdown menu
  const undo = [];
  let views = savedViews, activeId = store.get("gt_orders_view", ""); // saved filter views, and the one applied on this browser
  let knownV = null; // the app's change counter when this page last looked
  let colLocks = meta.locks?.cols || {}, lockDefs = { ...(meta.locks?.defs || {}) }; // protected columns, and what each protection says
  const rowLocks = new Map(); // row number -> protection id, for the rows loaded so far
  const why = (c, rn) => lockReason(lockDefs[colLocks[c.i]], ctx.me, "column") || lockReason(lockDefs[rowLocks.get(rn)], ctx.me, "row");
  const takeLocks = (r, rows) => { // protections that came with a page of rows
    Object.assign(lockDefs, r.locks.defs);
    colLocks = r.locks.cols;
    for (const row of rows) rowLocks.delete(row[0]);
    for (const [rn, id] of Object.entries(r.locks.rows)) rowLocks.set(+rn, id);
  };
  let gen = 0, list = [], lefts = [], geo = { total: RN_W }, lastDown = { t: 0, r: -1, k: -1 }, dragging = false, rowDrag = false, downAt = 0, downXY = [0, 0];

  const width = (c) => widths[c.name] || (c.kind === "bool" ? 100 : c.kind === "date" ? 130 : c.kind === "num" ? 90 : WIDTHS[c.name] || 150);

  el.innerHTML = `<div class="sheetpage">
    <div class="section-head"><div><div class="eyebrow">Greentek</div><h2>All Orders</h2></div>
      <div class="btnrow"><span class="muted" id="synced"></span></div></div>
    <div class="qgrid cards" id="cards"></div>
    <div class="toolbar sheetbar">
      <div class="searchbox"><input id="q" type="search" placeholder="Search label, order no., product, customer, tracking…  ( / )" autocomplete="off"></div>
      <button class="btn small primary" id="addRowBtn" title="Add a blank row at the bottom">＋ Add row</button>
      <span class="sep"></span><button class="btn small" id="clear">Clear filters</button>
      <button class="btn small" id="colsBtn">Columns ▾</button>
      <div class="menuwrap" id="viewsWrap"><button class="btn small" id="viewsBtn">Filter views ▾</button></div>
      ${ctx.isAdmin() ? `<button class="btn small" id="addColBtn" title="Admins only">＋ Add column</button><button class="btn small" id="trashBtn" title="Deleted rows and columns, admins only">🗑 Trash</button>` : ""}
      <span class="muted" id="count"></span>
    </div>
    <div class="fbar" id="fbar">Select a cell</div>
    <div class="scroller" id="sc" tabindex="0"><div class="inner" id="inner">
      <div class="ghead"><div class="hrow" id="hrow"></div></div>
      <div class="gbody" id="gbody"><div id="rows"></div></div></div></div>
    <div class="statusbar"><span id="sbL"></span><span class="muted">Type or double-click to edit · Enter saves · Esc cancels · Ctrl+Z undoes · drag the square at a selection's corner to fill down, or past the last row to add rows</span></div></div>`;

  const sc = $("#sc"), body = $("#gbody"), rowsEl = $("#rows"), inner = $("#inner");

  const query = (extra = {}) => ({ q: st.q, card: st.card, sort: st.sort, dir: st.dir, flt: st.cf, ...extra });
  const rowAt = (i) => pages.get(Math.floor(i / PAGE))?.[i % PAGE];
  const countText = () => `${fmt(st.total)} order${st.total === 1 ? "" : "s"}${nFilters() ? ` · ${nFilters()} column filter${nFilters() === 1 ? "" : "s"}` : ""}`;

  async function loadPage(p) {
    if (pages.has(p) || inflight.has(p)) return;
    inflight.add(p);
    const my = gen;
    try {
      const r = await api("/api/orders", query({ offset: p * PAGE, limit: PAGE }));
      if (my !== gen) return;
      pages.set(p, r.rows);
      takeLocks(r, r.rows);
      for (const [k, id] of Object.entries(r.dv)) dvMap.set(k, id);
      for (const [id, l] of Object.entries(r.lists)) lists.set(+id, l);
      st.total = r.total;
      body.style.height = st.total * ROW_H + "px";
      $("#count").textContent = $("#sbL").textContent = countText();
      paint();
    } catch (e) { toast(e.message, "bad"); }
    finally { inflight.delete(p); }
  }

  function reset() {
    cancelEdit();
    gen++; pages.clear(); inflight.clear();
    st.act = st.anc = null;
    st.rowSel = false;
    sc.scrollTop = 0;
    updateBar();
    updateViewsBtn();
    loadPage(0);
  }

  async function refreshCards() {
    try { meta.cards = (await api("/api/meta")).cards; renderCards(); } catch { /* the grid still works without fresh counts */ }
  }
  const refreshCardsSoon = debounce(refreshCards, 800);

  function drawHead() {
    list = cols.filter((c) => !hidden.has(c.name));
    let x = RN_W;
    lefts = list.map((c) => { const l = x; x += width(c); return l; });
    geo = { total: x };
    inner.style.width = x + "px";
    $("#hrow").innerHTML = `<div class="hc rn" style="width:${RN_W}px;height:${HEAD_H}px">#</div>` + list.map((c, i) => {
      const f = st.cf[c.i], on = !!(f && (f.c || f.v)), sorted = st.sort === String(c.i);
      return `<div class="hc${i === 0 ? " pin" : ""}${on ? " filtered" : ""}" style="width:${width(c)}px;height:${HEAD_H}px;${i === 0 ? `left:${lefts[0]}px` : ""}">
        <span class="hl" title="${esc(colLocks[c.i] ? `${c.name}. ${lockTip(lockDefs[colLocks[c.i]])}` : c.formula ? `${c.name} is calculated: ${c.formula}` : c.name)}">${colLocks[c.i] ? "🔒 " : ""}${c.formula ? "ƒ " : ""}${esc(c.name)}</span>${sorted ? `<span class="hs">${st.dir === "asc" ? "▲" : "▼"}</span>` : ""}
        <button class="fb${on ? " on" : ""}" data-fb="${c.i}" title="Sort and filter" aria-label="Sort and filter ${esc(c.name)}"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.5 2.5h13l-5 6v5l-3-1.8V8.5z" fill="currentColor"/></svg></button><i class="rz" data-rz="${c.i}"></i></div>`;
    }).join("");
  }

  // ---- selection
  const range = () => {
    if (!st.act) return null;
    const a = st.act, b = st.anc || st.act;
    const wide = st.rowSel; // Shift+Space: the selection covers whole rows
    return { r1: Math.min(a.r, b.r), r2: Math.max(a.r, b.r), k1: wide ? 0 : Math.min(a.k, b.k), k2: wide ? list.length - 1 : Math.max(a.k, b.k) };
  };

  function cell(c, v, i, r, rn, sel) {
    const style = `width:${width(c)}px;${i === 0 ? `left:${RN_W}px` : ""}`;
    let h = "", cls = i === 0 ? " pin" : "";
    if (!v) h = "";
    else if (c.kind === "bool") h = `<input type="checkbox" class="cbx" ${v === "TRUE" ? "checked" : ""} tabindex="-1">`, cls += " ctr";
    else if (c.kind === "num") cls += " r", h = esc(v);
    else if (c.kind === "date") h = esc(showDate(v));
    else if (c.kind === "select") h = `<span class="pill ${PILL[v] || "s-neutral"}">${esc(v)}</span>`;
    else if (c.kind === "img") h = isUrl(v) ? `<img class="thumb" loading="lazy" referrerpolicy="no-referrer" src="${esc(v)}" alt="">` : "";
    else if (c.kind === "link") h = isUrl(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener" data-link>Open</a>` : esc(v);
    else h = esc(v.replace(/\s*\n\s*/g, " ⏎ "));
    if (c.kind === "bool" && !v) cls += " ctr", h = `<input type="checkbox" class="cbx" tabindex="-1">`;
    if (sel) cls += st.act.r === r && st.act.k === i ? " a" : " s";
    if (dvMap.has(`${rn}:${c.i}`)) cls += " dd";
    if (why(c, rn)) cls += " ro locked";
    if (c.formula) cls += " calc";
    return `<div class="gc${cls}" data-k="${i}" style="${style}"${c.kind === "text" && v ? ` title="${esc(v)}"` : ""}>${h}</div>`;
  }

  function paint() {
    const top = Math.max(0, sc.scrollTop - HEAD_H - FILT_H);
    const first = Math.max(0, Math.floor(top / ROW_H) - 4);
    const last = Math.min(st.total - 1, Math.ceil((top + sc.clientHeight) / ROW_H) + 4);
    const sel = range();
    let out = "";
    for (let i = first; i <= last; i++) {
      const r = rowAt(i);
      const inRow = sel && i >= sel.r1 && i <= sel.r2;
      out += `<div class="gr${r ? "" : " loading"}" data-r="${i}" style="top:${i * ROW_H}px;width:${geo.total}px"><div class="gc rn${inRow ? " s" : ""}${r && rowLocks.has(r[0]) ? " lk" : ""}" style="width:${RN_W}px"${r && rowLocks.has(r[0]) ? ` title="${esc(lockTip(lockDefs[rowLocks.get(r[0])]))}"` : ""}>${r ? r[0] : ""}</div>${list.map((c, k) => cell(c, r ? r[c.i + 1] : "", k, i, r?.[0], inRow && k >= sel.k1 && k <= sel.k2)).join("")}</div>`;
    }
    rowsEl.innerHTML = out;
    if (last >= first) for (let p = Math.floor(first / PAGE); p <= Math.floor(last / PAGE); p++) loadPage(p);
    placeFill();
  }

  function updateBar() {
    const a = st.act, r = a && rowAt(a.r), c = a && list[a.k];
    $("#fbar").textContent = r && c ? `${r[cellCol("Label Number")] || ""} · ${c.name}: ${c.kind === "date" ? showDate(r[c.i + 1]) : r[c.i + 1]}` : "Select a cell";
  }
  const cellCol = (name) => (cols.find((c) => c.key === name)?.i ?? 0) + 1;

  function select(r, k, extend = false) {
    r = Math.max(0, Math.min(st.total - 1, r));
    k = Math.max(0, Math.min(list.length - 1, k));
    if (st.total === 0 || !list.length) return;
    st.act = { r, k };
    if (!extend || !st.anc) st.anc = { r, k };
    if (!extend) st.rowSel = false;
    reveal(r, k);
    paint(); updateBar();
  }
  // scroll just enough to bring a cell into view, keeping the frozen header and first column clear
  function reveal(r, k) {
    const topPad = HEAD_H + FILT_H, y = topPad + r * ROW_H;
    if (y - topPad < sc.scrollTop) sc.scrollTop = y - topPad;
    else if (y + ROW_H > sc.scrollTop + sc.clientHeight - 14) sc.scrollTop = y + ROW_H - sc.clientHeight + 14;
    if (k === 0) return;
    const x = lefts[k], w = width(list[k]), pinW = RN_W + width(list[0]);
    if (x - pinW < sc.scrollLeft) sc.scrollLeft = x - pinW;
    else if (x + w > sc.scrollLeft + sc.clientWidth - 14) sc.scrollLeft = x + w - sc.clientWidth + 14;
  }

  // ---- saving
  // a calculated column (Gift Note) follows its source columns on screen as soon as one of them is edited, pasted, filled or undone
  const calcCols = cols.filter((c) => c.formula_from?.length);
  function recalc(rowIndex) {
    const row = rowAt(rowIndex);
    if (row) for (const c of calcCols) row[c.i + 1] = c.formula_from.map((i) => row[i + 1] || "").join("");
  }
  function patchCache(rn, col, val, hint) {
    let row = hint != null ? rowAt(hint) : null;
    if (row?.[0] !== rn) { row = null; for (const rows of pages.values()) { row = rows.find((x) => x[0] === rn); if (row) break; } }
    if (row) row[col + 1] = val;
  }

  // changes: [{r: row index, k: column position in the visible list, value}]
  async function commit(changes, { record = true } = {}) {
    const items = [], olds = [];
    for (const ch of changes) {
      const row = rowAt(ch.r), c = list[ch.k];
      if (!row || !c) continue;
      if (row[c.i + 1] === ch.value) continue;
      items.push({ rn: row[0], col: c.i, value: ch.value, r: ch.r });
      olds.push({ rn: row[0], col: c.i, value: row[c.i + 1], r: ch.r });
    }
    if (!items.length) return true;
    try {
      const out = await api("/api/cells", { edits: items.map(({ rn, col, value }) => ({ rn, col, value })) });
      const { values, v } = out;
      if (v) knownV = v;
      items.forEach((it, n) => { patchCache(it.rn, it.col, values[n], it.r); });
      (out.also || []).forEach((a) => patchCache(a.rn, a.col, a.value));
      new Set(items.map((it) => it.r)).forEach(recalc);
      const refused = items.map((it, n) => values[n] !== it.value && values[n] === olds[n].value);
      if (record && olds.some((_, n) => !refused[n])) { undo.push(olds.filter((_, n) => !refused[n])); if (undo.length > 50) undo.shift(); }
      if (out.skipped) toast(`${out.reason}${out.skipped < items.length ? ` (${fmt(out.skipped)} protected cell${out.skipped === 1 ? "" : "s"} skipped, the rest were saved.)` : ""}`, "bad");
      paint(); updateBar(); refreshCardsSoon();
      return true;
    } catch (e) {
      toast(e.message, "bad");
      paint();
      return false;
    }
  }

  async function undoLast() {
    const last = undo.pop();
    if (!last) return toast("Nothing to undo.");
    try {
      const out = await api("/api/cells", { edits: last.map(({ rn, col, value }) => ({ rn, col, value })) });
      const { values } = out;
      last.forEach((it, n) => patchCache(it.rn, it.col, values[n], it.r));
      (out.also || []).forEach((a) => patchCache(a.rn, a.col, a.value));
      new Set(last.map((it) => it.r)).forEach(recalc);
      paint(); updateBar(); refreshCardsSoon();
    } catch (e) { toast(e.message, "bad"); }
  }

  // ---- in-cell editor
  function startEdit(initial) {
    const a = st.act, row = a && rowAt(a.r), c = a && list[a.k];
    if (!row || !c) return;
    if (c.formula) return toast(`${c.name} is calculated (${c.formula}). Change those columns instead.`, "bad");
    const blocked = why(c, row[0]);
    if (blocked) return toast(blocked, "bad");
    if (c.kind === "bool") return commit([{ r: a.r, k: a.k, value: row[c.i + 1] === "TRUE" ? "FALSE" : "TRUE" }]);
    if (dvMap.has(`${row[0]}:${c.i}`)) return startDropdown(initial ?? "");
    cancelEdit();
    const ta = document.createElement("textarea");
    ta.className = "editor";
    ta.rows = 1;
    ta.value = initial ?? (c.kind === "date" ? showDate(row[c.i + 1]) : row[c.i + 1]);
    ta.dataset.orig = row[c.i + 1];
    body.append(ta);
    st.edit = { r: a.r, k: a.k, ta };
    placeEditor();
    ta.focus();
    if (initial === undefined) ta.setSelectionRange(ta.value.length, ta.value.length); else ta.setSelectionRange(initial.length, initial.length);
    ta.oninput = placeEditor;
    ta.onblur = () => finishEdit(true);
    ta.onkeydown = (e) => {
      if (e.key === "Enter" && e.altKey) { e.preventDefault(); ta.setRangeText("\n", ta.selectionStart, ta.selectionEnd, "end"); placeEditor(); }
      else if (e.key === "Enter") { e.preventDefault(); finishEdit(true, e.shiftKey ? -1 : 1, 0); }
      else if (e.key === "Tab") { e.preventDefault(); finishEdit(true, 0, e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); finishEdit(false); }
      e.stopPropagation();
    };
  }
  function placeEditor() {
    if (dd) dd.menu.style.left = (dd.k === 0 ? sc.scrollLeft + RN_W : lefts[dd.k]) + "px";
    const e = st.edit;
    if (!e) return;
    const left = e.k === 0 ? sc.scrollLeft + RN_W : lefts[e.k];
    e.ta.style.cssText = `top:${e.r * ROW_H}px;left:${left}px;width:${Math.max(width(list[e.k]), 140)}px;height:${ROW_H}px`;
    e.ta.style.height = Math.min(160, Math.max(ROW_H, e.ta.scrollHeight)) + "px";
    e.ta.classList.toggle("pinned", e.k === 0);
  }
  function cancelEdit() {
    closeDropdown();
    const e = st.edit;
    if (!e) return;
    st.edit = null;
    e.ta.onblur = null;
    e.ta.remove();
  }
  function finishEdit(save, dr = 0, dk = 0) {
    const e = st.edit;
    if (!e) return;
    st.edit = null;
    e.ta.onblur = null;
    const value = e.ta.value;
    e.ta.remove();
    if (save) {
      const c = list[e.k], shown = c.kind === "date" ? showDate(e.ta.dataset.orig) : e.ta.dataset.orig;
      if (value !== shown) commit([{ r: e.r, k: e.k, value }]);
    }
    if (dr || dk) select(e.r + dr, e.k + dk); else sc.focus({ preventScroll: true });
  }


  // ---- dropdown cells: a menu of the cell's choices (type to search), and "Edit choices…" to add or remove them
  function startDropdown(initial = "") {
    const a = st.act, row = a && rowAt(a.r), c = a && list[a.k];
    const L = row && c && lists.get(dvMap.get(`${row[0]}:${c.i}`));
    if (!L) return;
    cancelEdit();
    const menu = document.createElement("div");
    menu.className = "ddmenu";
    menu.innerHTML = `<input class="ddq" placeholder="Search…" autocomplete="off"><div class="ddlist"></div>${ctx.isAdmin() ? `<div class="ddfoot"><button type="button" data-edit>✎ Edit choices…</button></div>` : ""}`;
    body.append(menu);
    const input = menu.querySelector(".ddq"), box = menu.querySelector(".ddlist");
    const cur = row[c.i + 1], at = { r: a.r, k: a.k };
    dd = { ...at, menu, idx: 0 };
    let items = [];
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      items = L.options.filter((o) => o.toLowerCase().includes(q)).map((o) => ({ label: o, value: o }));
      if (cur && !q) items.push({ label: "Clear this cell", value: "", muted: true });
      if (!L.strict && q && !items.some((i) => i.value.toLowerCase() === q)) items.push({ label: `Use "${input.value.trim()}"`, value: input.value.trim() });
      dd.idx = Math.min(dd.idx, Math.max(0, items.length - 1));
      box.innerHTML = items.map((it, n) => `<button type="button" class="ddi${n === dd.idx ? " on" : ""}${it.muted ? " muted" : ""}" data-n="${n}">${it.value === cur && it.value ? "✓ " : ""}${esc(it.label)}</button>`).join("") || `<div class="muted ddnone">No match</div>`;
      const on = box.querySelector(".on"); // keep the highlighted choice visible inside the list only (never scroll the grid)
      if (on && on.offsetTop < box.scrollTop) box.scrollTop = on.offsetTop;
      else if (on && on.offsetTop + on.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = on.offsetTop + on.offsetHeight - box.clientHeight;
    };
    const place = () => {
      const topPad = HEAD_H + FILT_H, h = menu.offsetHeight;
      const below = sc.scrollTop + sc.clientHeight - topPad - (at.r + 1) * ROW_H;
      menu.style.top = (below < h && at.r * ROW_H > h ? at.r * ROW_H - h : (at.r + 1) * ROW_H) + "px";
      menu.style.left = (at.k === 0 ? sc.scrollLeft + RN_W : lefts[at.k]) + "px";
      menu.style.minWidth = Math.max(width(c), 220) + "px";
    };
    const pick = (n) => {
      const it = items[n];
      if (!it) return;
      closeDropdown();
      commit([{ ...at, value: it.value }]);
    };
    input.value = initial;
    input.oninput = () => { dd.idx = 0; draw(); };
    input.onblur = closeDropdown;
    input.onkeydown = (e) => {
      if (e.key === "ArrowDown") { dd.idx = Math.min(items.length - 1, dd.idx + 1); draw(); }
      else if (e.key === "ArrowUp") { dd.idx = Math.max(0, dd.idx - 1); draw(); }
      else if (e.key === "Enter") pick(dd.idx);
      else if (e.key === "Escape") closeDropdown();
      else return e.stopPropagation();
      e.preventDefault(); e.stopPropagation();
    };
    menu.onmousedown = (e) => {
      const b = e.target.closest(".ddi");
      if (e.target !== input) e.preventDefault(); // keep the focus in the search box
      if (b) pick(+b.dataset.n);
      else if (e.target.closest("[data-edit]")) { closeDropdown(); editChoices(at.r, at.k); }
    };
    place();
    draw();
    place();
    input.focus({ preventScroll: true });
    input.setSelectionRange(initial.length, initial.length);
  }
  function closeDropdown() {
    if (!dd) return;
    const m = dd.menu;
    dd = null;
    m.querySelector(".ddq").onblur = null;
    m.remove();
    sc.focus({ preventScroll: true });
  }

  async function editChoices(r, k) {
    const row = rowAt(r), c = list[k];
    const L = row && c && lists.get(dvMap.get(`${row[0]}:${c.i}`));
    if (!L) return;
    const res = await dialog({
      title: `Choices for "${c.name}"`,
      body: `<label class="field"><span>One choice per line. Add a line to add a choice, delete a line to remove it.</span>
          <textarea name="options" rows="10" spellcheck="false">${esc(L.options.join("\n"))}</textarea></label>
        <div class="radios">
          <label class="check"><input type="radio" name="scope" value="column" checked> <span>Use these choices for every dropdown in <b>${esc(c.name)}</b></span></label>
          <label class="check"><input type="radio" name="scope" value="list"> <span>Only the cells that share this exact list</span></label>
        </div>
        <p class="hint">Cells that already hold a removed choice keep their value until you change them.</p>`,
      actions: [["Cancel", "close"], ["Save choices", "ok", "primary"]],
    });
    if (res.value === "ok") {
      const options = res.el.querySelector("textarea").value.split("\n");
      const scope = res.el.querySelector("input[name=scope]:checked").value;
      try {
        const out = await api("/api/dropdown", { rn: row[0], col: c.i, options, scope });
        lists.set(out.id, { options: out.options, strict: out.strict });
        if (scope === "column") for (const key of dvMap.keys()) if (key.split(":")[1] === String(c.i)) dvMap.set(key, out.id);
        toast(`Saved ${out.options.length} choices for ${fmt(out.cells)} cells.`);
        paint();
      } catch (e) { toast(e.message, "bad"); }
    }
    sc.focus({ preventScroll: true });
  }

  // ---- image popup: click a thumbnail to see it large, arrows move to the next / previous order's image
  const imgCol = cols.find((c) => c.kind === "img");
  // Amazon serves bigger versions of the same picture when the size is put in the file name
  const bigUrl = (u) => (/\/images\/I\/[^/.]+\.(jpe?g|png|webp)$/i.test(u) ? u.replace(/\.(jpe?g|png|webp)$/i, "._SL1200_.$1") : u);

  function openImage(row) {
    if (!imgCol) return;
    document.querySelector(".lb")?.remove();
    const nameCol = cols.find((c) => c.key === "Product Name"), labelCol = cols.find((c) => c.key === "Label Number");
    const lb = document.createElement("div");
    lb.className = "lb";
    lb.innerHTML = `<div class="lb-top"><div class="lb-title"><b></b><span></span></div><a class="btn small" target="_blank" rel="noopener" data-orig>Open original</a><button class="btn small" data-close>Close ✕</button></div>
      <div class="lb-stage"><button class="lb-nav" data-dir="-1" aria-label="Previous">‹</button><div class="lb-frame"><img referrerpolicy="no-referrer" alt=""></div><button class="lb-nav" data-dir="1" aria-label="Next">›</button></div>`;
    const img = lb.querySelector("img"), frame = lb.querySelector(".lb-frame");
    let cur = row;
    const urlAt = (i) => { const v = rowAt(i)?.[imgCol.i + 1]; return isUrl(v || "") ? v : null; };
    const show = (i) => {
      cur = i;
      const r = rowAt(i), u = urlAt(i);
      lb.querySelector("b").textContent = r[nameCol.i + 1] || "(no product name)";
      lb.querySelector(".lb-title span").textContent = `${r[labelCol.i + 1]} · row ${r[0]}`;
      lb.querySelector("[data-orig]").href = u;
      frame.querySelector(".lb-err")?.remove();
      img.hidden = false;
      img.onerror = () => {
        if (img.src !== u) { img.src = u; return; } // the large version does not exist: use the original
        img.hidden = true;
        frame.insertAdjacentHTML("beforeend", `<div class="lb-err">This image could not be loaded.<br><a href="${esc(u)}" target="_blank" rel="noopener">Try opening it directly</a></div>`);
      };
      img.src = bigUrl(u);
      select(i, st.act?.k ?? 0);
    };
    const step = (dir) => {
      let j = cur + dir;
      while (j >= 0 && j < st.total && rowAt(j) && !urlAt(j)) j += dir;
      if (j < 0 || j >= st.total) return;
      if (!rowAt(j)) { loadPage(Math.floor(j / PAGE)); return; } // not loaded yet: press again in a moment
      show(j);
    };
    const close = () => { lb.remove(); removeEventListener("keydown", onKey, true); sc.focus({ preventScroll: true }); };
    const onKey = (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight" || e.key === "ArrowDown") step(1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") step(-1);
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    lb.onclick = (e) => {
      if (e.target.closest("[data-close]") || e.target === frame || e.target.classList.contains("lb-stage")) close();
      else if (e.target.closest("[data-dir]")) step(+e.target.closest("[data-dir]").dataset.dir);
    };
    addEventListener("keydown", onKey, true);
    document.body.append(lb);
    show(row);
  }

  // ---- mouse
  const cellAt = (t) => {
    const g = t.closest?.(".gc"), r = t.closest?.(".gr");
    if (!g || !r) return null;
    return { r: +r.dataset.r, k: g.classList.contains("rn") ? -1 : +g.dataset.k, el: g };
  };
  rowsEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || e.target.closest("[data-link]")) return;
    rowDrag = false; dragging = false; // every click starts clean, whatever the last drag left behind
    downAt = e.timeStamp; downXY = [e.clientX, e.clientY];
    const hit = cellAt(e.target);
    if (!hit) return;
    e.preventDefault();
    sc.focus({ preventScroll: true });
    if (st.edit) finishEdit(true);
    if (hit.k === -1) { // row number: click selects the row, Shift+click selects every row in between, dragging down the numbers selects a range
      const extend = e.shiftKey && st.act && st.anc;
      st.act = { r: hit.r, k: 0 };
      if (!extend) st.anc = { r: hit.r, k: 0 };
      st.rowSel = true; rowDrag = true; dragging = true;
      paint(); updateBar(); return;
    }
    if (e.target.classList.contains("thumb")) {
      select(hit.r, hit.k);
      return openImage(hit.r);
    }
    if (hit.el.classList.contains("dd") && e.clientX > hit.el.getBoundingClientRect().right - 24) {
      select(hit.r, hit.k);
      return startDropdown();
    }
    if (e.target.classList.contains("cbx")) {
      select(hit.r, hit.k);
      return startEdit();
    }
    const now = Date.now(), again = now - lastDown.t < 400 && lastDown.r === hit.r && lastDown.k === hit.k;
    lastDown = { t: now, r: hit.r, k: hit.k };
    select(hit.r, hit.k, e.shiftKey);
    if (again) return startEdit();
    dragging = true;
  });
  rowsEl.addEventListener("mouseover", (e) => {
    // A drag-select only counts while the button is really held, and only when the pointer starts moving soon after the press
    // and really travels. If a release was missed (outside the window, remote desktop, a menu), plain pointer movement
    // later on must never keep selecting rows.
    if ((rowDrag || dragging) && (!(e.buttons & 1) || e.timeStamp - downAt > 1200)) { rowDrag = false; dragging = false; }
    if ((rowDrag || dragging) && Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) < 4) return; // a click's own jitter is not a drag
    if (rowDrag) {
      const over = cellAt(e.target);
      if (over && over.r !== st.act.r) { st.act = { r: over.r, k: 0 }; paint(); }
      return;
    }
    if (!dragging) return;
    const hit = cellAt(e.target);
    if (hit && hit.k >= 0 && (hit.r !== st.act.r || hit.k !== st.act.k)) {
      st.anc ||= { ...st.act };
      const anchor = st.anc;
      st.act = { r: hit.r, k: hit.k };
      st.anc = anchor;
      st.rowSel = false;
      paint();
    }
  });
  addEventListener("mouseup", () => { dragging = false; rowDrag = false; });
  const endDrag = () => { dragging = false; rowDrag = false; };
  addEventListener("blur", endDrag);
  addEventListener("pointerup", endDrag);
  addEventListener("pointercancel", endDrag);
  addEventListener("dragend", endDrag);
  addEventListener("contextmenu", endDrag);
  document.addEventListener("visibilitychange", endDrag);
  sc.addEventListener("wheel", endDrag, { passive: true });

  // ---- keyboard (only when the grid itself has focus, not a filter box)
  sc.addEventListener("keydown", (e) => {
    if (e.target !== sc || st.edit) return;
    const a = st.act, mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
    if (mod && (key === "c" || key === "x") && a) { // the browser then copies the text box's selection
      const text = blockText();
      if (text !== null) { cb.value = text; cb.focus(); cb.select(); setTimeout(() => { backToGrid(); if (key === "x") clearRange(); }, 0); }
      return;
    }
    if (mod && key === "v" && a) { cb.value = ""; cb.focus(); return; } // the paste lands in the text box
    if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); return undoLast(); }
    if (mod && e.key.toLowerCase() === "a") { // Ctrl+A: every row
      e.preventDefault();
      if (st.total) { st.act = { r: st.total - 1, k: 0 }; st.anc = { r: 0, k: 0 }; st.rowSel = true; paint(); updateBar(); }
      return;
    }
    if (!a) {
      if (e.key.startsWith("Arrow") || e.key === "Tab") { e.preventDefault(); select(0, 0); }
      return;
    }
    const mv = (dr, dk) => { e.preventDefault(); if (mod && (dr || dk)) { dr = dr * 1e9; dk = dk * 1e9; } select(a.r + dr, a.k + dk, e.shiftKey); };
    switch (e.key) {
      case "ArrowDown": return mv(1, 0);
      case "ArrowUp": return mv(-1, 0);
      case "ArrowRight": return mv(0, 1);
      case "ArrowLeft": return mv(0, -1);
      case "Tab": return e.shiftKey ? (e.preventDefault(), select(a.r, a.k - 1)) : (e.preventDefault(), select(a.r, a.k + 1));
      case "PageDown": return mv(Math.floor(sc.clientHeight / ROW_H) - 2, 0);
      case "PageUp": return mv(-(Math.floor(sc.clientHeight / ROW_H) - 2), 0);
      case "Home": e.preventDefault(); return select(mod ? 0 : a.r, 0);
      case "End": e.preventDefault(); return select(mod ? st.total - 1 : a.r, list.length - 1);
      case "Enter": case "F2": e.preventDefault(); return startEdit();
      case " ":
        if (e.shiftKey) { e.preventDefault(); st.rowSel = true; paint(); return; } // like Sheets: select the whole row
        if (range() && (range().r2 > range().r1 || range().k2 > range().k1)) { e.preventDefault(); return toggleChecks(); }
        if (list[a.k]?.kind === "bool") { e.preventDefault(); return startEdit(); } break;
      case "Delete": case "Backspace": e.preventDefault(); return clearRange();
      case "Escape": st.anc = st.act; st.rowSel = false; return paint();
    }
    if (!mod && !e.altKey && e.key.length === 1) { e.preventDefault(); startEdit(e.key); }
  });

  // Space over a block of checkboxes ticks them all, or unticks them all when they were all ticked (like Sheets)
  async function toggleChecks() {
    const s = range();
    if (s.r2 - s.r1 > 2000) return toast("That is too many rows at once (limit 2,000).", "bad");
    for (let p = Math.floor(s.r1 / PAGE); p <= Math.floor(s.r2 / PAGE); p++) await loadPage(p);
    const cells = [];
    for (let r = s.r1; r <= s.r2; r++) {
      const row = rowAt(r);
      if (row) for (let k = s.k1; k <= s.k2; k++) if (list[k].kind === "bool") cells.push({ r, k, on: row[list[k].i + 1] === "TRUE" });
    }
    if (!cells.length) return;
    const value = cells.every((c) => c.on) ? "FALSE" : "TRUE";
    commit(cells.map(({ r, k }) => ({ r, k, value })));
  }

  function clearRange() {
    const s = range(), changes = [];
    if (!s) return;
    for (let r = s.r1; r <= s.r2; r++) for (let k = s.k1; k <= s.k2; k++) changes.push({ r, k, value: list[k].kind === "bool" ? "FALSE" : "" });
    commit(changes);
  }

  // ---- clipboard: Ctrl+C / Ctrl+X / Ctrl+V on the selected block, as tab-separated text (so it also pastes into Google Sheets or Excel).
  // Browsers only copy and paste through a text box, so a hidden one takes the focus for a moment while the key is handled.
  const cb = document.createElement("textarea");
  cb.className = "clipcatch";
  cb.tabIndex = -1;
  cb.setAttribute("aria-hidden", "true");
  el.append(cb);
  const backToGrid = () => sc.focus({ preventScroll: true });

  function blockText() {
    const s = range();
    if (!s) return null;
    const lines = [];
    for (let r = s.r1; r <= s.r2; r++) {
      const row = rowAt(r), cells = [];
      for (let k = s.k1; k <= s.k2; k++) {
        const v = row ? row[list[k].i + 1] : "";
        cells.push(/[\t\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : list[k].kind === "date" ? showDate(v) : v);
      }
      lines.push(cells.join("\t"));
    }
    if (s.r2 - s.r1 > 0 && [...Array(s.r2 - s.r1 + 1).keys()].some((n) => !rowAt(s.r1 + n))) toast("Only the rows already loaded were copied. Scroll through the rows first.", "bad");
    return lines.join("\n");
  }

  function applyPaste(raw) {
    const s = range();
    if (!s || !raw) return;
    const grid = parseTsv(raw.replace(/\r\n/g, "\n").replace(/\n$/, ""));
    const single = grid.length === 1 && grid[0].length === 1, changes = [];
    if (single && (s.r2 > s.r1 || s.k2 > s.k1)) { // one value pasted over a selected block fills it, like Sheets
      for (let r = s.r1; r <= s.r2; r++) for (let k = s.k1; k <= s.k2; k++) changes.push({ r, k, value: grid[0][0] });
    } else {
      grid.forEach((line, dr) => line.forEach((value, dk) => {
        const r = s.r1 + dr, k = s.k1 + dk;
        if (r < st.total && k < list.length) changes.push({ r, k, value });
      }));
    }
    if (changes.length > 2000) return toast("That is too much to paste at once (limit 2,000 cells).", "bad");
    commit(changes);
  }

  cb.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    backToGrid();
    applyPaste(text);
  });
  cb.addEventListener("keyup", backToGrid); // whatever happened, the grid gets the keyboard back

  function parseTsv(t) {
    const out = [[""]];
    let q = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i], row = out[out.length - 1];
      if (q) { if (ch === '"') { if (t[i + 1] === '"') { row[row.length - 1] += '"'; i++; } else q = false; } else row[row.length - 1] += ch; }
      else if (ch === '"' && row[row.length - 1] === "") q = true;
      else if (ch === "\t") row.push("");
      else if (ch === "\n") out.push([""]);
      else row[row.length - 1] += ch;
    }
    return out;
  }

  function renderCards() {
    $("#cards").innerHTML = meta.cards.map((c) => {
      const on = (st.card || "all") === c.key;
      return `<button class="qcard ${c.tone} ${on ? "on" : ""} ${c.n ? "" : "zero"}" data-card="${c.key}"><span class="qn">${fmt(c.n)}</span><span class="ql">${esc(c.label)}</span><span class="qd">${esc(c.hint)}</span></button>`;
    }).join("");
  }

  // ---- column filters, like Sheets: the funnel in each header opens sort + "Filter by condition" + "Filter by values"
  const nFilters = () => Object.values(st.cf).filter((f) => f.c || f.v).length;
  const COND = {
    text: [["contains", "Text contains"], ["notcontains", "Text does not contain"], ["eq", "Text is exactly"], ["starts", "Text starts with"], ["ends", "Text ends with"], ["empty", "Is empty"], ["notempty", "Is not empty"]],
    num: [["eq", "Equal to"], ["neq", "Not equal to"], ["gt", "Greater than"], ["gte", "Greater than or equal to"], ["lt", "Less than"], ["lte", "Less than or equal to"], ["between", "Is between"], ["empty", "Is empty"], ["notempty", "Is not empty"]],
    date: [["eq", "Date is"], ["lt", "Date is before"], ["gt", "Date is after"], ["between", "Date is between"], ["empty", "Is empty"], ["notempty", "Is not empty"]],
  };
  const valueLabel = (c, v) => (v === "" ? "(Blanks)" : c.kind === "date" ? showDate(v) : c.kind === "bool" ? (v === "TRUE" ? "Checked" : "Unchecked") : v);
  let fm = null; // the open filter menu: {el, col, outside}

  function closeFilterMenu() {
    if (!fm) return;
    document.removeEventListener("mousedown", fm.outside, true);
    fm.el.remove();
    fm = null;
  }

  async function openFilterMenu(c, anchor) {
    closeFilterMenu();
    closeDropdown();
    const cur = st.cf[c.i] || {};
    // the values are kept as "everything except these" (out) or "only these" (in), so a long list never has to be sent
    const draft = { c: cur.c ? { ...cur.c } : null, mode: cur.v ? cur.v.mode : "out", set: new Set(cur.v ? cur.v.list : []) };
    const condKind = c.kind === "num" ? "num" : c.kind === "date" ? "date" : "text";
    const inputType = condKind === "date" ? "date" : "text";
    const sorted = st.sort === String(c.i);
    const menu = document.createElement("div");
    menu.className = "fmenu";
    menu.innerHTML = `<div class="fm-title">${esc(c.name)}</div>
      <button type="button" class="fm-item${sorted && st.dir === "asc" ? " on" : ""}" data-sort="asc">Sort A → Z</button>
      <button type="button" class="fm-item${sorted && st.dir === "desc" ? " on" : ""}" data-sort="desc">Sort Z → A</button>
      ${sorted ? `<button type="button" class="fm-item" data-sort="none">Remove sort</button>` : ""}
      <hr>
      ${c.kind === "bool" ? "" : `<div class="fm-sec"><div class="fm-h">Filter by condition</div>
        <select class="fc-op"><option value="">None</option>${COND[condKind].map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
        <input class="fc-a" type="${inputType}" autocomplete="off"><input class="fc-b" type="${inputType}" autocomplete="off"></div><hr>`}
      <div class="fm-sec"><div class="fm-h">Filter by values</div>
        <input class="fv-search" type="search" placeholder="Search values…" autocomplete="off">
        <div class="fv-bar"><button type="button" data-fv="all">Select all</button><button type="button" data-fv="none">Clear</button><span class="muted fv-count"></span></div>
        <div class="fv-list"><div class="muted fv-note">Loading…</div></div></div>
      ${ctx.isAdmin() ? `<hr><button type="button" class="fm-item" data-protectcol>🔒 ${colLocks[c.i] ? "Change protection…" : "Protect this column…"}</button>` : ""}
      <div class="fm-foot"><button type="button" class="btn small" data-fm="clear">Clear filter</button><span class="grow"></span><button type="button" class="btn small" data-fm="cancel">Cancel</button><button type="button" class="btn small primary" data-fm="ok">OK</button></div>`;
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + "px";
    menu.style.top = r.bottom + 4 + "px";
    menu.style.maxHeight = Math.max(260, innerHeight - r.bottom - 16) + "px";
    fm = { el: menu, col: c.i, outside: (e) => { if (!menu.contains(e.target) && !e.target.closest("[data-fb]")) closeFilterMenu(); } };
    document.addEventListener("mousedown", fm.outside, true);

    // condition
    const op = menu.querySelector(".fc-op"), ca = menu.querySelector(".fc-a"), cb = menu.querySelector(".fc-b");
    const syncCond = () => {
      if (!op) return;
      ca.hidden = !op.value || op.value === "empty" || op.value === "notempty";
      cb.hidden = op.value !== "between";
    };
    if (op) {
      op.value = draft.c?.op || "";
      ca.value = draft.c?.a || ""; cb.value = draft.c?.b || "";
      syncCond();
      op.onchange = () => { syncCond(); if (!ca.hidden) ca.focus(); };
    }

    // values: what is in the column among the rows the OTHER filters leave visible
    const search = menu.querySelector(".fv-search"), listEl = menu.querySelector(".fv-list"), countEl = menu.querySelector(".fv-count");
    const others = Object.fromEntries(Object.entries(st.cf).filter(([k]) => +k !== c.i));
    let shown = [], more = false;
    const checked = (v) => (draft.mode === "out" ? !draft.set.has(v) : draft.set.has(v));
    const drawValues = () => {
      listEl.innerHTML = shown.map((x, n) => `<label class="fv-row"><input type="checkbox" data-n="${n}" ${checked(x.v) ? "checked" : ""}><span class="fv-t">${esc(valueLabel(c, x.v))}</span><span class="muted fv-n">${fmt(x.n)}</span></label>`).join("")
        || `<div class="muted fv-note">No matching values</div>`;
      if (more) listEl.insertAdjacentHTML("beforeend", `<div class="muted fv-note">Showing the first 500 values. Search to find others.</div>`);
      countEl.textContent = shown.length ? `${fmt(shown.filter((x) => checked(x.v)).length)} of ${fmt(shown.length)} selected` : "";
    };
    const loadValues = async () => {
      try {
        const out = await api("/api/values", { col: c.i, s: search.value.trim(), q: st.q, card: st.card, flt: others });
        if (fm?.el !== menu) return;
        shown = out.values; more = out.more;
        drawValues();
      } catch (e) { toast(e.message, "bad"); }
    };
    const searchSoon = debounce(loadValues, 250);
    search.oninput = searchSoon;
    menu.addEventListener("change", (e) => {
      const box = e.target.closest(".fv-row input");
      if (!box) return;
      const v = shown[+box.dataset.n].v;
      if ((draft.mode === "out") === box.checked) draft.set.delete(v); else draft.set.add(v);
      drawValues();
    });
    loadValues();

    const finish = () => { closeFilterMenu(); drawHead(); reset(); sc.focus({ preventScroll: true }); };
    const apply = () => {
      let cond = null;
      if (op && op.value) {
        const a = ca.value.trim(), b = cb.value.trim(), need = !["empty", "notempty"].includes(op.value);
        if (need && !a) return toast("Enter a value for the condition.", "bad");
        if (need && condKind === "num" && !Number.isFinite(Number(a.replace(/,/g, "")))) return toast("This column only takes numbers.", "bad");
        if (op.value === "between" && (!b || (condKind === "num" && !Number.isFinite(Number(b.replace(/,/g, "")))))) return toast("Enter the second value too.", "bad");
        cond = { op: op.value, a: need ? a : "", b: op.value === "between" ? b : "" };
      }
      const vals = draft.mode === "out" && !draft.set.size ? null : { mode: draft.mode, list: [...draft.set] };
      if (cond || vals) st.cf[c.i] = { c: cond, v: vals }; else delete st.cf[c.i];
      finish();
    };
    menu.addEventListener("click", (e) => {
      const so = e.target.closest("[data-sort]"), fv = e.target.closest("[data-fv]"), fb = e.target.closest("[data-fm]");
      if (e.target.closest("[data-protectcol]")) {
        closeFilterMenu();
        protectDialog({ sheet: "orders", kind: "col", targets: [c.i], what: `the column "${c.name}"`, current: lockDefs[colLocks[c.i]] }).then((saved) => saved && refreshData());
        return;
      }
      if (so) {
        if (so.dataset.sort === "none") { st.sort = ""; st.dir = "asc"; } else { st.sort = String(c.i); st.dir = so.dataset.sort; }
        finish();
      } else if (fv) {
        const searching = !!search.value.trim();
        if (fv.dataset.fv === "all") {
          if (!searching) { draft.mode = "out"; draft.set.clear(); }
          else shown.forEach((x) => (draft.mode === "out" ? draft.set.delete(x.v) : draft.set.add(x.v)));
        } else if (!searching) { draft.mode = "in"; draft.set.clear(); }
        else shown.forEach((x) => (draft.mode === "out" ? draft.set.add(x.v) : draft.set.delete(x.v)));
        drawValues();
      } else if (fb) {
        if (fb.dataset.fm === "ok") apply();
        else if (fb.dataset.fm === "clear") { delete st.cf[c.i]; finish(); }
        else closeFilterMenu();
      }
    });
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closeFilterMenu(); sc.focus({ preventScroll: true }); }
      else if (e.key === "Enter" && e.target.matches(".fc-a, .fc-b")) { e.preventDefault(); apply(); }
    });
    (op && !ca.hidden ? ca : search).focus();
  }

  // ---- stay current: when anyone changes an order (a scan, an edit, an import), the rows on screen reload by themselves
  async function refreshData() {
    const my = ++gen; // anything still loading from before is dropped
    inflight.clear();
    const top = Math.max(0, sc.scrollTop - HEAD_H - FILT_H);
    const first = Math.max(0, Math.floor(top / ROW_H) - 4), last = Math.ceil((top + sc.clientHeight) / ROW_H) + 4;
    const want = [];
    for (let p = Math.floor(first / PAGE); p <= Math.floor(last / PAGE); p++) want.push(p);
    try {
      const fresh = await Promise.all(want.map((p) => api("/api/orders", query({ offset: p * PAGE, limit: PAGE })).then((r) => [p, r])));
      if (my !== gen) return;
      pages.clear();
      for (const [p, r] of fresh) {
        pages.set(p, r.rows);
        const before = JSON.stringify(colLocks);
        takeLocks(r, r.rows);
        if (JSON.stringify(colLocks) !== before) drawHead();
        for (const [k, id] of Object.entries(r.dv)) dvMap.set(k, id);
        for (const [id, l] of Object.entries(r.lists)) lists.set(+id, l);
        st.total = r.total;
      }
      body.style.height = st.total * ROW_H + "px";
      $("#count").textContent = $("#sbL").textContent = countText();
      refreshCards();
      paint(); updateBar();
    } catch { /* try again at the next change */ }
  }
  async function checkForChanges() {
    if (!el.isConnected || location.hash !== "#orders") return clearInterval(poll);
    if (document.hidden || st.edit || dd || fm || dragging) return;
    try {
      const { v } = await api("/api/version");
      if (knownV === null) knownV = v;
      else if (v !== knownV) { knownV = v; await refreshData(); }
    } catch { /* offline for a moment */ }
  }
  const poll = setInterval(checkForChanges, 2000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForChanges(); });

  // ---- admins: add and delete columns (the page reloads afterwards, so everyone's grid has the new set)
  async function addColumn() {
    const r = await dialog({
      title: "Add a column", wide: true,
      body: `<div class="formgrid" style="grid-template-columns:1fr 200px">
          <label class="field"><span>Column name</span><input name="name" maxlength="60" required autocomplete="off"></label>
          <label class="field"><span>Type</span><select name="kind" onchange="this.closest('form').querySelector('.dd-opts').hidden = this.value !== 'dropdown'">
            <option value="text">Text</option><option value="num">Number</option><option value="date">Date</option><option value="bool">Checkbox</option><option value="dropdown">Dropdown</option></select></label></div>
        <label class="field dd-opts" hidden style="margin-top:10px"><span>Choices, one per line</span><textarea name="options" rows="5" spellcheck="false"></textarea></label>
        <p class="hint">The column is added at the end for everyone and starts empty. Imports from the 3PL sheet fill it only if the sheet has a column with the same name.</p>`,
      actions: [["Cancel", "close"], ["Add column", "ok", "primary"]],
    });
    if (r.value !== "ok") return;
    try {
      const f = Object.fromEntries(new FormData(r.el.querySelector("form")));
      const out = await api("/api/columns/add", f);
      toast(`Added the column "${out.name}". Reloading…`);
      setTimeout(() => location.reload(), 700);
    } catch (e) { toast(e.message, "bad"); }
  }
  $("#hrow").addEventListener("contextmenu", (e) => {
    const th = e.target.closest(".hc:not(.rn)"), fb = th?.querySelector("[data-fb]");
    if (!fb || !ctx.isAdmin()) return; // only admins get a column menu
    e.preventDefault();
    const c = cols.find((x) => x.i === +fb.dataset.fb);
    closeContextMenu();
    const m = document.createElement("div");
    m.className = "menu ctxmenu";
    m.style.cssText = `position:fixed;left:${Math.min(e.clientX, innerWidth - 290)}px;top:${Math.min(e.clientY + 4, innerHeight - 140)}px;min-width:250px;z-index:70`;
    m.innerHTML = `<div class="mhead">${esc(c.name)}</div>
      <button data-hctx="rename">✏️ Rename this column…</button>
      <button data-hctx="protect">🔒 ${colLocks[c.i] ? "Change protection…" : "Protect this column…"}</button>
      <button data-hctx="delete" class="fm-danger" ${c.protected ? "disabled" : ""} title="${esc(c.protected ? `${c.name} cannot be deleted. ${c.protected}.` : "")}">Delete this column…</button>`;
    document.body.append(m);
    const outside = (ev) => { if (!m.contains(ev.target)) closeContextMenu(); };
    const key = (ev) => { if (ev.key === "Escape") closeContextMenu(); };
    ctxMenu = { el: m, outside, key };
    setTimeout(() => { if (ctxMenu?.el === m) { document.addEventListener("mousedown", outside, true); document.addEventListener("keydown", key, true); } }, 0);
    m.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-hctx]");
      if (!b || b.disabled) return;
      closeContextMenu();
      if (b.dataset.hctx === "delete") deleteColumn(c);
      else if (b.dataset.hctx === "rename") renameColumn(c);
      else protectDialog({ sheet: "orders", kind: "col", targets: [c.i], what: `the column "${c.name}"`, current: lockDefs[colLocks[c.i]] }).then((saved) => saved && refreshData());
    });
  });

  async function renameColumn(c) {
    const label = await renameDialog(c.name, c.key);
    if (label === null) return;
    try {
      await api("/api/columns/rename", { i: c.i, label });
      toast(label ? `Renamed to "${label}". Reloading…` : "Name put back. Reloading…");
      setTimeout(() => location.reload(), 600);
    } catch (e) { toast(e.message, "bad"); }
  }

  async function deleteColumn(c) {
    if (!(await confirmBox(`Delete the column "${c.name}"?`, "The column disappears for everyone. You can bring it back, with everything in it, from Trash. Until then an import skips a sheet column with this name.", "Delete column"))) return;
    try {
      await api("/api/columns/delete", { i: c.i });
      toast(`Deleted "${c.name}". Reloading…`);
      setTimeout(() => location.reload(), 700);
    } catch (e) { toast(e.message, "bad"); }
  }

  // ---- add rows: the button, and the square at the corner of a selection (drag down to fill, past the last row to add rows)
  let fillH = null;
  function placeFill() {
    const s = range();
    if (!s || st.edit || dd || !rowAt(s.r2) || !list[s.k2]) {
      fillH?.remove();
      fillH = null;
      return;
    }
    if (!fillH) {
      fillH = document.createElement("i");
      fillH.className = "fillh";
      fillH.title = "Drag down to fill. Drag past the last row to add new rows.";
      body.append(fillH);
    }
    const k = s.k2, right = k === 0 ? sc.scrollLeft + RN_W + width(list[0]) : lefts[k] + width(list[k]);
    fillH.style.left = right - 7 + "px";
    fillH.style.top = (s.r2 + 1) * ROW_H - 7 + "px";
    fillH.classList.toggle("pinned", k === 0);
  }

  async function addRows(rows, { selectCols = null } = {}) {
    let out;
    try { out = await api("/api/rows/add", { rows }); } catch (e) { return toast(e.message, "bad"); }
    if (!isEmpty()) { // the new rows sit at the bottom of the unfiltered, unsorted list
      st.q = ""; st.card = ""; st.cf = {}; st.sort = ""; st.dir = "asc"; $("#q").value = "";
      renderCards(); drawHead();
      toast("Cleared the filters and sort so the new rows show.");
    }
    cancelEdit();
    gen++; pages.clear(); inflight.clear(); st.act = st.anc = null; st.rowSel = false;
    await loadPage(0);
    sc.scrollTop = sc.scrollHeight;
    paint();
    const lastIdx = st.total - 1, firstNew = st.total - out.rns.length;
    for (let i = 0; i < 30 && !rowAt(lastIdx); i++) await new Promise((r) => setTimeout(r, 100));
    refreshCards();
    if (selectCols) { st.act = { r: lastIdx, k: selectCols[1] }; st.anc = { r: firstNew, k: selectCols[0] }; paint(); updateBar(); }
    else select(firstNew, 0);
    sc.focus({ preventScroll: true });
    return out;
  }

  async function doFill(s, target) {
    const n = target - s.r2, exist = Math.max(0, Math.min(target, st.total - 1) - s.r2);
    for (let p = Math.floor(s.r1 / PAGE); p <= Math.floor(Math.min(target, st.total - 1) / PAGE); p++) await loadPage(p);
    const series = [];
    for (let k = s.k1; k <= s.k2; k++) {
      const c = list[k], src = [];
      for (let r = s.r1; r <= s.r2; r++) src.push(rowAt(r)?.[c.i + 1] ?? "");
      // dates, checkboxes and statuses repeat; text and numbers continue a pattern (LN-295 -> LN-296, 10 20 -> 30 40)
      series.push({ k, vals: ["date", "bool", "select"].includes(c.kind) ? Array.from({ length: n }, (_, i) => src[i % src.length]) : nextSeries(src, n) });
    }
    const changes = [];
    for (let i = 0; i < exist; i++) for (const sr of series) changes.push({ r: s.r2 + 1 + i, k: sr.k, value: sr.vals[i] });
    if (changes.length && !(await commit(changes))) return;
    if (n - exist > 0) {
      const rows = [];
      for (let i = exist; i < n; i++) { const o = {}; for (const sr of series) o[list[sr.k].i] = sr.vals[i]; rows.push(o); }
      await addRows(rows, { selectCols: [s.k1, s.k2] });
    } else {
      st.act = { r: target, k: s.k2 }; st.anc = { r: s.r1, k: s.k1 }; paint(); updateBar();
    }
  }

  body.addEventListener("pointerdown", (e) => {
    if (!e.target.closest(".fillh") || e.button !== 0) return;
    e.preventDefault();
    const s = range();
    if (!s) return;
    const box = document.createElement("div");
    box.className = "fillbox";
    body.append(box);
    const x1 = s.k1 === 0 ? RN_W : lefts[s.k1], w = lefts[s.k2] + width(list[s.k2]) - x1;
    let target = s.r2, lastY = e.clientY;
    const update = () => {
      const r = Math.floor((lastY - body.getBoundingClientRect().top) / ROW_H);
      target = Math.max(s.r2, Math.min(r, s.r2 + 500));
      box.style.cssText = `left:${x1}px;top:${s.r1 * ROW_H}px;width:${w}px;height:${(target - s.r1 + 1) * ROW_H}px`;
    };
    const timer = setInterval(() => { // holding the pointer near the bottom edge keeps scrolling, so more rows can be added
      if (lastY > sc.getBoundingClientRect().bottom - 30) { sc.scrollTop += 22; update(); }
    }, 40);
    const mv = (ev) => { lastY = ev.clientY; update(); };
    const up = async () => {
      removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
      clearInterval(timer);
      box.remove();
      if (target > s.r2) await doFill(s, target);
    };
    addEventListener("pointermove", mv);
    addEventListener("pointerup", up);
    update();
  });

  // ---- right-click: a cell shows its edit history; admins can also delete the selected rows
  let ctxMenu = null;
  function closeContextMenu() {
    if (!ctxMenu) return;
    document.removeEventListener("mousedown", ctxMenu.outside, true);
    document.removeEventListener("keydown", ctxMenu.key, true);
    ctxMenu.el.remove();
    ctxMenu = null;
  }
  function openContextMenu(x, y, hit) {
    closeContextMenu();
    const sel = range(), rows = sel ? sel.r2 - sel.r1 + 1 : 1, c = hit.k >= 0 ? list[hit.k] : null, row = rowAt(hit.r);
    if (!row) return;
    const m = document.createElement("div");
    m.className = "menu ctxmenu";
    m.style.cssText = `position:fixed;left:${Math.min(x, innerWidth - 270)}px;top:${Math.min(y + 4, innerHeight - 140)}px;min-width:240px;z-index:70`;
    m.innerHTML = `<div class="mhead">${esc(row[cellCol("Label Number")] || "")}${c ? " · " + esc(c.name) : ""}</div>
      ${c ? `<button data-ctx="history">🕘 Show edit history</button>` : ""}
      ${c?.key === "Updated by" ? `<button data-ctx="ships">📦 Show shipping record</button>` : ""}
      ${ctx.isAdmin() ? `<button data-ctx="protect">🔒 Protect ${rows === 1 ? "this row" : fmt(rows) + " rows"}…</button><button data-ctx="delete" class="fm-danger">Delete ${rows === 1 ? "this row" : fmt(rows) + " rows"}…</button>` : ""}`;
    document.body.append(m);
    const outside = (e) => { if (!m.contains(e.target)) closeContextMenu(); };
    const key = (e) => { if (e.key === "Escape") closeContextMenu(); };
    ctxMenu = { el: m, outside, key };
    setTimeout(() => { if (ctxMenu?.el === m) { document.addEventListener("mousedown", outside, true); document.addEventListener("keydown", key, true); } }, 0);
    m.addEventListener("click", (e) => {
      const b = e.target.closest("[data-ctx]");
      if (!b) return;
      closeContextMenu();
      if (b.dataset.ctx === "history") showHistory(hit.r, hit.k);
      else if (b.dataset.ctx === "ships") showShipping(hit.r);
      else if (b.dataset.ctx === "protect") protectSelectedRows();
      else deleteSelectedRows();
    });
  }
  rowsEl.addEventListener("contextmenu", (e) => {
    const hit = cellAt(e.target);
    if (!hit) return;
    const onNumber = hit.k === -1;
    if (onNumber && !ctx.isAdmin()) return; // members get no row menu
    e.preventDefault();
    const s = range();
    if (onNumber) {
      if (!st.rowSel || !s || hit.r < s.r1 || hit.r > s.r2) { st.act = { r: hit.r, k: 0 }; st.anc = { r: hit.r, k: 0 }; st.rowSel = true; paint(); updateBar(); }
    } else if (!s || hit.r < s.r1 || hit.r > s.r2 || hit.k < s.k1 || hit.k > s.k2) select(hit.r, hit.k);
    openContextMenu(e.clientX, e.clientY, hit);
  });

  async function showHistory(r, k) {
    const row = rowAt(r), c = list[k];
    if (!row || !c) return;
    let h;
    try { h = await api(`/api/history?rn=${row[0]}&col=${c.i}`); } catch (e) { return toast(e.message, "bad"); }
    const val = (v) => (v === "" ? `<span class="muted">(blank)</span>` : esc(c.kind === "date" ? showDate(v) : v));
    const body = h.events.length
      ? `<div style="max-height:380px;overflow:auto"><table style="min-width:0"><thead><tr><th>When</th><th>Who</th><th>Changed</th></tr></thead><tbody>
          ${h.events.map((ev) => `<tr><td style="white-space:nowrap" title="${esc(ev.at)}">${esc(ago(ev.at))}<div class="muted" style="font-size:12px">${esc(ev.at)}</div></td>
            <td><b>${esc(ev.who)}</b></td><td>${val(ev.old)} <span class="muted">→</span> ${val(ev.new)}${ev.note ? `<div class="muted" style="font-size:12px">${esc(ev.note)}</div>` : ""}</td></tr>`).join("")}</tbody></table></div>
         <p class="hint">Edits and scans are listed with the person's name. Changes made by an import are not listed cell by cell.</p>`
      : `<p class="muted">No changes recorded for this cell yet. Edits and scans from now on show here, with who made them.</p>`;
    await dialog({ title: `Edit history · ${row[cellCol("Label Number")] || row[0]} · ${c.name}`, body, wide: true, actions: [["Close", "close", "primary"]] });
    sc.focus({ preventScroll: true });
  }

  // who shipped this order (to the customer or back to Amazon) and when, newest first
  async function showShipping(r) {
    const row = rowAt(r);
    if (!row) return;
    let h;
    try { h = await api(`/api/ship-events?rn=${row[0]}`); } catch (e) { return toast(e.message, "bad"); }
    const body = h.events.length
      ? `<div style="max-height:380px;overflow:auto"><table style="min-width:0"><thead><tr><th>When (US Eastern)</th><th>Step</th><th>Operator</th></tr></thead><tbody>
          ${h.events.map((ev) => `<tr><td style="white-space:nowrap">${esc(ev.at)}<div class="muted" style="font-size:12px">${esc(ago(ev.at))}</div></td>
            <td>${ev.kind === "amazon" ? "Shipped to Amazon" : "Shipped to Customer"}${ev.note ? `<div class="muted" style="font-size:12px">${esc(ev.note)}</div>` : ""}</td><td><b>${esc(ev.operator)}</b></td></tr>`).join("")}</tbody></table></div>
         <p class="hint">The Dashboard counts each shipping step for the operator listed here, even if someone else scanned the package afterwards.</p>`
      : `<p class="muted">No shipping steps recorded for this order yet. Scans and ticks of Shipped to Customer / Shipped to Amazon from now on are listed here with the operator.</p>`;
    await dialog({ title: `Shipping record · ${row[cellCol("Label Number")] || row[0]}`, body, wide: true, actions: [["Close", "close", "primary"]] });
    sc.focus({ preventScroll: true });
  }

  // ---- admins: delete rows (they go to Trash and can be restored) and the Trash itself
  async function deleteSelectedRows() {
    const sel = range();
    if (!sel) return;
    let rns;
    try { rns = (await api("/api/orders", query({ offset: sel.r1, limit: sel.r2 - sel.r1 + 1, rns_only: true }))).rns; } // however many rows are selected
    catch (e) { return toast(e.message, "bad"); }
    if (!rns.length) return;
    if (!(await confirmBox(`Delete ${rns.length === 1 ? "this row" : fmt(rns.length) + " rows"}?`, "They disappear for everyone. You can bring them back from Trash.", "Delete"))) return;
    try {
      await api("/api/rows/delete", { rns });
      st.act = st.anc = null; st.rowSel = false;
      await refreshData();
      const t = $("#toasts");
      t.innerHTML = `<div class="toast" role="status">Deleted ${fmt(rns.length)} row${rns.length === 1 ? "" : "s"}. <button class="btn small" id="undoDelete" style="margin-left:10px">Undo</button></div>`;
      $("#undoDelete").onclick = async () => {
        t.innerHTML = "";
        try { await api("/api/rows/restore", { rns }); await refreshData(); toast("Restored."); } catch (e) { toast(e.message, "bad"); }
      };
      setTimeout(() => { if (t.querySelector("#undoDelete")) t.innerHTML = ""; }, 12000);
    } catch (e) { toast(e.message, "bad"); }
  }

  async function protectSelectedRows() {
    const sel = range();
    if (!sel) return;
    let rns;
    try { rns = (await api("/api/orders", query({ offset: sel.r1, limit: sel.r2 - sel.r1 + 1, rns_only: true }))).rns; } catch (e) { return toast(e.message, "bad"); }
    if (!rns.length) return;
    const first = rowLocks.get(rns[0]);
    const saved = await protectDialog({ sheet: "orders", kind: "row", targets: rns, what: rns.length === 1 ? "this row" : `these ${fmt(rns.length)} rows`, current: first ? lockDefs[first] : null });
    if (saved) await refreshData();
  }

  async function trashDialog() {
    let t;
    try { t = await api("/api/trash"); } catch (e) { return toast(e.message, "bad"); }
    if (!t.rows.length && !t.columns.length) return toast("The trash is empty.");
    const box = "max-height:230px;overflow:auto;border:1px solid var(--line);border-radius:6px;padding:4px";
    const r = await dialog({
      title: "Trash", wide: true,
      body: `<p class="muted">Tick what to bring back. Rows return exactly as they were, with their edit history. Columns return with everything that was in them.</p>
        ${t.columns.length ? `<h3 style="margin:10px 0 6px">Deleted columns</h3><div style="${box}">${t.columns.map((x) => `<label class="check" style="display:flex;gap:8px;padding:4px 6px"><input type="checkbox" name="col" value="${x.i}"><b style="min-width:180px">${esc(x.name)}</b><span class="muted">${esc(x.by)} · ${esc(x.at)}</span></label>`).join("")}</div>` : ""}
        ${t.rows.length ? `<h3 style="margin:14px 0 6px">Deleted rows${t.total > t.rows.length ? ` (latest ${t.rows.length} of ${fmt(t.total)})` : ` (${fmt(t.total)})`}</h3>
          <label class="check" style="display:block;margin:0 0 6px"><input type="checkbox" name="allrows"> <b>Restore all ${fmt(t.total)} deleted rows</b></label><div style="${box}">${t.rows.map((x) => `<label class="check" style="display:flex;gap:8px;padding:4px 6px"><input type="checkbox" name="row" value="${x.rn}">
          <span class="mono" style="min-width:90px">${esc(x.label)}</span><span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(x.product)}</span><span class="muted" style="white-space:nowrap">${esc(x.customer)} · ${esc(x.by)} · ${esc(x.at)}</span></label>`).join("")}</div>` : ""}`,
      actions: [["Close", "close"], ["Restore ticked", "ok", "primary"]],
    });
    if (r.value !== "ok") return;
    const rns = [...r.el.querySelectorAll('input[name="row"]:checked')].map((x) => +x.value);
    const cols2 = [...r.el.querySelectorAll('input[name="col"]:checked')].map((x) => +x.value);
    const allRows = !!r.el.querySelector('input[name="allrows"]:checked');
    if (!rns.length && !cols2.length && !allRows) return;
    try {
      let msg = [];
      for (const i of cols2) { const o = await api("/api/columns/restore", { i }); msg.push(`column "${o.restored}"`); }
      if (rns.length || allRows) { const o = await api("/api/rows/restore", allRows ? { all: true } : { rns }); msg.push(`${fmt(o.count)} row${o.count === 1 ? "" : "s"}`); }
      toast(`Restored ${msg.join(" and ")}. Reloading…`);
      setTimeout(() => location.reload(), 700);
    } catch (e) { toast(e.message, "bad"); }
  }

  // ---- filter views: saved sets of filters + sort that anyone can come back to
  const sortedF = (f) => JSON.stringify(Object.entries(f).sort(([a], [b]) => (a < b ? -1 : 1)));
  const snap = () => ({ q: st.q, card: st.card, cf: JSON.parse(JSON.stringify(st.cf)), sort: st.sort, dir: st.sort ? st.dir : "asc" });
  const isEmpty = () => !st.q && !st.card && !st.sort && !nFilters();
  const known = (cf) => Object.fromEntries(Object.entries(cf).filter(([k]) => cols.some((c) => c.i === +k))); // a deleted column's filter is dropped
  const sameAs = (v) => v.q === st.q && v.card === st.card && v.sort === st.sort && (!v.sort || v.dir === st.dir) && sortedF(known(v.cf)) === sortedF(st.cf);
  const activeView = () => views.find((v) => v.id === activeId);
  const canChange = (v) => ctx.isAdmin() || v.owner === ctx.me.username;
  const describe = (v) => {
    const parts = [];
    if (v.q) parts.push(`search "${v.q}"`);
    const card = meta.cards.find((c) => c.key === v.card);
    if (card) parts.push(card.label);
    for (const [k, f] of Object.entries(known(v.cf))) {
      const name = cols.find((c) => c.i === +k).name;
      if (f.c) parts.push(`${name} ${f.c.op}${f.c.a ? " " + f.c.a : ""}`);
      if (f.v) parts.push(`${name}: ${f.v.mode === "in" ? f.v.list.length + " value(s)" : "all but " + f.v.list.length}`);
    }
    if (v.sort) parts.push(`sorted by ${cols.find((c) => c.i === +v.sort)?.name || "a deleted column"} ${v.dir === "desc" ? "Z→A" : "A→Z"}`);
    return parts.join(" · ") || "no filters";
  };
  function updateViewsBtn() {
    const btn = $("#viewsBtn"), v = activeView();
    if (!btn) return;
    if (activeId && !v) activeId = "";
    btn.textContent = v ? `View: ${v.name}${sameAs(v) ? "" : " •"} ▾` : "Filter views ▾";
    btn.classList.toggle("primary", !!v);
    btn.title = v ? (sameAs(v) ? describe(v) : "This view has changes you have not saved. " + describe(v)) : "";
  }
  function setView(v) {
    const s = v || { q: "", card: "", cf: {}, sort: "", dir: "asc" };
    st.q = s.q; st.card = s.card; st.cf = JSON.parse(JSON.stringify(known(s.cf))); st.sort = s.sort; st.dir = s.dir;
    $("#q").value = s.q;
    activeId = v ? v.id : "";
    store.set("gt_orders_view", activeId);
    renderCards(); drawHead(); reset();
  }
  async function viewsCall(path, body, notice) {
    try {
      views = (await api(path, body)).views;
      if (notice) toast(notice);
    } catch (e) { toast(e.message, "bad"); }
    updateViewsBtn();
  }
  async function askName(title, value = "") {
    const r = await dialog({
      title, body: `<label class="field"><span>Name</span><input name="name" value="${esc(value)}" maxlength="80" required autocomplete="off"></label>`,
      actions: [["Cancel", "close"], ["Save", "ok", "primary"]],
    });
    return r.value === "ok" ? r.el.querySelector("input[name=name]").value.trim() : "";
  }
  function renderViewsMenu() {
    const wrap = $("#viewsWrap");
    wrap.querySelector(".menu")?.remove();
    const cur = activeView();
    const rows = views.map((v) => `<div class="vrow"><button data-view="${esc(v.id)}" title="${esc(describe(v))}${v.owner_name ? " · made by " + esc(v.owner_name) : ""}">${v.id === activeId ? "✓ " : ""}${esc(v.name)}</button>${canChange(v)
      ? `<button class="vact" data-vact="rename" data-id="${esc(v.id)}" title="Rename">✎</button><button class="vact" data-vact="delete" data-id="${esc(v.id)}" title="Delete">✕</button>` : ""}</div>`).join("");
    wrap.insertAdjacentHTML("beforeend", `<div class="menu vmenu"><div class="mhead">Filter views are shared with everyone who signs in.</div>
      <div class="vrow"><button data-view="">${activeId ? "" : "✓ "}None (show everything)</button></div>${rows}<hr>
      ${cur && !sameAs(cur) && canChange(cur) ? `<button data-vact="update">Update "${esc(cur.name)}" with the current filters</button>` : ""}
      <button data-vact="new" ${isEmpty() ? "disabled" : ""}>＋ Save the current filters as a new view…</button>
      ${isEmpty() ? `<div class="mhead">Set a filter, a search or a sort first, then save it here.</div>` : ""}</div>`);
  }
  const closeViewsMenu = () => $("#viewsWrap")?.querySelector(".menu")?.remove();
  async function viewsAction(b) {
    const id = b.dataset.id, v = views.find((x) => x.id === id), act = b.dataset.vact;
    closeViewsMenu();
    if (act === "new") {
      const name = await askName("Save as a filter view");
      if (!name) return;
      await viewsCall("/api/views/save", { name, ...snap() }, `Saved the view "${name}".`);
      activeId = views[views.length - 1]?.id || ""; store.set("gt_orders_view", activeId); updateViewsBtn();
    } else if (act === "update") {
      const cur = activeView();
      await viewsCall("/api/views/save", { id: cur.id, name: cur.name, ...snap() }, `Updated "${cur.name}".`);
    } else if (act === "rename" && v) {
      const name = await askName("Rename the filter view", v.name);
      if (name) await viewsCall("/api/views/rename", { id, name });
    } else if (act === "delete" && v) {
      const r = await dialog({ title: "Delete this filter view?", body: `<p>"${esc(v.name)}" is removed for everyone. Your orders are not affected.</p>`, actions: [["Cancel", "close"], ["Delete", "yes", "primary"]] });
      if (r.value === "yes") await viewsCall("/api/views/delete", { id }, `Deleted "${v.name}".`);
    }
  }

  // ---- page-level events
  sc.addEventListener("scroll", () => { closeFilterMenu(); placeEditor(); requestAnimationFrame(paint); });
  sc.addEventListener("click", (e) => {
    const fb = e.target.closest("[data-fb]");
    if (!fb) return;
    const c = cols.find((x) => x.i === +fb.dataset.fb);
    if (fm && fm.col === c.i) closeFilterMenu(); else openFilterMenu(c, fb);
  });
  el.onclick = async (e) => {
    if (e.target.closest("#viewsBtn")) {
      if ($("#viewsWrap .menu")) closeViewsMenu(); else renderViewsMenu();
      return;
    }
    const vb = e.target.closest("#viewsWrap .menu button");
    if (vb) {
      if (vb.disabled) return;
      if ("view" in vb.dataset) { closeViewsMenu(); setView(views.find((v) => v.id === vb.dataset.view)); }
      else viewsAction(vb);
      return;
    }
    closeViewsMenu();
    if (e.target.closest("#addColBtn")) return addColumn();
    if (e.target.closest("#addRowBtn")) return addRows([{}]);
    if (e.target.closest("#trashBtn")) return trashDialog();
    const card = e.target.closest("[data-card]");
    if (card) { st.card = card.dataset.card === "all" ? "" : card.dataset.card; renderCards(); return reset(); }
    if (e.target.closest("#clear")) {
      st.q = ""; st.card = ""; st.cf = {}; $("#q").value = "";
      renderCards(); drawHead();
      return reset();
    }
    if (e.target.closest("#colsBtn")) {
      // the dialog's own buttons: tick everything, untick everything, or go back to the default set
      const bulk = (ev) => {
        const b = ev.target.closest("[data-bulk]");
        if (!b) return;
        ev.preventDefault();
        for (const box of b.closest("dialog").querySelectorAll(".colgrid input[type=checkbox]")) {
          box.checked = b.dataset.bulk === "all" ? true : b.dataset.bulk === "none" ? false : !DEFAULT_HIDDEN.includes(box.name);
        }
      };
      document.addEventListener("click", bulk);
      const r = await dialog({
        title: "Columns", wide: true,
        body: `<div class="btnrow"><button type="button" class="btn small" data-bulk="all">Check all</button><button type="button" class="btn small" data-bulk="none">Uncheck all</button><button type="button" class="btn small" data-bulk="default">Reset to default</button></div>
          <div class="colgrid">${cols.map((c) => `<label class="colchk"><input type="checkbox" name="${esc(c.name)}" ${hidden.has(c.name) ? "" : "checked"}> ${esc(c.name)}</label>`).join("")}</div>`,
        actions: [["Cancel", "close"], ["Apply", "ok", "primary"]],
      });
      document.removeEventListener("click", bulk);
      if (r.value !== "ok") return;
      if (!r.el.querySelector(".colgrid input:checked")) return toast("Keep at least one column visible.", "bad");
      hidden.clear();
      r.el.querySelectorAll("input[type=checkbox]").forEach((i) => { if (!i.checked) hidden.add(i.name); });
      store.set("gt_orders_hidden", JSON.stringify([...hidden]));
      cancelEdit(); st.act = st.anc = null;
      drawHead(); paint();
    }
  };
  const applySearch = debounce(() => { st.q = $("#q").value; reset(); });
  el.oninput = (e) => { if (e.target.id === "q") applySearch(); };
  el.addEventListener("pointerdown", (e) => {
    const rz = e.target.closest("[data-rz]");
    if (!rz) return;
    e.preventDefault();
    const c = cols.find((x) => x.i === +rz.dataset.rz), x0 = e.clientX, w0 = width(c);
    const mv = (ev) => { widths[c.name] = Math.max(48, w0 + ev.clientX - x0); cancelEdit(); drawHead(); paint(); };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); store.set("gt_orders_widths", JSON.stringify(widths)); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  });

  const fit = () => { sc.style.height = Math.max(320, innerHeight - sc.getBoundingClientRect().top - 48) + "px"; paint(); };
  addEventListener("resize", fit);

  const imp = meta.imported;
  $("#synced").textContent = imp ? `Imported ${imp.file} · ${imp.at.replace("T", " ")}` : "";
  if (!meta.total) {
    $("#fbar").hidden = true;
    sc.style.display = "none";
    $(".statusbar").hidden = true;
    $(".toolbar").hidden = true;
    el.querySelector(".sheetpage").insertAdjacentHTML("beforeend", `<div class="card empty-state"><h3>No orders yet</h3><p class="muted">Download the 3PL sheet from Google Sheets (File → Download → Microsoft Excel) and upload it on the Import tab.</p><a class="btn primary" href="#import">Go to Import</a></div>`);
    return renderCards();
  }
  const v0 = activeView();
  if (v0) { st.q = v0.q; st.card = v0.card; st.cf = JSON.parse(JSON.stringify(known(v0.cf))); st.sort = v0.sort; st.dir = v0.dir; $("#q").value = v0.q; }
  renderCards(); drawHead(); fit(); reset();
}
