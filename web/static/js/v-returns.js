// Returns: the warehouse's customer returns, synced by the server from the master returns sheet.
// The warehouse edits only its own columns (Shipped to Amazon, warehouse notes); the rest comes from the sync.
import { $, ago, api, brand, debounce, dialog, easternMs, esc, fmt, store, toast } from "./util.js";
import { lockReason, lockTip, protectDialog, renameDialog } from "./protect.js";

// k: field name, kind: text | num | date | select | bool | link | img, edit: the warehouse can change it here
const COLS = [
  { k: "rid", name: "RETURN ID", kind: "text", w: 100 },
  { k: "image", name: "IMAGE", kind: "img", w: 76 },
  { k: "store", name: "STORE", kind: "text", w: 150 },
  { k: "po", name: "P.O NUMBER", kind: "text", w: 190 },
  { k: "product", name: "PRODUCT NAME", kind: "text", w: 340 },
  { k: "qty", name: "QTY", kind: "num", w: 64 },
  { k: "customer", name: "CUSTOMER NAME", kind: "text", w: 160 },
  { k: "address", name: "ADDRESS", kind: "text", w: 260 },
  { k: "return_date", name: "RETURN DATE", kind: "date", w: 130 },
  { k: "tracking", name: "TRACKING NUMBER (CX TO WAREHOUSE)", kind: "text", w: 220 },
  { k: "status_cx", name: "RETURN STATUS FROM CX TO WAREHOUSE", kind: "select", w: 210 },
  { k: "label_link", name: "RETURN LABEL LINK", kind: "link", w: 130 },
  { k: "due_date", name: "RETURN DUE DATE", kind: "date", w: 140 },
  { k: "notes", name: "NOTES", kind: "text", w: 220 },
  { k: "status_wh", name: "RETURN STATUS FROM WAREHOUSE TO AMZ", kind: "select", w: 230 },
  { k: "refunded", name: "SOURCE REFUNDED", kind: "bool", w: 130 },
  { k: "reason", name: "REASON", kind: "text", w: 200 },
  { k: "shipped", name: "SHIPPED TO AMAZON", kind: "bool", w: 150 },
  { k: "processed_at", name: "PROCESSED DATE/TIME", kind: "date", w: 170 },
  { k: "processed_by", name: "PROCESSED BY", kind: "text", w: 140 },
  { k: "wh_notes", name: "WAREHOUSE NOTES", kind: "text", w: 240 },
];
const PILL = { DELIVERED: "s-ok", "PENDING RETURN": "s-warn", "IN TRANSIT": "s-info" };
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const INTERVAL_LABEL = { 0: "Never (only when I press Sync now)", 5: "Every 5 minutes", 10: "Every 10 minutes", 15: "Every 15 minutes", 30: "Every 30 minutes",
  60: "Every hour", 180: "Every 3 hours", 360: "Every 6 hours", 720: "Every 12 hours", 1440: "Once a day" };
const COND = {
  text: [["contains", "Text contains"], ["notcontains", "Text does not contain"], ["eq", "Text is exactly"], ["starts", "Text starts with"], ["ends", "Text ends with"], ["empty", "Is empty"], ["notempty", "Is not empty"]],
  num: [["eq", "Equal to"], ["neq", "Not equal to"], ["gt", "Greater than"], ["gte", "Greater than or equal to"], ["lt", "Less than"], ["lte", "Less than or equal to"], ["between", "Is between"], ["empty", "Is empty"], ["notempty", "Is not empty"]],
  date: [["eq", "Date is"], ["lt", "Date is before"], ["gt", "Date is after"], ["between", "Date is between"], ["empty", "Is empty"], ["notempty", "Is not empty"]],
};

const showDate = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(v || "");
  if (!m) return v || "";
  let s = `${MONTH[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
  if (m[4]) s += ` ${+m[4] % 12 || 12}:${m[5]} ${+m[4] >= 12 ? "PM" : "AM"}`;
  return s;
};
const isUrl = (v) => /^https?:\/\//.test(v || "");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const readJson = (k, fallback) => { try { return JSON.parse(store.get(k, "") || "null") ?? fallback; } catch { return fallback; } };

const CARDS = [
  { key: "all", label: "All returns", hint: "Not removed from the master sheet", tone: "neutral", fn: () => true },
  { key: "todo", label: "Not shipped to Amazon", hint: "Still to be processed", tone: "warn", fn: (r) => r.shipped !== "TRUE" },
  { key: "overdue", label: "Overdue", hint: "Past the due date, not shipped", tone: "crit", fn: (r) => r.shipped !== "TRUE" && r.due_date && r.due_date.slice(0, 10) < today() },
  { key: "pending", label: "Pending return", hint: "Customer has not sent it yet", tone: "violet", fn: (r) => r.status_cx === "PENDING RETURN" },
  { key: "transit", label: "In transit to us", hint: "Customer → warehouse", tone: "info", fn: (r) => r.status_cx === "IN TRANSIT" },
  { key: "arrived", label: "Delivered to warehouse", hint: "Arrived from the customer", tone: "ok", fn: (r) => r.status_cx === "DELIVERED" },
  { key: "shipped", label: "Shipped to Amazon", hint: "Done", tone: "ok", fn: (r) => r.shipped === "TRUE" },
  { key: "refunded", label: "Source refunded", hint: "Refund ticked in the master sheet", tone: "neutral", fn: (r) => r.refunded === "TRUE" },
  { key: "removed", label: "Removed from the master", hint: "No longer listed there", tone: "neutral", fn: () => true, onlyRemoved: true },
];

export async function mount(el, params, ctx) {
  let data = await api("/api/returns");
  const applyLabels = () => { for (const c of COLS) { c.orig ??= c.name; c.name = data.labels?.[c.k] || c.orig; } }; // admins can rename columns
  applyLabels();
  const hidden = new Set(readJson("gt_returns_hidden", []));
  const st = { q: "", card: "all", cf: {}, sort: null };
  let editing = null; // the warehouse-notes cell being typed in
  let fm = null; // the open filter menu
  const colOf = (k) => COLS.find((c) => c.k === k);
  const visible = () => COLS.filter((c) => !hidden.has(c.k));
  const valueOf = (r, c) => (c.k === "image" ? r.image || "" : r[c.k] ?? "");

  el.innerHTML = `<div class="section-head"><div><div class="eyebrow">${esc(brand.name)}</div><h2>Returns</h2>
      <p>Customer returns for this warehouse. They are read from the master returns sheet; tick <b>Shipped to Amazon</b> when you send one back.</p></div></div>
    <div class="panel syncbar" id="syncbar"></div>
    <div class="qgrid cards" id="cards"></div>
    <div class="toolbar sheetbar">
      <div class="searchbox"><input id="q" type="search" placeholder="Search return ID, P.O, product, customer, tracking…" autocomplete="off"></div>
      <span class="sep"></span><button class="btn small" id="clear">Clear filters</button>
      <button class="btn small" id="colsBtn">Columns ▾</button>
      <span class="muted" id="count"></span>
    </div>
    <div class="rwrap" id="rwrap"><table class="rt" id="rt"></table></div>`;
  const wrap = $("#rwrap");

  // ---------- what is shown
  const live = () => data.rows.filter((r) => !r.removed);
  const cardRows = (key) => {
    const card = CARDS.find((c) => c.key === key);
    return card.onlyRemoved ? data.rows.filter((r) => r.removed) : live().filter(card.fn);
  };
  const nFilters = () => Object.values(st.cf).filter((f) => f.c || f.v).length;

  function passes(r, c, f) {
    const v = valueOf(r, c);
    if (f.c && f.c.op && !condTest(c.kind, f.c, v)) return false;
    if (f.v) {
      const inList = f.v.list.includes(v);
      if (f.v.mode === "in" ? !inList : inList) return false;
    }
    return true;
  }
  function condTest(kind, c, raw) {
    const { op } = c, a = (c.a || "").trim(), b = (c.b || "").trim();
    if (op === "empty") return raw === "";
    if (op === "notempty") return raw !== "";
    if (kind === "num") {
      const x = parseFloat(String(raw).replace(/,/g, "")), A = parseFloat(a), B = parseFloat(b);
      if (Number.isNaN(x)) return false;
      return { eq: x === A, neq: x !== A, gt: x > A, gte: x >= A, lt: x < A, lte: x <= A, between: x >= Math.min(A, B) && x <= Math.max(A, B) }[op];
    }
    if (kind === "date") {
      const d = String(raw).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
      return { eq: d === a, lt: d < a, gt: d > a, between: d >= (a < b ? a : b) && d <= (a < b ? b : a) }[op];
    }
    const t = String(raw).toLowerCase(), s = a.toLowerCase();
    return { contains: t.includes(s), notcontains: !t.includes(s), eq: t === s, starts: t.startsWith(s), ends: t.endsWith(s) }[op];
  }
  function matches(r, skip) {
    if (st.q) {
      const hay = `${r.rid} ${r.po} ${r.product} ${r.customer} ${r.tracking} ${r.store} ${r.address} ${r.notes} ${r.reason} ${r.wh_notes}`.toLowerCase();
      if (!st.q.toLowerCase().split(/\s+/).every((t) => hay.includes(t))) return false;
    }
    for (const [k, f] of Object.entries(st.cf)) if (k !== skip && !passes(r, colOf(k), f)) return false;
    return true;
  }
  function compare(a, b, c) {
    const x = valueOf(a, c), y = valueOf(b, c);
    if (x === "" || y === "") return x === y ? 0 : x === "" ? 1 : -1; // blanks last
    const r = c.kind === "num" ? parseFloat(x) - parseFloat(y) : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
    return st.sort.dir === "desc" ? -r : r;
  }
  const shownRows = () => {
    let rows = cardRows(st.card).filter((r) => matches(r));
    if (st.sort) { const c = colOf(st.sort.k); rows = [...rows].sort((a, b) => compare(a, b, c)); }
    return rows;
  };

  // ---------- drawing
  function renderCards() {
    $("#cards").innerHTML = CARDS.filter((c) => c.key !== "removed" || data.rows.some((r) => r.removed)).map((c) => {
      const n = cardRows(c.key).length;
      return `<button class="qcard ${c.tone} ${st.card === c.key ? "on" : ""} ${n ? "" : "zero"}" data-card="${c.key}"><span class="qn">${fmt(n)}</span><span class="ql">${esc(c.label)}</span><span class="qd">${esc(c.hint)}</span></button>`;
    }).join("");
  }

  // every column can be typed in except the ID and the picture; typing over a master-sheet column is remembered apart,
  // so the next sync still updates the master value underneath and your text stays on top until you revert it
  const editable = (c) => !["rid", "image", "label_link"].includes(c.k);
  const why = (c, rid) => lockReason(data.locks?.defs?.[data.locks?.cols?.[c.k]], ctx.me, "column") || lockReason(data.locks?.defs?.[data.locks?.rows?.[rid]], ctx.me, "row");

  function cell(r, c) {
    const v = valueOf(r, c), w = `min-width:${c.w}px;max-width:${c.w}px`;
    let h = "", cls = c.k === "rid" ? "pinc" : "";
    const blocked = why(c, r.rid), typed = c.k in (r.overridden || {});
    if (blocked) cls += " locked";
    if (typed) cls += " ovr";
    if (c.kind === "bool") {
      h = `<input type="checkbox" class="cbx" data-tick="${esc(r.rid)}" data-k="${c.k}" ${v === "TRUE" ? "checked" : ""} ${blocked ? "disabled" : ""} title="${esc(blocked)}">`;
      cls += " ctr";
    } else if (!v) h = editable(c) && !blocked ? `<span class="muted edit-hint">${c.k === "wh_notes" ? "click to add a note" : "click to type"}</span>` : "";
    else if (c.kind === "date") {
      h = esc(showDate(v));
      if (c.k === "due_date" && r.shipped !== "TRUE" && v.slice(0, 10) < today()) cls += " late";
    } else if (c.kind === "select") h = `<span class="pill ${PILL[v] || "s-neutral"}">${esc(v)}</span>`;
    else if (c.kind === "link") h = isUrl(v) ? `<a href="${esc(v)}" target="_blank" rel="noopener">Open label</a>` : esc(v);
    else if (c.kind === "img") h = isUrl(v) ? `<img class="thumb" data-img="${esc(r.rid)}" loading="lazy" referrerpolicy="no-referrer" src="${esc(v)}" alt="">` : "";
    else if (c.kind === "num") { h = esc(v); cls += " r"; } else h = esc(v);
    if (editable(c) && c.kind !== "bool" && !blocked) cls += " editable";
    const tip = typed ? `You typed over the master sheet's value (${r.overridden[c.k] || "blank"}). Right-click to put it back.` : blocked || (c.kind === "text" && v ? v : "");
    return `<td class="${cls}" style="${w}" ${tip ? `title="${esc(tip)}"` : ""} data-k="${c.k}" ${editable(c) && c.kind !== "bool" ? `data-note="${esc(r.rid)}"` : ""}>${h}</td>`;
  }

  function draw() {
    closeFilterMenu();
    const cols = visible(), rows = shownRows();
    const head = cols.map((c) => {
      const f = st.cf[c.k], on = !!(f && (f.c || f.v)), sorted = st.sort?.k === c.k, filterable = !["img", "link"].includes(c.kind);
      return `<th class="${c.k === "rid" ? "pinc" : ""}${on ? " filtered" : ""}" style="min-width:${c.w}px;max-width:${c.w}px"><div class="th-in"><span class="hl" title="${esc(data.locks?.cols?.[c.k] ? `${c.name}. ${lockTip(data.locks.defs[data.locks.cols[c.k]])}` : c.name)}">${data.locks?.cols?.[c.k] ? "🔒 " : ""}${esc(c.name)}</span>${sorted ? `<span class="hs">${st.sort.dir === "asc" ? "▲" : "▼"}</span>` : ""}
        ${filterable ? `<button class="fb${on ? " on" : ""}" data-fb="${c.k}" title="Sort and filter" aria-label="Sort and filter ${esc(c.name)}"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.5 2.5h13l-5 6v5l-3-1.8V8.5z" fill="currentColor"/></svg></button>` : ""}</div></th>`;
    }).join("");
    const shown = rows.slice(0, 2000);
    $("#rt").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${shown.map((r) => `<tr class="${r.removed ? "gone" : ""}" data-rid="${esc(r.rid)}">${cols.map((c) => cell(r, c)).join("")}</tr>`).join("") || `<tr><td class="empty-row" colspan="${cols.length}">${data.rows.length ? "No returns match these filters." : "No returns yet. Press Sync now to read the master returns sheet."}</td></tr>`}</tbody>`;
    $("#count").textContent = `${fmt(rows.length)} return${rows.length === 1 ? "" : "s"}${nFilters() ? ` · ${nFilters()} column filter${nFilters() === 1 ? "" : "s"}` : ""}${rows.length > 2000 ? " (first 2,000 shown)" : ""}`;
    wrap.classList.toggle("emptytable", !rows.length);
    renderCards();
  }

  function renderSync() {
    const { status } = data, last = status.last, ok = status.last_ok, cfg = status.settings;
    let line = `<span class="dotstate ${last && last.ok ? "running" : last ? "offline" : ""}"></span>`;
    if (!last) line += `<b>Not synced yet.</b> <span class="muted">Press Sync now to read the master returns sheet${cfg.interval_min ? ", or wait a moment for the first automatic sync" : ""}.</span>`;
    else if (last.ok) line += `<b>Synced ${esc(ago(last.at))}</b> <span class="muted">from the master returns sheet (${esc(cfg.warehouse)}) · ${fmt(last.read)} returns read${last.added || last.updated || last.removed ? ` · ${last.added} new, ${last.updated} changed, ${last.removed} removed` : ""}.</span>`;
    else line += `<b class="crit-text">The last sync failed ${esc(ago(last.at))}:</b> ${esc(last.message)} <span class="muted">${ok ? `Showing the data from ${esc(ago(ok.at))}.` : ""}</span>`;
    const next = cfg.interval_min && last ? easternMs(last.at) + cfg.interval_min * 60000 : null;
    $("#syncbar").innerHTML = `<div class="syncline">${line}${cfg.interval_min ? ` <span class="muted">· ${esc(INTERVAL_LABEL[cfg.interval_min].toLowerCase())}${next ? `, next about ${new Date(Math.max(next, Date.now())).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</span>` : ` <span class="muted">· automatic sync is off</span>`}</div>
      <div class="btnrow"><button class="btn" id="syncNow">Sync now</button>${ctx.isAdmin() ? `<button class="btn" id="syncSet">Sync settings</button>` : ""}</div>`;
  }

  // ---------- filter menu (sort, condition, values), the same as in All Orders but over the rows in memory
  function closeFilterMenu() {
    if (!fm) return;
    document.removeEventListener("mousedown", fm.outside, true);
    fm.el.remove();
    fm = null;
  }
  function openFilterMenu(c, anchor) {
    closeFilterMenu();
    const cur = st.cf[c.k] || {};
    const draft = { c: cur.c ? { ...cur.c } : null, mode: cur.v ? cur.v.mode : "out", set: new Set(cur.v ? cur.v.list : []) };
    const condKind = c.kind === "num" ? "num" : c.kind === "date" ? "date" : "text", inputType = condKind === "date" ? "date" : "text";
    const sorted = st.sort?.k === c.k;
    const menu = document.createElement("div");
    menu.className = "fmenu";
    menu.innerHTML = `<div class="fm-title">${esc(c.name)}</div>
      <button type="button" class="fm-item${sorted && st.sort.dir === "asc" ? " on" : ""}" data-sort="asc">Sort A → Z</button>
      <button type="button" class="fm-item${sorted && st.sort.dir === "desc" ? " on" : ""}" data-sort="desc">Sort Z → A</button>
      ${sorted ? `<button type="button" class="fm-item" data-sort="none">Remove sort</button>` : ""}<hr>
      ${ctx.isAdmin() ? `<button type="button" class="fm-item" data-protectcol>🔒 ${data.locks?.cols?.[c.k] ? "Change protection…" : "Protect this column…"}</button><hr>` : ""}
      ${c.kind === "bool" ? "" : `<div class="fm-sec"><div class="fm-h">Filter by condition</div>
        <select class="fc-op"><option value="">None</option>${COND[condKind].map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
        <input class="fc-a" type="${inputType}" autocomplete="off"><input class="fc-b" type="${inputType}" autocomplete="off"></div><hr>`}
      <div class="fm-sec"><div class="fm-h">Filter by values</div>
        <input class="fv-search" type="search" placeholder="Search values…" autocomplete="off">
        <div class="fv-bar"><button type="button" data-fv="all">Select all</button><button type="button" data-fv="none">Clear</button><span class="muted fv-count"></span></div>
        <div class="fv-list"></div></div>
      <div class="fm-foot"><button type="button" class="btn small" data-fm="clear">Clear filter</button><span class="grow"></span><button type="button" class="btn small" data-fm="cancel">Cancel</button><button type="button" class="btn small primary" data-fm="ok">OK</button></div>`;
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)) + "px";
    menu.style.top = r.bottom + 4 + "px";
    menu.style.maxHeight = Math.max(260, innerHeight - r.bottom - 16) + "px";
    fm = { el: menu, col: c.k, outside: (e) => { if (!menu.contains(e.target) && !e.target.closest("[data-fb]")) closeFilterMenu(); } };
    document.addEventListener("mousedown", fm.outside, true);

    const op = menu.querySelector(".fc-op"), ca = menu.querySelector(".fc-a"), cb = menu.querySelector(".fc-b");
    const syncCond = () => { if (!op) return; ca.hidden = !op.value || ["empty", "notempty"].includes(op.value); cb.hidden = op.value !== "between"; };
    if (op) { op.value = draft.c?.op || ""; ca.value = draft.c?.a || ""; cb.value = draft.c?.b || ""; syncCond(); op.onchange = () => { syncCond(); if (!ca.hidden) ca.focus(); }; }

    // the values still on offer: those of the rows the OTHER filters leave visible, with how many rows have each
    const counts = new Map();
    for (const row of cardRows(st.card)) if (matches(row, c.k)) { const v = valueOf(row, c); counts.set(v, (counts.get(v) || 0) + 1); }
    const all = [...counts.keys()].sort((x, y) => (x === "" ? -1 : y === "" ? 1 : c.kind === "num" ? parseFloat(x) - parseFloat(y) : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" })));
    const search = menu.querySelector(".fv-search"), listEl = menu.querySelector(".fv-list"), countEl = menu.querySelector(".fv-count");
    const label = (v) => (v === "" ? "(Blanks)" : c.kind === "date" ? showDate(v) : c.kind === "bool" ? (v === "TRUE" ? "Checked" : "Unchecked") : v);
    const checked = (v) => (draft.mode === "out" ? !draft.set.has(v) : draft.set.has(v));
    let shown = [];
    const drawValues = () => {
      const s = search.value.trim().toLowerCase();
      shown = all.filter((v) => !s || label(v).toLowerCase().includes(s));
      const part = shown.slice(0, 500);
      listEl.innerHTML = part.map((v, n) => `<label class="fv-row"><input type="checkbox" data-n="${n}" ${checked(v) ? "checked" : ""}><span class="fv-t">${esc(label(v))}</span><span class="muted fv-n">${fmt(counts.get(v))}</span></label>`).join("")
        || `<div class="muted fv-note">No matching values</div>`;
      if (shown.length > 500) listEl.insertAdjacentHTML("beforeend", `<div class="muted fv-note">Showing the first 500 values. Search to find others.</div>`);
      countEl.textContent = shown.length ? `${fmt(shown.filter(checked).length)} of ${fmt(shown.length)} selected` : "";
    };
    search.oninput = debounce(drawValues, 150);
    menu.addEventListener("change", (e) => {
      const box = e.target.closest(".fv-row input");
      if (!box) return;
      const v = shown[+box.dataset.n];
      if ((draft.mode === "out") === box.checked) draft.set.delete(v); else draft.set.add(v);
      drawValues();
    });
    drawValues();

    const finish = () => { closeFilterMenu(); draw(); };
    const apply = () => {
      let cond = null;
      if (op && op.value) {
        const a = ca.value.trim(), b = cb.value.trim(), need = !["empty", "notempty"].includes(op.value);
        if (need && !a) return toast("Enter a value for the condition.", "bad");
        if (need && condKind === "num" && Number.isNaN(parseFloat(a))) return toast("This column only takes numbers.", "bad");
        if (op.value === "between" && (!b || (condKind === "num" && Number.isNaN(parseFloat(b))))) return toast("Enter the second value too.", "bad");
        cond = { op: op.value, a: need ? a : "", b: op.value === "between" ? b : "" };
      }
      const vals = draft.mode === "out" && !draft.set.size ? null : { mode: draft.mode, list: [...draft.set] };
      if (cond || vals) st.cf[c.k] = { c: cond, v: vals }; else delete st.cf[c.k];
      finish();
    };
    menu.addEventListener("click", (e) => {
      const so = e.target.closest("[data-sort]"), fv = e.target.closest("[data-fv]"), fb = e.target.closest("[data-fm]");
      if (e.target.closest("[data-protectcol]")) {
        closeFilterMenu();
        protectDialog({ sheet: "returns", kind: "col", targets: [c.k], what: `the column "${c.name}"`, current: data.locks?.defs?.[data.locks?.cols?.[c.k]] }).then((ok) => ok && reload());
        return;
      }
      if (so) { st.sort = so.dataset.sort === "none" ? null : { k: c.k, dir: so.dataset.sort }; finish(); }
      else if (fv) {
        const searching = !!search.value.trim();
        if (fv.dataset.fv === "all") { if (!searching) { draft.mode = "out"; draft.set.clear(); } else shown.forEach((v) => (draft.mode === "out" ? draft.set.delete(v) : draft.set.add(v))); }
        else if (!searching) { draft.mode = "in"; draft.set.clear(); } else shown.forEach((v) => (draft.mode === "out" ? draft.set.add(v) : draft.set.delete(v)));
        drawValues();
      } else if (fb) {
        if (fb.dataset.fm === "ok") apply(); else if (fb.dataset.fm === "clear") { delete st.cf[c.k]; finish(); } else closeFilterMenu();
      }
    });
    menu.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); closeFilterMenu(); }
      else if (e.key === "Enter" && e.target.matches(".fc-a, .fc-b")) { e.preventDefault(); apply(); }
    });
    (op && !ca.hidden ? ca : search).focus();
  }

  // ---------- editing the warehouse's own columns
  async function save(rid, field, value, revert = false) {
    const row = data.rows.find((r) => r.rid === rid);
    try {
      const out = await api("/api/returns/edit", { rid, field, value, revert }); // the server records the signed-in person
      Object.assign(row, out.row, { image: row.image });
      knownV = out.v;
    } catch (e) { toast(e.message, "bad"); }
    draw();
  }
  function editNote(td) {
    const rid = td.dataset.note, field = td.dataset.k, c = colOf(field), row = data.rows.find((r) => r.rid === rid);
    if (editing) return;
    const blocked = why(c, rid);
    if (blocked) return toast(blocked, "bad");
    editing = rid;
    const shown = c.kind === "date" ? showDate(row[field]) : row[field] || "";
    td.innerHTML = `<input class="cell-input" maxlength="2000" value="${esc(shown)}">`;
    const input = td.querySelector("input");
    input.focus();
    input.select();
    const done = async (commit) => {
      if (editing !== rid) return;
      editing = null;
      if (commit && input.value.trim() !== shown) await save(rid, field, input.value);
      else draw();
    };
    input.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") done(false); };
    input.onblur = () => done(true);
  }

  // ---------- events
  el.onclick = async (e) => {
    const t = e.target;
    const fb = t.closest("[data-fb]");
    if (fb) { const c = colOf(fb.dataset.fb); if (fm && fm.col === c.k) closeFilterMenu(); else openFilterMenu(c, fb); return; }
    const card = t.closest("[data-card]");
    if (card) { st.card = card.dataset.card; return draw(); }
    if (t.closest("#clear")) { st.q = ""; st.card = "all"; st.cf = {}; st.sort = null; $("#q").value = ""; return draw(); }
    const img = t.closest("[data-img]");
    if (img) {
      const row = data.rows.find((r) => r.rid === img.dataset.img);
      await dialog({ title: row.product, wide: true, body: `<img alt="" referrerpolicy="no-referrer" src="${esc(row.image)}" style="max-width:100%;max-height:70vh;display:block;margin:0 auto;background:#fff;border-radius:8px">`, actions: [["Close", "close"]] });
      return;
    }
    const note = t.closest("[data-note]");
    if (note && !t.closest("input")) return editNote(note);
    if (t.closest("#syncNow")) {
      const b = $("#syncNow"); b.disabled = true; b.textContent = "Syncing…";
      try { const out = await api("/api/returns/sync", {}); data.status = out.status; toast(`Synced: ${out.read} returns read, ${out.added} new, ${out.updated} changed.`); await reload(); }
      catch (err) { toast(err.message, "bad"); await reload(); }
      return;
    }
    if (t.closest("#syncSet")) return settingsDialog();
    if (t.closest("#colsBtn")) return columnsDialog();
  };
  el.onchange = (e) => {
    const box = e.target.closest("[data-tick]");
    if (box) save(box.dataset.tick, box.dataset.k, box.checked);
  };
  // right-click a cell: put a typed-over value back, or (admins) protect the column or the return
  el.oncontextmenu = (e) => {
    const th = e.target.closest("th"), fbk = th?.querySelector("[data-fb]")?.dataset.fb;
    const td = e.target.closest("td[data-k]"), tr = e.target.closest("tr[data-rid]");
    if (!(td && tr) && !(fbk && ctx.isAdmin())) return;
    const rid = tr ? tr.dataset.rid : "", c = colOf(td ? td.dataset.k : fbk), row = tr ? data.rows.find((r) => r.rid === rid) : null;
    const items = [];
    if (row && c.k in (row.overridden || {})) items.push(`<button data-ctx="revert">↶ Put back the master sheet's value</button>`);
    if (ctx.isAdmin()) {
      items.push(`<button data-ctx="rename">✏️ Rename this column…</button>`, `<button data-ctx="pcol">🔒 ${data.locks?.cols?.[c.k] ? "Change protection of" : "Protect"} this column…</button>`);
      if (row) items.push(`<button data-ctx="prow">🔒 ${data.locks?.rows?.[rid] ? "Change protection of" : "Protect"} this return…</button>`);
    }
    if (!items.length) return;
    e.preventDefault();
    document.querySelector(".ctxmenu")?.remove();
    const m = document.createElement("div");
    m.className = "menu ctxmenu";
    m.style.cssText = `position:fixed;left:${Math.min(e.clientX, innerWidth - 290)}px;top:${Math.min(e.clientY + 4, innerHeight - 140)}px;min-width:260px;z-index:70`;
    m.innerHTML = `<div class="mhead">${rid ? esc(rid) + " · " : ""}${esc(c.name)}</div>${items.join("")}`;
    document.body.append(m);
    const close = (ev) => { if (!m.contains(ev.target)) { m.remove(); document.removeEventListener("mousedown", close, true); } };
    setTimeout(() => document.addEventListener("mousedown", close, true), 0);
    m.addEventListener("click", async (ev) => {
      const b = ev.target.closest("[data-ctx]");
      if (!b) return;
      m.remove();
      document.removeEventListener("mousedown", close, true);
      if (b.dataset.ctx === "revert") save(rid, c.k, null, true);
      else if (b.dataset.ctx === "rename") {
        const label = await renameDialog(c.name, c.orig);
        if (label === null) return;
        try { await api("/api/returns/labels", { k: c.k, label }); await reload(); toast(label ? `Renamed to "${label}".` : "Name put back."); } catch (err) { toast(err.message, "bad"); }
      }
      else if (b.dataset.ctx === "pcol") { if (await protectDialog({ sheet: "returns", kind: "col", targets: [c.k], what: `the column "${c.name}"`, current: data.locks?.defs?.[data.locks?.cols?.[c.k]] })) reload(); }
      else if (await protectDialog({ sheet: "returns", kind: "row", targets: [rid], what: `the return ${rid}`, current: data.locks?.defs?.[data.locks?.rows?.[rid]] })) reload();
    });
  };
  el.oninput = (e) => { if (e.target.id === "q") applySearch(); };
  const applySearch = debounce(() => { st.q = $("#q").value.trim(); draw(); }, 200);

  async function columnsDialog() {
    const bulk = (ev) => {
      const b = ev.target.closest("[data-bulk]");
      if (!b) return;
      ev.preventDefault();
      b.closest("dialog").querySelectorAll(".colgrid input[type=checkbox]").forEach((x) => { x.checked = b.dataset.bulk === "all"; });
    };
    document.addEventListener("click", bulk);
    const r = await dialog({
      title: "Columns", wide: true,
      body: `<div class="btnrow"><button type="button" class="btn small" data-bulk="all">Check all</button><button type="button" class="btn small" data-bulk="none">Uncheck all</button></div>
        <div class="colgrid">${COLS.map((c) => `<label class="colchk"><input type="checkbox" name="${c.k}" ${hidden.has(c.k) ? "" : "checked"}> ${esc(c.name)}</label>`).join("")}</div>`,
      actions: [["Cancel", "close"], ["Apply", "ok", "primary"]],
    });
    document.removeEventListener("click", bulk);
    if (r.value !== "ok") return;
    if (!r.el.querySelector(".colgrid input:checked")) return toast("Keep at least one column visible.", "bad");
    hidden.clear();
    r.el.querySelectorAll(".colgrid input").forEach((x) => { if (!x.checked) hidden.add(x.name); });
    store.set("gt_returns_hidden", JSON.stringify([...hidden]));
    draw();
  }

  async function settingsDialog() {
    const s = data.status.settings;
    const logRows = data.status.log.map((l) => `<tr><td>${esc(l.at)}</td><td>${l.trigger === "auto" ? "timer" : "button"}</td><td>${l.ok ? `<span class="pill s-ok">OK</span>` : `<span class="pill s-crit">Failed</span>`}</td><td class="muted">${l.ok ? `${l.read} read · ${l.added} new · ${l.updated} changed · ${l.removed} removed` : esc(l.message)}</td></tr>`).join("");
    const r = await dialog({
      title: "Sync settings", wide: true,
      body: `<p class="muted" style="margin:0 0 10px">The app reads the master returns sheet by itself and keeps only this warehouse's rows. What you tick or type here (Shipped to Amazon, processed by, notes) is never overwritten by a sync.</p>
        <div class="formgrid">
          <label class="field"><span>Master returns sheet (Google Sheets link)</span><input name="source_url" value="${esc(s.source_url)}"></label>
          <label class="field"><span>Tab name</span><input name="source_tab" value="${esc(s.source_tab)}"></label>
          <label class="field"><span>Keep the rows whose first column says</span><input name="warehouse" value="${esc(s.warehouse)}"></label>
          <label class="field"><span>Sync automatically</span><select name="interval_min">${Object.entries(INTERVAL_LABEL).map(([m, l]) => `<option value="${m}" ${+m === s.interval_min ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        </div>
        <details style="margin-top:12px"><summary class="muted">Starting point (used once, the first time, to copy the progress already in the 3PL sheet)</summary>
          <div class="formgrid" style="margin-top:8px"><label class="field"><span>3PL sheet link</span><input name="seed_url" value="${esc(s.seed_url)}"></label>
          <label class="field"><span>Its returns tab</span><input name="seed_tab" value="${esc(s.seed_tab)}"></label></div></details>
        <p class="hint">Both sheets must be shared as "Anyone with the link can view". Anyone using the app can change these settings.</p>
        <h3 style="margin:14px 0 6px">Recent syncs</h3>
        <div class="tablewrap" style="max-height:200px"><table style="min-width:0"><tbody>${logRows || `<tr><td class="muted">No syncs yet.</td></tr>`}</tbody></table></div>`,
      actions: [["Cancel", "close"], ["Save settings", "ok", "primary"]],
    });
    if (r.value !== "ok") return;
    const f = new FormData(r.el.querySelector("form")), body = Object.fromEntries(f.entries());
    body.interval_min = +body.interval_min;
    try { await api("/api/returns/settings", body); toast("Saved the sync settings."); await reload(); }
    catch (err) { toast(err.message, "bad"); }
  }

  // ---------- keep current: reload when the data changed (a sync, or another person ticking a return)
  let knownV = null;
  async function reload() {
    data = await api("/api/returns");
    applyLabels();
    renderSync(); draw();
  }
  async function poll() {
    if (!el.isConnected || location.hash !== "#returns") return clearInterval(timer);
    if (document.hidden || editing || fm) return;
    try {
      const { v } = await api("/api/version");
      if (knownV === null) knownV = v;
      else if (v !== knownV) { knownV = v; await reload(); }
      else renderSync(); // keeps "synced 5 min ago" fresh
    } catch { /* offline for a moment */ }
  }
  const timer = setInterval(poll, 2000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  addEventListener("resize", fit);
  function fit() { wrap.style.maxHeight = Math.max(320, innerHeight - wrap.getBoundingClientRect().top - 30) + "px"; }

  renderSync(); draw(); fit();
}
