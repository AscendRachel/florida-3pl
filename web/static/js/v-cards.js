// Order Cards: every order as one card (picture and details), with the filters and the search the warehouse uses every day.
import { $, api, brand, debounce, dialog, esc, fmt, toast } from "./util.js";
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

// the filters above the cards (column names as they are in All Orders)
const FILTERS = ["Store", "Source Order Status", "Shipped to Customer", "Shipped to Amazon", "Tracking Status"];
const BOOLS = ["Shipped to Customer", "Shipped to Amazon", "ITEM ON HOLD", "Label Used", "Stock"];
const yesNo = (v) => (v === "TRUE" ? "Yes" : v === "FALSE" ? "No" : v === "" ? "(blank)" : v);

export async function mount(el, params, ctx) {
  const meta = await api("/api/meta");
  const cols = meta.columns;
  const byKey = Object.fromEntries(cols.map((c) => [c.key, c]));
  const idx = (key) => byKey[key]?.i;
  const label = (key) => byKey[key]?.name || key; // an admin may have renamed a column

  const st = { q: "", flt: {}, total: 0 };
  let rows = []; // the cards loaded so far (arrays: [rn, c0, c1, ...])
  let loading = false, gen = 0, knownV = null, menu = null;
  const val = (r, key) => (byKey[key] ? r[byKey[key].i + 1] || "" : "");

  el.innerHTML = `<div class="section-head"><div><div class="eyebrow">${esc(brand.name)}</div><h2>Order Cards</h2></div>
      <div class="muted" id="cardCount"></div></div>
    <div class="cardbar"><div class="cardfilters" id="cardFilters"></div>
      <input type="search" id="cardSearch" class="cardsearch" placeholder="Search" autocomplete="off"></div>
    <div class="cardgrid" id="cardGrid"></div>
    <div class="cardmore" id="cardMore"></div>`;

  // labels that were made ahead of time have no order in them yet: they get no card. Newest first.
  const withOrders = (flt) => ({ ...flt, [idx("Store Order No.")]: { c: { op: "notempty" } } });
  const query = (extra = {}) => ({ q: st.q, flt: withOrders(st.flt), sort: "rn", dir: "desc", ...extra });

  // ---------- filters
  const activeCount = () => Object.values(st.flt).filter((f) => f?.v?.list?.length).length;
  function drawFilters() {
    $("#cardFilters").innerHTML = FILTERS.filter((k) => byKey[k]).map((k) => {
      const n = st.flt[idx(k)]?.v?.list?.length || 0;
      return `<button class="cardfilter${n ? " on" : ""}" data-filter="${esc(k)}"><span>${esc(label(k))}</span>${n ? `<b class="cfcount">${n}</b>` : ""}<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`;
    }).join("") + (activeCount() || st.q ? `<button class="cardclear" id="clearFilters">Clear all</button>` : "");
  }

  function closeMenu() {
    if (!menu) return;
    document.removeEventListener("mousedown", menu.outside, true);
    menu.el.remove();
    menu = null;
  }
  async function openMenu(key, anchor) {
    closeMenu();
    const i = idx(key);
    const others = withOrders(st.flt);
    delete others[i];
    let list;
    try { list = (await api("/api/values", { col: i, q: st.q, flt: others })).values; } catch (e) { return toast(e.message, "bad"); }
    const chosen = new Set(st.flt[i]?.v?.list || []);
    const isBool = BOOLS.includes(key);
    const m = document.createElement("div");
    m.className = "menu cardmenu";
    const r = anchor.getBoundingClientRect();
    m.style.cssText = `position:fixed;left:${Math.min(r.left, innerWidth - 270)}px;top:${r.bottom + 4}px;min-width:240px;max-height:60vh;overflow:auto;z-index:70`;
    m.innerHTML = `<div class="btnrow" style="justify-content:space-between;padding:4px 6px"><b>${esc(label(key))}</b><button class="btn small" data-mclear>Clear</button></div>
      ${list.map((x) => `<label class="check cardopt"><input type="checkbox" value="${esc(x.v)}" ${chosen.has(x.v) ? "checked" : ""}> <span>${esc(isBool ? yesNo(x.v) : x.v || "(blank)")}</span> <span class="muted">${fmt(x.n)}</span></label>`).join("") || '<p class="muted" style="padding:8px">No values.</p>'}`;
    document.body.append(m);
    const apply = () => {
      const picked = [...m.querySelectorAll("input:checked")].map((x) => x.value);
      if (picked.length) st.flt[i] = { v: { mode: "in", list: picked } };
      else delete st.flt[i];
      drawFilters();
      reload();
    };
    m.addEventListener("change", apply);
    m.addEventListener("click", (e) => { if (e.target.closest("[data-mclear]")) { m.querySelectorAll("input:checked").forEach((x) => (x.checked = false)); apply(); } });
    const outside = (e) => { if (!m.contains(e.target) && !e.target.closest("[data-filter]")) closeMenu(); };
    menu = { el: m, outside };
    setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
  }

  // ---------- cards
  const flag = (v) => (v === "TRUE" ? "✓" : "—");
  const field = (name, html) => (html.replace(/<[^>]*>/g, "").trim() === "" ? "" : `<div class="cf"><span class="cl">${esc(name)}</span><div class="cv">${html}</div></div>`);

  function card(r, n) {
    const v = (k) => val(r, k);
    const img = v("Product Image Link");
    const canPrint = DRIVE.test(v("Shipping Label Link"));
    return `<article class="ocard" data-n="${n}">
      ${isUrl(img) ? `<div class="oc-img"><img loading="lazy" referrerpolicy="no-referrer" src="${esc(img)}" alt="" data-zoom="${n}"></div>` : `<div class="oc-img none"></div>`}
      <div class="oc-body">
        <div class="oc-head"><div>${esc(v("Customer Name"))}</div><div>${esc(v("Store Order No."))}</div><div>LABEL #: ${esc(v("Label Number"))}</div></div>
        ${field("📦 NO. OF PRODUCTS IN THIS ORDER:", esc(v("Number of Orders")))}
        ${field("Gift Note", esc(v("Gift Note")))}
        ${field("Store:", `<small>${esc(v("Store"))}</small>`)}
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
      <div class="oc-actions">${canPrint ? `<button class="btn primary" data-print="${n}">Print label</button>` : ""}<button class="btn${canPrint ? "" : " primary"}" data-edit="${n}">Edit</button></div>
    </article>`;
  }

  const drawCount = () => { $("#cardCount").textContent = `${fmt(st.total)} order${st.total === 1 ? "" : "s"}`; };
  function more() {
    $("#cardMore").innerHTML = rows.length < st.total ? `<button class="btn" id="loadMore">Show more (${fmt(st.total - rows.length)} left)</button>` : rows.length ? `<span class="muted">That is all.</span>` : "";
  }

  async function load(append) {
    if (loading) return;
    loading = true;
    const my = gen;
    try {
      const out = await api("/api/orders", query({ offset: append ? rows.length : 0, limit: PAGE }));
      if (my !== gen) return;
      st.total = out.total;
      const start = append ? rows.length : 0;
      rows = append ? rows.concat(out.rows) : out.rows;
      if (append) $("#cardGrid").insertAdjacentHTML("beforeend", out.rows.map((r, k) => card(r, start + k)).join(""));
      else $("#cardGrid").innerHTML = rows.length ? rows.map(card).join("") : `<div class="empty">No orders match.</div>`;
      drawCount(); more();
    } catch (e) { toast(e.message, "bad"); }
    loading = false;
  }
  function reload() { gen++; loading = false; rows = []; load(false); }

  // keep what is already loaded, fresh: reload as many cards as are showing
  async function refresh() {
    const want = Math.max(PAGE, rows.length);
    const my = gen;
    try {
      const out = await api("/api/orders", query({ offset: 0, limit: Math.min(500, want) }));
      if (my !== gen) return;
      st.total = out.total; rows = out.rows;
      const top = window.scrollY;
      $("#cardGrid").innerHTML = rows.length ? rows.map(card).join("") : `<div class="empty">No orders match.</div>`;
      window.scrollTo(0, top);
      drawCount(); more();
    } catch { /* offline for a moment */ }
  }

  // ---------- edit
  async function edit(n) {
    const r = rows[n];
    if (!r) return;
    const opts = {};
    for (const k of ["Source Order Status", "Tracking Status"]) {
      try { opts[k] = (await api("/api/values", { col: idx(k) })).values.map((x) => x.v).filter(Boolean); } catch { opts[k] = []; }
    }
    const cur = (k) => val(r, k);
    const select = (k) => `<label class="field"><span>${esc(label(k))}</span><select name="${esc(k)}"><option value=""></option>${[...new Set([...opts[k], cur(k)].filter(Boolean))].map((o) => `<option ${o === cur(k) ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></label>`;
    const res = await dialog({
      title: `${cur("Label Number")} · ${cur("Customer Name")}`,
      wide: true,
      body: `<div class="two" style="gap:14px">${select("Source Order Status")}${select("Tracking Status")}</div>
        <label class="field"><span>${esc(label("Tracking Number To Customer"))}</span><input name="Tracking Number To Customer" value="${esc(cur("Tracking Number To Customer"))}"></label>
        <label class="field"><span>${esc(label("Notes"))}</span><textarea name="Notes" rows="3">${esc(cur("Notes"))}</textarea></label>
        <div class="checkgrid">${BOOLS.map((k) => `<label class="check"><input type="checkbox" name="${esc(k)}" ${cur(k) === "TRUE" ? "checked" : ""}> ${esc(label(k))}</label>`).join("")}</div>
        <p class="hint">Ticking Shipped to Customer or Shipped to Amazon stamps the date and time, as in All Orders. Everything you change is recorded under your name.</p>`,
      actions: [["Cancel", "close"], ["Save", "ok", "primary"]],
    });
    if (res.value !== "ok") return;
    const f = new FormData(res.el.querySelector("form"));
    const edits = [];
    for (const k of ["Source Order Status", "Tracking Status", "Tracking Number To Customer", "Notes"]) {
      const now = String(f.get(k) ?? "");
      if (now !== cur(k)) edits.push({ rn: r[0], col: idx(k), value: now });
    }
    for (const k of BOOLS) {
      const now = f.get(k) ? "TRUE" : "FALSE";
      if (now !== (cur(k) === "TRUE" ? "TRUE" : "FALSE")) edits.push({ rn: r[0], col: idx(k), value: now });
    }
    if (!edits.length) return;
    try {
      const out = await api("/api/cells", { edits });
      edits.forEach((e, i) => { r[e.col + 1] = out.values[i]; });
      (out.also || []).forEach((a) => { if (a.rn === r[0]) r[a.col + 1] = a.value; });
      if (out.skipped) toast(out.reason, "bad");
      else toast("Saved.");
      const old = el.querySelector(`.ocard[data-n="${n}"]`);
      if (old) old.outerHTML = card(r, n);
    } catch (e) { toast(e.message, "bad"); }
  }

  async function printLabel(n, btn) {
    const r = rows[n];
    btn.disabled = true;
    try {
      await printPages(await labelPages(`/api/label?rn=${r[0]}`));
    } catch (e) { toast(`PRINT ERROR: ${e.message}`, "bad"); }
    btn.disabled = false;
  }

  // ---------- wiring
  el.onclick = (e) => {
    const t = e.target;
    const f = t.closest("[data-filter]");
    if (f) return menu ? closeMenu() : openMenu(f.dataset.filter, f);
    if (t.closest("#clearFilters")) { st.flt = {}; st.q = ""; $("#cardSearch").value = ""; drawFilters(); return reload(); }
    if (t.closest("#loadMore")) return load(true);
    const ed = t.closest("[data-edit]"); if (ed) return edit(+ed.dataset.edit);
    const pr = t.closest("[data-print]"); if (pr) return printLabel(+pr.dataset.print, pr);
    const z = t.closest("[data-zoom]");
    if (z) dialog({ title: val(rows[+z.dataset.zoom], "Product Name"), wide: true, body: `<img alt="" referrerpolicy="no-referrer" src="${esc(z.src)}" style="max-width:100%;max-height:70vh;display:block;margin:0 auto;background:#fff;border-radius:8px">`, actions: [["Close", "close"]] });
  };
  el.oninput = debounce((e) => { if (e.target.id === "cardSearch") { st.q = e.target.value.trim(); drawFilters(); reload(); } }, 250);

  // a scroll to the end loads the next cards
  const onScroll = () => {
    if (!el.isConnected || location.hash !== "#cards") return window.removeEventListener("scroll", onScroll);
    if (window.innerHeight + window.scrollY > document.body.scrollHeight - 600 && rows.length < st.total && !loading) load(true);
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  // live: when anything changes in the app, the cards refresh
  const timer = setInterval(async () => {
    if (!el.isConnected || location.hash !== "#cards") return clearInterval(timer);
    if (document.hidden || document.querySelector("dialog[open]") || menu) return;
    try {
      const { v } = await api("/api/version");
      if (knownV === null) knownV = v;
      else if (v !== knownV) { knownV = v; await refresh(); }
    } catch { /* offline for a moment */ }
  }, 3000);

  drawFilters();
  await load(false);
}
