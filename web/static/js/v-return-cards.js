// Order Cards, Store Returns side: every customer return as one card (picture and details), with the filters and the search.
// The returns come from the Returns tab (the master returns sheet); the warehouse changes only Shipped to Amazon and its own notes here.
import { $, api, brand, debounce, dialog, esc, fmt, toast } from "./util.js";
import { cardTabs } from "./card-tabs.js";

const PAGE = 48;
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const showDate = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}))?$/.exec(v || "");
  if (!m) return v || "";
  return `${MONTH[+m[2] - 1]} ${+m[3]}, ${m[1]}${m[4] ? ` ${+m[4] % 12 || 12}:${m[5]} ${+m[4] >= 12 ? "PM" : "AM"}` : ""}`;
};
const isUrl = (v) => /^https?:\/\//.test(v || "");
const PILL = { DELIVERED: "s-ok", "PENDING RETURN": "s-warn", "IN TRANSIT": "s-info" };
const yesNo = (v) => (v === "TRUE" ? "Yes" : v === "FALSE" ? "No" : v === "" ? "(blank)" : v);

// the filters above the cards: [field, title]
const FILTERS = [["status_cx", "Customer Return Status"], ["status_wh", "Amazon Return Status"], ["store", "Store"], ["shipped", "Shipped to Amazon"], ["refunded", "Source Refunded"]];
const SEARCH = ["rid", "po", "product", "customer", "tracking", "store", "reason", "notes", "wh_notes", "address"];

export async function mount(el, params, ctx) {
  let data = await api("/api/returns");
  const L = (k, fallback) => data.labels?.[k] || fallback; // an admin may have renamed a column
  const st = { q: "", flt: {} };
  let shown = PAGE, menu = null, knownV = null;

  el.innerHTML = `<div class="section-head"><div><div class="eyebrow">${esc(brand.name)}</div><h2>Order Cards</h2></div>
      <div class="cardtabs">${cardTabs("returns")}</div>
      </div>
    <div class="panel cardtotal"><span>STORE RETURNS TOTAL CARDS:</span><b id="cardCount"></b></div>
    <div class="cardbar"><div class="cardfilters" id="cardFilters"></div>
      <input type="search" id="cardSearch" class="cardsearch" placeholder="Search" autocomplete="off"></div>
    <div class="cardgrid" id="cardGrid"></div>
    <div class="cardmore" id="cardMore"></div>`;

  const live = () => data.rows.filter((r) => !r.removed).slice().reverse(); // newest first
  const matching = (skip) => {
    const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    return live().filter((r) => {
      for (const [k, list] of Object.entries(st.flt)) if (k !== skip && list.length && !list.includes(r[k] || "")) return false;
      if (!words.length) return true;
      const hay = SEARCH.map((k) => r[k] || "").join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  };

  // ---------- filters
  const activeCount = () => Object.values(st.flt).filter((l) => l.length).length;
  function drawFilters() {
    $("#cardFilters").innerHTML = FILTERS.map(([k, t]) => {
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
    for (const r of matching(k)) counts.set(r[k] || "", (counts.get(r[k] || "") || 0) + 1);
    const list = [...counts].sort((a, b) => a[0].localeCompare(b[0]));
    const chosen = new Set(st.flt[k] || []);
    const isBool = k === "shipped" || k === "refunded";
    const m = document.createElement("div");
    m.className = "menu cardmenu";
    const r = anchor.getBoundingClientRect();
    m.style.cssText = `position:fixed;left:${Math.min(r.left, innerWidth - 270)}px;top:${r.bottom + 4}px;min-width:240px;max-height:60vh;overflow:auto;z-index:70`;
    m.innerHTML = `<div class="btnrow" style="justify-content:space-between;padding:4px 6px"><b>${esc(FILTERS.find((f) => f[0] === k)[1])}</b><button class="btn small" data-mclear>Clear</button></div>
      <input class="ddq" type="search" placeholder="Search" autocomplete="off" style="margin:0 6px 6px;width:calc(100% - 12px)">
      ${list.map(([v, n]) => `<label class="check cardopt"><input type="checkbox" value="${esc(v)}" ${chosen.has(v) ? "checked" : ""}> <span>${esc(isBool ? yesNo(v) : v || "(blank)")}</span> <span class="muted">${fmt(n)}</span></label>`).join("") || '<p class="muted" style="padding:8px">No values.</p>'}`;
    document.body.append(m);
    const apply = () => {
      const picked = [...m.querySelectorAll("input:checked")].map((x) => x.value);
      if (picked.length) st.flt[k] = picked; else delete st.flt[k];
      drawFilters(); redraw(true);
    };
    m.addEventListener("change", apply);
    m.querySelector(".ddq").addEventListener("input", (e) => {
      const q = e.target.value.trim().toLowerCase();
      m.querySelectorAll(".cardopt").forEach((o) => { o.hidden = !!q && !o.textContent.toLowerCase().includes(q); });
    });
    setTimeout(() => m.querySelector(".ddq").focus(), 0);
    m.addEventListener("click", (e) => { if (e.target.closest("[data-mclear]")) { m.querySelectorAll("input:checked").forEach((x) => (x.checked = false)); apply(); } });
    const outside = (e) => { if (!m.contains(e.target) && !e.target.closest("[data-filter]")) closeMenu(); };
    menu = { el: m, outside };
    setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
  }

  // ---------- cards
  const flag = (v) => (v === "TRUE" ? "✓" : "—");
  const field = (name, html) => (html.replace(/<[^>]*>/g, "").trim() === "" ? "" : `<div class="cf"><span class="cl">${esc(name)}</span><div class="cv">${html}</div></div>`);
  const pill = (v) => (v ? `<span class="pill ${PILL[v] || "s-neutral"}">${esc(v)}</span>` : "");

  function card(r) {
    const due = r.due_date && r.shipped !== "TRUE" && r.due_date.slice(0, 10) < new Date().toISOString().slice(0, 10);
    return `<article class="ocard" data-rid="${esc(r.rid)}">
      ${isUrl(r.image) ? `<div class="oc-img"><img loading="lazy" referrerpolicy="no-referrer" src="${esc(r.image)}" alt="" data-zoom="${esc(r.rid)}"></div>` : `<div class="oc-img none"></div>`}
      <div class="oc-body">
        <div class="oc-head"><div>${esc(r.customer)}</div><div>${esc(r.po)}</div><div>${esc(L("rid", "RETURN ID"))}: ${esc(r.rid)}</div></div>
        ${field(L("store", "STORE") + ":", `<small>${esc(r.store)}</small>`)}
        <hr>
        ${field(L("product", "PRODUCT NAME") + ":", `<small>${esc(r.product)}</small>`)}
        ${field(L("qty", "QTY") + ":", esc(r.qty))}
        ${field(L("reason", "REASON") + ":", `<small>${esc(r.reason)}</small>`)}
        <hr>
        ${field(L("return_date", "RETURN DATE") + ":", esc(showDate(r.return_date)))}
        ${field(L("due_date", "RETURN DUE DATE") + ":", `<span${due ? ' class="flag" style="color:var(--crit,#c62828)"' : ""}>${esc(showDate(r.due_date))}${due ? " · overdue" : ""}</span>`)}
        ${field(L("tracking", "TRACKING NUMBER (CX TO WAREHOUSE)") + ":", esc(r.tracking))}
        ${field(L("status_cx", "RETURN STATUS FROM CX TO WAREHOUSE") + ":", pill(r.status_cx))}
        ${isUrl(r.label_link) ? field(L("label_link", "RETURN LABEL LINK") + ":", `<a href="${esc(r.label_link)}" target="_blank" rel="noopener">Open</a>`) : ""}
        ${field(L("notes", "NOTES") + ":", `<small>${esc(r.notes)}</small>`)}
        <hr>
        ${field(L("status_wh", "RETURN STATUS FROM WAREHOUSE TO AMZ") + ":", pill(r.status_wh))}
        ${field(L("refunded", "SOURCE REFUNDED") + ":", `<span class="flag ${r.refunded === "TRUE" ? "yes" : ""}">${flag(r.refunded)}</span>`)}
        ${field(L("shipped", "SHIPPED TO AMAZON") + ":", `<span class="flag ${r.shipped === "TRUE" ? "yes" : ""}">${flag(r.shipped)}</span>`)}
        ${r.shipped === "TRUE" ? field(L("processed_by", "PROCESSED BY") + ":", `<small>${esc(r.processed_by)}${r.processed_at ? " · " + esc(showDate(r.processed_at)) : ""}</small>`) : ""}
        ${field(L("wh_notes", "WAREHOUSE NOTES") + ":", `<small>${esc(r.wh_notes)}</small>`)}
      </div>
      <div class="oc-actions"><button class="btn primary" data-edit="${esc(r.rid)}">Edit</button></div>
    </article>`;
  }

  function redraw(reset) {
    if (reset) shown = PAGE;
    const rows = matching(), top = window.scrollY;
    $("#cardGrid").innerHTML = rows.length ? rows.slice(0, shown).map(card).join("") : `<div class="empty">${data.rows.length ? "No returns match." : "No returns yet. Press Sync now in the Returns tab to read the master returns sheet."}</div>`;
    if (!reset) window.scrollTo(0, top);
    $("#cardCount").textContent = fmt(rows.length);
    $("#cardMore").innerHTML = shown < rows.length ? `<button class="btn" id="loadMore">Show more (${fmt(rows.length - shown)} left)</button>` : "";
  }

  // ---------- edit: only what the warehouse owns
  async function edit(rid) {
    const r = data.rows.find((x) => x.rid === rid);
    if (!r) return;
    const res = await dialog({
      title: `${r.rid} · ${r.customer}`,
      wide: true,
      body: `<label class="field"><span>${esc(L("wh_notes", "WAREHOUSE NOTES"))}</span><textarea name="wh_notes" rows="3">${esc(r.wh_notes)}</textarea></label>
        <div class="checkgrid"><label class="check"><input type="checkbox" name="shipped" ${r.shipped === "TRUE" ? "checked" : ""}> ${esc(L("shipped", "SHIPPED TO AMAZON"))}</label></div>
        <p class="hint">Ticking Shipped to Amazon records the date and time and your name, as in the Returns tab.</p>`,
      actions: [["Cancel", "close"], ["Save", "ok", "primary"]],
    });
    if (res.value !== "ok") return;
    const f = new FormData(res.el.querySelector("form"));
    try {
      const notes = String(f.get("wh_notes") ?? "").trim(), shipped = !!f.get("shipped");
      let row = null;
      if (notes !== (r.wh_notes || "")) row = (await api("/api/returns/edit", { rid, field: "wh_notes", value: notes })).row;
      if (shipped !== (r.shipped === "TRUE")) row = (await api("/api/returns/edit", { rid, field: "shipped", value: shipped })).row;
      if (row) { Object.assign(r, { ...row, image: r.image }); toast("Saved."); }
      redraw(false);
    } catch (e) { toast(e.message, "bad"); }
  }

  // ---------- wiring
  el.onclick = (e) => {
    const t = e.target;
    const f = t.closest("[data-filter]");
    if (f) return menu ? closeMenu() : openMenu(f.dataset.filter, f);
    if (t.closest("#clearFilters")) { st.flt = {}; st.q = ""; $("#cardSearch").value = ""; drawFilters(); return redraw(true); }
    if (t.closest("#loadMore")) { shown += PAGE; return redraw(false); }
    const ed = t.closest("[data-edit]"); if (ed) return edit(ed.dataset.edit);
    const z = t.closest("[data-zoom]");
    if (z) dialog({ title: data.rows.find((x) => x.rid === z.dataset.zoom)?.product || "", wide: true, body: `<img alt="" referrerpolicy="no-referrer" src="${esc(z.src)}" style="max-width:100%;max-height:70vh;display:block;margin:0 auto;background:#fff;border-radius:8px">`, actions: [["Close", "close"]] });
  };
  el.oninput = debounce((e) => { if (e.target.id === "cardSearch") { st.q = e.target.value.trim(); drawFilters(); redraw(true); } }, 250);

  const onScroll = () => {
    if (!el.isConnected || location.hash !== "#cards?tab=returns") return window.removeEventListener("scroll", onScroll);
    if (window.innerHeight + window.scrollY > document.body.scrollHeight - 600 && shown < matching().length) { shown += PAGE; redraw(false); }
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  // live: when anything changes in the app (a sync, a tick), the cards refresh
  const timer = setInterval(async () => {
    if (!el.isConnected || location.hash !== "#cards?tab=returns") return clearInterval(timer);
    if (document.hidden || document.querySelector("dialog[open]") || menu) return;
    try {
      const { v } = await api("/api/version");
      if (knownV === null) knownV = v;
      else if (v !== knownV) { knownV = v; data = await api("/api/returns"); redraw(false); }
    } catch { /* offline for a moment */ }
  }, 3000);

  drawFilters();
  redraw(true);
}
