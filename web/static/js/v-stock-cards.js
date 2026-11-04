// Order Cards, Stocks side: the packages that stayed in the warehouse as stock.
// Two sources, shown together as cards: the orders of All Orders whose Stock box is ticked, and every row of Kohl's Returns.
import { $, api, brand, debounce, dialog, esc, fmt, toast } from "./util.js";
import { cardTabs } from "./card-tabs.js";
import { labelPages, printPages } from "./print.js";

const PAGE = 48;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const showDate = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(v || "");
  if (!m) return v || "";
  return `${MONTH[+m[2] - 1]} ${+m[3]}, ${m[1]}${m[4] ? ` ${+m[4] % 12 || 12}:${m[5]} ${+m[4] >= 12 ? "PM" : "AM"}` : ""}`;
};
const isUrl = (v) => /^https?:\/\//.test(v || "");
const DRIVE = /\/d\/[-\w]{25,}/;
const BOOLS = ["Shipped to Customer", "Shipped to Amazon", "ITEM ON HOLD", "Label Used", "Stock"];
const yesNo = (v) => (v === "TRUE" ? "Yes" : v === "FALSE" ? "No" : v === "" ? "(blank)" : v);

// the filters above the cards: [title, key]. A Kohl's row has only a store, so the others leave it out while they are set.
const FILTERS = [["Store", "store"], ["Source Order Status", "ostatus"], ["Shipped to Customer", "toCustomer"], ["Shipped to Amazon", "toAmazon"], ["Tracking Status", "tracking"]];
const BOOL_FILTERS = ["toCustomer", "toAmazon"];

export async function mount(el, params, ctx) {
  const meta = await api("/api/meta");
  const cols = meta.columns;
  const byKey = Object.fromEntries(cols.map((c) => [c.key, c]));
  const idx = (key) => byKey[key]?.i;
  const label = (key) => byKey[key]?.name || key;
  const val = (r, key) => (byKey[key] ? r[byKey[key].i + 1] || "" : "");

  const st = { q: "", flt: {} };
  let items = [], shown = PAGE, menu = null, knownV = null;
  let kohlsRows = []; // the Kohl's rows, as the server sends them

  el.innerHTML = `<div class="section-head"><div><div class="eyebrow">${esc(brand.name)}</div><h2>Order Cards</h2></div>
      <div class="cardtabs">${cardTabs("stock")}</div></div>
    <div class="panel cardtotal"><span>STOCKS TOTAL CARDS:</span><b id="cardCount"></b></div>
    <div class="cardbar"><div class="cardfilters" id="cardFilters"></div>
      <input type="search" id="cardSearch" class="cardsearch" placeholder="Search" autocomplete="off"></div>
    <div class="cardgrid" id="cardGrid"></div>
    <div class="cardmore" id="cardMore"></div>`;

  // ---------- the two sources, as one list
  const stockNo = (it) => (it.kind === "order" ? val(it.r, "STOCK NO.") : it.r.stock_no || "");
  const facts = (it) => (it.kind === "order"
    ? { store: val(it.r, "Store"), ostatus: val(it.r, "Source Order Status"), toCustomer: val(it.r, "Shipped to Customer") || "FALSE", toAmazon: val(it.r, "Shipped to Amazon") || "FALSE", tracking: val(it.r, "Tracking Status") }
    : { store: it.r.store || "", ostatus: "", toCustomer: it.r.used === "TRUE" ? "TRUE" : "FALSE", toAmazon: "", tracking: "" }); // a Kohl's row keeps Shipped to Customer in its "used" field
  const hay = (it) => (it.kind === "order"
    ? ["Label Number", "Store Order No.", "Product Name", "Customer Name", "Brand", "SKU", "STOCK NO.", "Source Order Number", "Tracking Number To Customer", "Source Tracking Number", "Notes", "Store"].map((k) => val(it.r, k)).join(" ")
    : [it.r.store, it.r.stock_no, it.r.sku, it.r.order_number, it.r.product, it.r.notes].join(" ")).toLowerCase();

  const numberOf = (it) => { const n = parseInt(stockNo(it), 10); return Number.isNaN(n) ? -1 : n; };

  async function loadAll() {
    const flt = { [idx("Stock")]: { v: { mode: "in", list: ["TRUE"] } } };
    let rows = [], total = 0;
    do {
      const out = await api("/api/orders", { q: "", flt, sort: "rn", dir: "desc", offset: rows.length, limit: 500 });
      total = out.total;
      rows = rows.concat(out.rows);
      if (!out.rows.length) break;
    } while (rows.length < total);
    kohlsRows = (await api("/api/kohls")).rows;
    items = [...rows.map((r) => ({ kind: "order", r })), ...kohlsRows.map((r) => ({ kind: "kohls", r }))];
    items.sort((a, b) => numberOf(b) - numberOf(a)); // the highest stock number first
  }

  const matching = (skip) => {
    const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    return items.filter((it) => {
      const f = facts(it);
      for (const [k, list] of Object.entries(st.flt)) if (k !== skip && list.length && !list.includes(f[k])) return false;
      return !words.length || words.every((w) => hay(it).includes(w));
    });
  };

  // ---------- filters
  const activeCount = () => Object.values(st.flt).filter((l) => l.length).length;
  function drawFilters() {
    $("#cardFilters").innerHTML = FILTERS.map(([t, k]) => {
      const n = st.flt[k]?.length || 0;
      return `<button class="cardfilter${n ? " on" : ""}" data-filter="${k}"><span>${esc(t)}</span>${n ? `<b class="cfcount">${n}</b>` : ""}<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    }).join("") + (activeCount() || st.q ? `<button class="cardclear" id="clearFilters">Clear all</button>` : "");
  }
  function closeMenu() {
    if (!menu) return;
    document.removeEventListener("mousedown", menu.outside, true);
    menu.el.remove();
    menu = null;
  }
  function openMenu(k, anchor) {
    const counts = new Map();
    for (const it of matching(k)) { const v = facts(it)[k]; counts.set(v, (counts.get(v) || 0) + 1); }
    const list = [...counts].sort((a, b) => a[0].localeCompare(b[0]));
    const chosen = new Set(st.flt[k] || []);
    const m = document.createElement("div");
    m.className = "menu cardmenu";
    const r = anchor.getBoundingClientRect();
    m.style.cssText = `position:fixed;left:${Math.min(r.left, innerWidth - 270)}px;top:${r.bottom + 4}px;min-width:240px;max-height:60vh;overflow:auto;z-index:70`;
    m.innerHTML = `<div class="btnrow" style="justify-content:space-between;padding:4px 6px"><b>${esc(FILTERS.find((f) => f[1] === k)[0])}</b><button class="btn small" data-mclear>Clear</button></div>
      <input class="ddq" type="search" placeholder="Search" autocomplete="off" style="margin:0 6px 6px;width:calc(100% - 12px)">
      ${list.map(([v, n]) => `<label class="check cardopt"><input type="checkbox" value="${esc(v)}" ${chosen.has(v) ? "checked" : ""}> <span>${esc(BOOL_FILTERS.includes(k) ? yesNo(v) : v || "(blank)")}</span> <span class="muted">${fmt(n)}</span></label>`).join("") || '<p class="muted" style="padding:8px">No values.</p>'}`;
    document.body.append(m);
    const apply = () => {
      const picked = [...m.querySelectorAll("input[type=checkbox]:checked")].map((x) => x.value);
      if (picked.length) st.flt[k] = picked; else delete st.flt[k];
      drawFilters(); redraw(true);
    };
    m.addEventListener("change", apply);
    m.querySelector(".ddq").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      m.querySelectorAll(".cardopt").forEach((o) => { o.hidden = !!q && !o.textContent.toLowerCase().includes(q); });
    });
    m.addEventListener("click", (e) => { if (e.target.closest("[data-mclear]")) { m.querySelectorAll("input:checked").forEach((x) => (x.checked = false)); apply(); } });
    setTimeout(() => m.querySelector(".ddq").focus(), 0);
    const outside = (e) => { if (!m.contains(e.target) && !e.target.closest("[data-filter]")) closeMenu(); };
    menu = { el: m, outside };
    setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
  }

  // ---------- cards
  const flag = (v) => (v === "TRUE" ? "✓" : "—");
  const field = (name, html) => (html.replace(/<[^>]*>/g, "").trim() === "" ? "" : `<div class="cf"><span class="cl">${esc(name)}</span><div class="cv">${html}</div></div>`);
  const picture = (img, key) => (isUrl(img) ? `<div class="oc-img"><img loading="lazy" referrerpolicy="no-referrer" src="${esc(img)}" alt="" data-zoom="${esc(key)}"></div>` : `<div class="oc-img none"></div>`);
  const keyOf = (it) => (it.kind === "order" ? "o" + it.r[0] : "k" + it.r.id);
  const find = (key) => items.find((it) => keyOf(it) === key);

  function orderCard(it) {
    const r = it.r, v = (k) => val(r, k), key = keyOf(it);
    const canPrint = DRIVE.test(v("Shipping Label Link"));
    return `<article class="ocard" data-key="${key}">
      ${picture(v("Product Image Link"), key)}
      <div class="oc-body">
        ${field("Store:", `<b>${esc(v("Store"))}</b>`)}
        ${field(label("SKU") + ":", esc(v("SKU")))}
        ${field(label("STOCK NO.") + ":", esc(v("STOCK NO.")))}
        <hr>
        <div class="oc-head"><div>${esc(v("Customer Name"))}</div><div>${esc(v("Store Order No."))}</div><div>LABEL #: ${esc(v("Label Number"))}</div></div>
        ${field("📦 NO. OF PRODUCTS IN THIS ORDER:", esc(v("Number of Orders")))}
        ${field("Gift Note", esc(v("Gift Note")))}
        <hr>
        ${field("Product Name:", `<small>${esc(v("Product Name"))}</small>`)}
        ${field("Brand:", `<small>${esc(v("Brand"))}</small>`)}
        ${field("Quantity of this Product:", esc(v("QTY")))}
        <hr>
        ${field("Amazon Order Number:", `<small>${esc(v("Source Order Number"))}</small>`)}
        ${field("Amazon Tracking Number:", `<small>${esc(v("Source Tracking Number").replace(/\s*\|\s*/g, " | "))}</small>`)}
        ${field("Amazon Order Status:", `<small>${esc(v("Source Order Status"))}</small>`)}
        ${field("Amazon Delivery Date:", esc(showDate(v("Delivery Date"))))}
        <hr>
        ${field("Tracking Number:", esc(v("Tracking Number To Customer")))}
        ${field("Shipment Status:", `<small>${esc(v("Tracking Status"))}</small>`)}
        ${field("Notes:", `<small>${esc(v("Notes"))}</small>`)}
        ${BOOLS.map((k) => field(label(k) + ":", `<span class="flag ${v(k) === "TRUE" ? "yes" : ""}">${flag(v(k))}</span>`)).join("")}
      </div>
      <div class="oc-actions">${canPrint ? `<button class="btn primary" data-print="${key}">Print label</button>` : ""}<button class="btn${canPrint ? "" : " primary"}" data-edit="${key}">Edit</button></div>
    </article>`;
  }
  function kohlsCard(it) {
    const r = it.r, key = keyOf(it);
    return `<article class="ocard" data-key="${key}">
      ${picture(r.image, key)}
      <div class="oc-body">
        ${field("Store:", `<b>${esc(r.store)}</b>`)}
        ${field("SKU:", esc(r.sku))}
        ${field("STOCK NO.:", esc(r.stock_no))}
        <hr>
        ${field("Product Name:", `<small>${esc(r.product)}</small>`)}
        ${field("Order Number:", `<small>${esc(r.order_number)}</small>`)}
        ${field("Quantity of this Product:", esc(r.qty))}
        <hr>
        ${field("Good Condition:", `<span class="flag ${r.good === "TRUE" ? "yes" : ""}">${flag(r.good)}</span>`)}
        ${field("Shipped to Customer:", `<span class="flag ${r.used === "TRUE" ? "yes" : ""}">${flag(r.used)}</span>`)}
        ${field("Notes:", `<small>${esc(r.notes)}</small>`)}
      </div>
      <div class="oc-actions"><button class="btn primary" data-edit="${key}">Edit</button></div>
    </article>`;
  }
  const card = (it) => (it.kind === "order" ? orderCard(it) : kohlsCard(it));

  function redraw(reset) {
    if (reset) shown = PAGE;
    const rows = matching(), top = window.scrollY;
    $("#cardGrid").innerHTML = rows.length ? rows.slice(0, shown).map(card).join("") : `<div class="empty">${items.length ? "No stock matches." : "No stock yet. Tick Stock on an order in All Orders, or add rows in Kohl's Returns."}</div>`;
    if (!reset) window.scrollTo(0, top);
    $("#cardCount").textContent = fmt(rows.length);
    $("#cardMore").innerHTML = shown < rows.length ? `<button class="btn" id="loadMore">Show more (${fmt(rows.length - shown)} left)</button>` : "";
  }

  // ---------- edit
  async function editOrder(it) {
    const r = it.r, cur = (k) => val(r, k);
    const res = await dialog({
      title: "Update record",
      body: `<label class="field"><span>Add Notes:</span><textarea name="Notes" rows="2">${esc(cur("Notes"))}</textarea></label>
        <label class="field"><span>${esc(label("STOCK NO."))} *</span><input name="stock" value="${esc(cur("STOCK NO."))}" required autocomplete="off"></label>
        <label class="check"><input type="checkbox" name="ship" ${cur("Shipped to Customer") === "TRUE" ? "checked" : ""}> ${esc(label("Shipped to Customer"))}</label>`,
      actions: [["Cancel", "close"], ["Update", "ok", "primary"]],
    });
    if (res.value !== "ok") return;
    const f = new FormData(res.el.querySelector("form"));
    const edits = [];
    const notes = String(f.get("Notes") ?? ""), stock = String(f.get("stock") ?? "").trim(), ship = f.get("ship") ? "TRUE" : "FALSE";
    if (notes !== cur("Notes")) edits.push({ rn: r[0], col: idx("Notes"), value: notes });
    if (stock !== cur("STOCK NO.")) edits.push({ rn: r[0], col: idx("STOCK NO."), value: stock });
    if (ship !== (cur("Shipped to Customer") === "TRUE" ? "TRUE" : "FALSE")) edits.push({ rn: r[0], col: idx("Shipped to Customer"), value: ship });
    if (!edits.length) return;
    try {
      const out = await api("/api/cells", { edits });
      edits.forEach((e, i) => { r[e.col + 1] = out.values[i]; });
      (out.also || []).forEach((a) => { if (a.rn === r[0]) r[a.col + 1] = a.value; });
      if (out.skipped) toast(out.reason, "bad"); else toast("Saved.");
      items.sort((x, y) => numberOf(y) - numberOf(x)); // the stock number may have changed
      redraw(false);
    } catch (e) { toast(e.message, "bad"); }
  }
  async function editKohls(it) {
    const r = it.r;
    const res = await dialog({
      title: "Update record",
      body: `<label class="field"><span>Add Notes:</span><textarea name="notes" rows="2">${esc(r.notes)}</textarea></label>
        <label class="field"><span>STOCK NO. *</span><input name="stock_no" value="${esc(r.stock_no)}" required autocomplete="off"></label>
        <div class="checkgrid"><label class="check"><input type="checkbox" name="good" ${r.good === "TRUE" ? "checked" : ""}> Good condition</label><label class="check"><input type="checkbox" name="used" ${r.used === "TRUE" ? "checked" : ""}> Shipped to Customer</label></div>`,
      actions: [["Cancel", "close"], ["Update", "ok", "primary"]],
    });
    if (res.value !== "ok") return;
    const f = new FormData(res.el.querySelector("form"));
    const edits = [];
    for (const k of ["stock_no", "notes"]) { const now = String(f.get(k) ?? "").trim(); if (now !== (r[k] || "")) edits.push({ id: r.id, field: k, value: now }); }
    for (const k of ["good", "used"]) { const on = !!f.get(k); if (on !== (r[k] === "TRUE")) edits.push({ id: r.id, field: k, value: on }); }
    if (!edits.length) return;
    try {
      const out = await api("/api/kohls/bulk", { edits, new: [] });
      Object.assign(r, out.rows[0]);
      toast("Saved.");
      redraw(false);
    } catch (e) { toast(e.message, "bad"); }
  }
  async function printLabel(it, btn) {
    btn.disabled = true;
    try { await printPages(await labelPages(`/api/label?rn=${it.r[0]}`)); } catch (e) { toast(`PRINT ERROR: ${e.message}`, "bad"); }
    btn.disabled = false;
  }

  // ---------- wiring
  el.onclick = (e) => {
    const t = e.target;
    const f = t.closest("[data-filter]");
    if (f) return menu ? closeMenu() : openMenu(f.dataset.filter, f);
    if (t.closest("#clearFilters")) { st.flt = {}; st.q = ""; $("#cardSearch").value = ""; drawFilters(); return redraw(true); }
    if (t.closest("#loadMore")) { shown += PAGE; return redraw(false); }
    const ed = t.closest("[data-edit]");
    if (ed) { const it = find(ed.dataset.edit); return it && (it.kind === "order" ? editOrder(it) : editKohls(it)); }
    const pr = t.closest("[data-print]");
    if (pr) { const it = find(pr.dataset.print); return it && printLabel(it, pr); }
    const z = t.closest("[data-zoom]");
    if (z) { const it = find(z.dataset.zoom); dialog({ title: it ? (it.kind === "order" ? val(it.r, "Product Name") : it.r.product) : "", wide: true, body: `<img alt="" referrerpolicy="no-referrer" src="${esc(z.src)}" style="max-width:100%;max-height:70vh;display:block;margin:0 auto;background:#fff;border-radius:8px">`, actions: [["Close", "close"]] }); }
  };
  el.oninput = debounce((e) => { if (e.target.id === "cardSearch") { st.q = e.target.value.trim(); drawFilters(); redraw(true); } }, 250);

  const onScroll = () => {
    if (!el.isConnected || location.hash !== "#cards?tab=stock") return window.removeEventListener("scroll", onScroll);
    if (window.innerHeight + window.scrollY > document.body.scrollHeight - 600 && shown < matching().length) { shown += PAGE; redraw(false); }
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  // live: when anything changes in the app, the cards refresh
  const timer = setInterval(async () => {
    if (!el.isConnected || location.hash !== "#cards?tab=stock") return clearInterval(timer);
    if (document.hidden || document.querySelector("dialog[open]") || menu) return;
    try {
      const { v } = await api("/api/version");
      if (knownV === null) knownV = v;
      else if (v !== knownV) { knownV = v; await loadAll(); redraw(false); }
    } catch { /* offline for a moment */ }
  }, 3000);

  drawFilters();
  await loadAll();
  redraw(true);
}
