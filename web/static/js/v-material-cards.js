// Order Cards, Materials side: every packing material as one card (picture, size, quantities and stock status), with the status filter and the search.
// The materials are the ones of the Materials tab; Update changes the stock numbers, and the status follows by itself.
import { $, api, brand, debounce, dialog, esc, fmt, toast } from "./util.js";
import { cardTabs } from "./card-tabs.js";

const PAGE = 48;
const isUrl = (v) => /^https?:\/\//.test(v || "");
const TONE = { GOOD: "st-good", "REORDER ALERT": "st-warn", CRITICAL: "st-bad", "OUT OF STOCK": "st-bad" };
const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());

export async function mount(el, params, ctx) {
  let data = await api("/api/materials");
  const st = { q: "", flt: [] }; // flt: the stock statuses chosen
  let shown = PAGE, menu = null, knownV = null;

  el.innerHTML = `<div class="section-head"><div><div class="eyebrow">${esc(brand.name)}</div><h2>Order Cards</h2></div>
      <div class="cardtabs">${cardTabs("materials")}</div></div>
    <div class="panel cardtotal"><span>MATERIALS TOTAL CARDS:</span><b id="cardCount"></b></div>
    <div class="cardbar"><div class="cardfilters" id="cardFilters"></div>
      <input type="search" id="cardSearch" class="cardsearch" placeholder="Search" autocomplete="off"></div>
    <div class="cardgrid" id="cardGrid"></div>
    <div class="cardmore" id="cardMore"></div>`;

  const matching = (skipStatus) => {
    const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    return data.rows.filter((r) => {
      if (!skipStatus && st.flt.length && !st.flt.includes(r.status)) return false;
      const hay = [r.mid, r.name, r.spec, r.unit, r.pack, r.notes, r.status].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  };

  // ---------- the Stock Status filter
  function drawFilters() {
    const n = st.flt.length;
    $("#cardFilters").innerHTML = `<button class="cardfilter${n ? " on" : ""}" data-filter="status"><span>Stock Status</span>${n ? `<b class="cfcount">${n}</b>` : ""}<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
      + (n || st.q ? `<button class="cardclear" id="clearFilters">Clear all</button>` : "");
  }
  function closeMenu() {
    if (!menu) return;
    document.removeEventListener("mousedown", menu.outside, true);
    menu.el.remove();
    menu = null;
  }
  function openMenu(anchor) {
    const counts = new Map();
    for (const r of matching(true)) counts.set(r.status, (counts.get(r.status) || 0) + 1);
    const list = [...counts].sort((a, b) => a[0].localeCompare(b[0]));
    const m = document.createElement("div");
    m.className = "menu cardmenu";
    const r = anchor.getBoundingClientRect();
    m.style.cssText = `position:fixed;left:${Math.min(r.left, innerWidth - 270)}px;top:${r.bottom + 4}px;min-width:240px;max-height:60vh;overflow:auto;z-index:70`;
    m.innerHTML = `<div class="btnrow" style="justify-content:space-between;padding:4px 6px"><b>Stock Status</b><button class="btn small" data-mclear>Clear</button></div>
      <input class="ddq" type="search" placeholder="Search" autocomplete="off" style="margin:0 6px 6px;width:calc(100% - 12px)">
      ${list.map(([v, n]) => `<label class="check cardopt"><input type="checkbox" value="${esc(v)}" ${st.flt.includes(v) ? "checked" : ""}> <span>${esc(titleCase(v || "(blank)"))}</span> <span class="muted">${fmt(n)}</span></label>`).join("") || '<p class="muted" style="padding:8px">No values.</p>'}`;
    document.body.append(m);
    const apply = () => { st.flt = [...m.querySelectorAll("input[type=checkbox]:checked")].map((x) => x.value); drawFilters(); redraw(true); };
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
  const field = (name, html) => (html.replace(/<[^>]*>/g, "").trim() === "" ? "" : `<div class="cf"><span class="cl">${esc(name)}</span><div class="cv">${html}</div></div>`);
  function card(r) {
    return `<article class="ocard" data-id="${r.id}">
      ${isUrl(r.image) ? `<div class="oc-img mat"><img loading="lazy" referrerpolicy="no-referrer" src="${esc(r.image)}" alt="" data-zoom="${r.id}"></div>` : `<div class="oc-img none"></div>`}
      <div class="oc-body">
        <div class="oc-head"><small class="mat-id">${esc(r.mid)}</small><div class="mat-name">${esc(r.name)}</div></div>
        ${field("Item Specifications:", esc(r.spec))}
        <hr>
        ${field("Ordered Qty:", esc(r.ordered))}
        ${field("Current Stock:", esc(r.current))}
        ${field("Stock Status:", `<span class="${TONE[r.status] || ""} mat-status">${esc(r.status)}</span>`)}
        ${field("Notes:", `<small>${esc(r.notes)}</small>`)}
      </div>
      <div class="oc-actions"><button class="btn primary" data-edit="${r.id}">Update</button></div>
    </article>`;
  }
  function redraw(reset) {
    if (reset) shown = PAGE;
    const rows = matching(), top = window.scrollY;
    $("#cardGrid").innerHTML = rows.length ? rows.slice(0, shown).map(card).join("") : `<div class="empty">${data.rows.length ? "No materials match." : "No materials yet. Add them in the Materials tab."}</div>`;
    if (!reset) window.scrollTo(0, top);
    $("#cardCount").textContent = fmt(rows.length);
    $("#cardMore").innerHTML = shown < rows.length ? `<button class="btn" id="loadMore">Show more (${fmt(rows.length - shown)} left)</button>` : "";
  }

  // ---------- Update: the stock numbers
  async function update(id) {
    const r = data.rows.find((x) => x.id === id);
    if (!r) return;
    const res = await dialog({
      title: `${r.mid} · ${r.name}`,
      wide: true,
      body: `<div class="two" style="gap:14px"><label class="field"><span>Current Stock</span><input name="current" inputmode="decimal" value="${esc(r.current)}" autocomplete="off"></label>
          <label class="field"><span>Ordered Qty</span><input name="ordered" inputmode="decimal" value="${esc(r.ordered)}" autocomplete="off"></label></div>
        <div class="two" style="gap:14px"><label class="field"><span>Alert Level</span><input name="alert" inputmode="decimal" value="${esc(r.alert)}" autocomplete="off"></label>
          <label class="field"><span>Minimum Stock</span><input name="minimum" inputmode="decimal" value="${esc(r.minimum)}" autocomplete="off"></label></div>
        <label class="field"><span>Notes</span><textarea name="notes" rows="3">${esc(r.notes)}</textarea></label>
        <p class="hint">The Stock Status follows the numbers: nothing left is Out of Stock, at or under the Minimum Stock is Critical, at or under the Alert Level is Reorder Alert. The update is recorded under your name.</p>`,
      actions: [["Cancel", "close"], ["Save", "ok", "primary"]],
    });
    if (res.value !== "ok") return;
    const f = new FormData(res.el.querySelector("form"));
    const edits = ["current", "ordered", "alert", "minimum", "notes"].flatMap((k) => { const now = String(f.get(k) ?? "").trim(); return now !== (r[k] || "") ? [{ id, field: k, value: now }] : []; });
    if (!edits.length) return;
    try {
      const out = await api("/api/materials/bulk", { edits, new: [] });
      Object.assign(r, out.rows[0]);
      knownV = out.v;
      toast("Saved.");
      redraw(false);
    } catch (e) { toast(e.message, "bad"); }
  }

  // ---------- wiring
  el.onclick = (e) => {
    const t = e.target;
    if (t.closest("[data-filter]")) return menu ? closeMenu() : openMenu(t.closest("[data-filter]"));
    if (t.closest("#clearFilters")) { st.flt = []; st.q = ""; $("#cardSearch").value = ""; drawFilters(); return redraw(true); }
    if (t.closest("#loadMore")) { shown += PAGE; return redraw(false); }
    const ed = t.closest("[data-edit]"); if (ed) return update(+ed.dataset.edit);
    const z = t.closest("[data-zoom]");
    if (z) { const r = data.rows.find((x) => x.id === +z.dataset.zoom); dialog({ title: r ? `${r.mid} ${r.name}` : "", wide: true, body: `<img alt="" referrerpolicy="no-referrer" src="${esc(z.src)}" style="max-width:100%;max-height:70vh;display:block;margin:0 auto;background:#fff;border-radius:8px">`, actions: [["Close", "close"]] }); }
  };
  el.oninput = debounce((e) => { if (e.target.id === "cardSearch") { st.q = e.target.value.trim(); drawFilters(); redraw(true); } }, 250);

  const onScroll = () => {
    if (!el.isConnected || location.hash !== "#cards?tab=materials") return window.removeEventListener("scroll", onScroll);
    if (window.innerHeight + window.scrollY > document.body.scrollHeight - 600 && shown < matching().length) { shown += PAGE; redraw(false); }
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  const timer = setInterval(async () => {
    if (!el.isConnected || location.hash !== "#cards?tab=materials") return clearInterval(timer);
    if (document.hidden || document.querySelector("dialog[open]") || menu) return;
    try {
      const { v } = await api("/api/version");
      if (knownV === null) knownV = v;
      else if (v !== knownV) { knownV = v; data = await api("/api/materials"); redraw(false); }
    } catch { /* offline for a moment */ }
  }, 3000);

  drawFilters();
  redraw(true);
}
