// A list kept by hand that works like a sheet: a click selects a cell, arrows move, Enter / F2 / double-click edit, Ctrl+V pastes cells
// copied from a sheet (new rows are added as needed). Used by Kohl's Returns and Materials; each passes its columns and its API.
// cfg: { hash, tabs, intro, totalLabel, searchPlaceholder, list, prefix, cols, filter: { k, all }, addLabel, delText(r), emptyText, zoomTitle(r), cellClass(r, c) }
// a column: { k, name, kind: text | select | num | link | bool, w (a proportion of the width), opts (select: the list is data[opts]), ro (worked out, not typed) }
import { $, api, brand, debounce, dialog, esc, fmt, toast } from "./util.js";

const isUrl = (v) => /^https?:\/\//.test(v || "");

export async function mountSheet(el, ctx, cfg) {
  const COLS = cfg.cols;
  let data = await api(cfg.list);
  const st = { q: "", pick: "" };
  let knownV = null;
  let sel = null; // the selected cell: { id, k } (k is the column's index in COLS)
  let edit = null; // the cell being typed in: { id, k, input }
  let pop = null; // the open dropdown of a chip cell
  const options = (c) => data[c.opts] || [];
  const filterCol = cfg.filter && COLS.find((c) => c.k === cfg.filter.k);

  el.innerHTML = `<div class="section-head"><div><div class="eyebrow">${esc(brand.name)}</div><h2>${esc(cfg.heading || "Returns")}</h2>
      <p>${cfg.intro}</p></div>
      <div class="cardtabs" style="align-self:flex-start">${cfg.tabs}</div></div>
    <div class="panel cardtotal"><span>${esc(cfg.totalLabel)}</span><b id="kCount"></b></div>
    <div class="toolbar sheetbar">
      <div class="searchbox"><input id="kq" type="search" placeholder="${esc(cfg.searchPlaceholder)}" autocomplete="off"></div>
      ${filterCol ? `<select id="kstore" class="kstore" aria-label="${esc(filterCol.name)}"><option value="">${esc(cfg.filter.all)}</option>${options(filterCol).map((s) => `<option>${esc(s)}</option>`).join("")}</select>` : ""}
      <button class="btn primary" id="kadd">＋ Add row</button>
    </div>
    <div class="tablewrap kwrap" id="kwrap" tabindex="0"><table class="ktable" id="kt"></table></div>`;

  const wrap = $("#kwrap");
  const shownRows = () => {
    const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
    return data.rows.filter((r) => (!st.pick || r[cfg.filter.k] === st.pick) && words.every((w) => COLS.some((c) => c.kind !== "bool" && c.kind !== "link" && String(r[c.k] || "").toLowerCase().includes(w))));
  };
  const rowOf = (id) => data.rows.find((r) => r.id === id);
  const cellEl = (id, k) => el.querySelector(`td[data-id="${id}"][data-k="${k}"]`);

  function cell(r, c, k) {
    const v = r[c.k] || "";
    const at = `data-id="${r.id}" data-k="${k}"`;
    const extra = cfg.cellClass?.(r, c) || "";
    if (c.kind === "bool") return `<td class="kc" ${at}><input type="checkbox" ${v === "TRUE" ? "checked" : ""} aria-label="${esc(c.name)}" tabindex="-1"></td>`;
    if (c.kind === "select") return `<td class="kchipcell" ${at}><span class="kchip${v ? "" : " empty"}" data-chip title="Choose">${esc(v)}<svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><path d="M2.5 4.5l3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></span></td>`;
    if (c.kind === "link") return `<td class="klink" ${at}>${isUrl(v) ? `<button type="button" class="kzoom" data-zoom title="Show the image">↗</button>` : ""}<span class="kv">${esc(v)}</span></td>`;
    return `<td class="${c.kind === "num" ? "kn" : ""}${c.ro ? " kro" : ""} ${extra}" ${at}><span class="kv">${esc(v)}</span></td>`;
  }

  function draw() {
    const rows = shownRows();
    $("#kt").innerHTML = `<thead><tr><th class="kno">#</th>${COLS.map((c) => `<th style="width:${c.w}px" title="${esc(c.name)}">${esc(c.name)}</th>`).join("")}<th class="kdel"></th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr data-row="${r.id}"><td class="kno">${i + 1}</td>${COLS.map((c, k) => cell(r, c, k)).join("")}<td class="kdel">${ctx.isAdmin() ? `<button class="iconbtn" data-del="${r.id}" title="Delete this row (admins only)">🗑</button>` : ""}</td></tr>`).join("")
        || `<tr><td class="empty-row" colspan="${COLS.length + 2}">${data.rows.length ? "No rows match." : cfg.emptyText}</td></tr>`}</tbody>`;
    $("#kCount").textContent = rows.length === data.rows.length ? fmt(data.rows.length) : `${fmt(rows.length)} of ${fmt(data.rows.length)}`;
    edit = null;
    paintSel();
  }
  function paintSel() {
    el.querySelectorAll("td.ksel").forEach((t) => t.classList.remove("ksel"));
    if (sel) cellEl(sel.id, sel.k)?.classList.add("ksel");
  }
  function select(id, k, scroll = true) {
    if (!rowOf(id) || k < 0 || k >= COLS.length) return;
    sel = { id, k };
    paintSel();
    if (scroll) cellEl(id, k)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  function move(dr, dk) {
    const rows = shownRows();
    if (!sel || !rows.length) return;
    const i = Math.min(rows.length - 1, Math.max(0, rows.findIndex((r) => r.id === sel.id) + dr));
    select(rows[i].id, Math.min(COLS.length - 1, Math.max(0, sel.k + dk)));
  }

  // ---------- saving
  async function saveCell(id, k, value) {
    const r = rowOf(id), c = COLS[k];
    if (!r || c.ro) return draw();
    const same = c.kind === "bool" ? (value ? "TRUE" : "FALSE") === (r[c.k] === "TRUE" ? "TRUE" : "FALSE") : String(value).trim() === (r[c.k] || "");
    if (same) return draw();
    try {
      const out = await api(cfg.prefix + "edit", { id, field: c.k, value });
      Object.assign(r, out.row);
      knownV = out.v;
    } catch (e) { toast(e.message, "bad"); }
    draw();
  }

  // ---------- editing a cell
  function startEdit(initial) {
    if (!sel || edit) return;
    const c = COLS[sel.k], r = rowOf(sel.id), td = cellEl(sel.id, sel.k);
    if (!r || !td) return;
    if (c.ro) return toast(`${c.name} is worked out by itself.`, "bad");
    if (c.kind === "bool") return saveCell(sel.id, sel.k, r[c.k] !== "TRUE");
    if (c.kind === "select") return openChoices(td);
    const input = document.createElement("input");
    input.className = "kedit";
    input.value = initial ?? (r[c.k] || "");
    input.autocomplete = "off";
    if (c.kind === "num") input.inputMode = "decimal";
    td.innerHTML = "";
    td.append(input);
    edit = { id: sel.id, k: sel.k, input };
    input.focus();
    if (initial === undefined) input.setSelectionRange(input.value.length, input.value.length);
    input.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); finishEdit(true, 1, 0); }
      else if (e.key === "Tab") { e.preventDefault(); finishEdit(true, 0, e.shiftKey ? -1 : 1); }
      else if (e.key === "Escape") { e.preventDefault(); finishEdit(false); }
      e.stopPropagation();
    };
    input.onblur = () => finishEdit(true);
  }
  async function finishEdit(save, dr = 0, dk = 0) {
    const e = edit;
    if (!e) return;
    edit = null;
    e.input.onblur = null;
    const value = e.input.value;
    if (save) await saveCell(e.id, e.k, value); else draw();
    if (dr || dk) move(dr, dk); else paintSel();
    wrap.focus({ preventScroll: true });
  }

  // ---------- a chip cell: the dropdown opens only from the chip (or Enter on the cell)
  function closeChoices() {
    if (!pop) return;
    document.removeEventListener("mousedown", pop.outside, true);
    pop.el.remove();
    pop = null;
  }
  function openChoices(td) {
    closeChoices();
    const id = +td.dataset.id, k = +td.dataset.k, r = rowOf(id), c = COLS[k];
    const m = document.createElement("div");
    m.className = "menu kmenu";
    const b = (td.querySelector(".kchip") || td).getBoundingClientRect();
    m.style.cssText = `position:fixed;left:${Math.min(b.left, innerWidth - 220)}px;top:${b.bottom + 4}px;z-index:70;min-width:200px`;
    m.innerHTML = [...new Set([...options(c), r[c.k]].filter(Boolean))].map((s) => `<button type="button" class="kopt${s === r[c.k] ? " on" : ""}" data-choice="${esc(s)}"><span class="kchip">${esc(s)}</span></button>`).join("")
      + `<button type="button" class="kopt kclear" data-choice="">Clear</button>`;
    document.body.append(m);
    m.onclick = async (e) => {
      const o = e.target.closest("[data-choice]");
      if (!o) return;
      closeChoices();
      await saveCell(id, k, o.dataset.choice);
      wrap.focus({ preventScroll: true });
    };
    const outside = (e) => { if (!m.contains(e.target)) closeChoices(); };
    pop = { el: m, outside };
    setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
  }

  // ---------- mouse: one click selects, a double click edits
  wrap.addEventListener("mousedown", (e) => {
    const td = e.target.closest("td[data-k]");
    if (!td) return;
    if (edit && !td.contains(edit.input)) finishEdit(true);
    if (e.target.closest("input.kedit")) return;
    select(+td.dataset.id, +td.dataset.k, false);
    if (e.target.closest("input[type=checkbox]")) return; // the box itself toggles on click
    if (!edit) { e.preventDefault(); wrap.focus({ preventScroll: true }); }
  });
  wrap.addEventListener("click", (e) => {
    const box = e.target.closest("td.kc input[type=checkbox]");
    if (box) { const td = box.closest("td"); e.preventDefault(); saveCell(+td.dataset.id, +td.dataset.k, !box.checked); return; }
    const z = e.target.closest("[data-zoom]");
    if (z) {
      const r = rowOf(+z.closest("td").dataset.id), c = COLS[+z.closest("td").dataset.k];
      dialog({ title: cfg.zoomTitle(r), wide: true, body: `<img alt="" referrerpolicy="no-referrer" src="${esc(r[c.k])}" style="max-width:100%;max-height:70vh;display:block;margin:0 auto;background:#fff;border-radius:8px">`, actions: [["Close", "close"]] });
      return;
    }
    const chip = e.target.closest("[data-chip]");
    if (chip) openChoices(chip.closest("td"));
  });
  wrap.addEventListener("dblclick", (e) => {
    const td = e.target.closest("td[data-k]");
    if (!td || e.target.closest(".kzoom, input.kedit")) return;
    select(+td.dataset.id, +td.dataset.k, false);
    startEdit();
  });

  // ---------- keyboard
  wrap.addEventListener("keydown", (e) => {
    if (edit || !sel) return;
    const c = COLS[sel.k], r = rowOf(sel.id);
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "ArrowDown") move(1, 0);
    else if (e.key === "ArrowUp") move(-1, 0);
    else if (e.key === "ArrowLeft") move(0, -1);
    else if (e.key === "ArrowRight") move(0, 1);
    else if (e.key === "Tab") move(0, e.shiftKey ? -1 : 1);
    else if (e.key === "Enter" || e.key === "F2") startEdit();
    else if (e.key === " " && c.kind === "bool") saveCell(sel.id, sel.k, r[c.k] !== "TRUE");
    else if (e.key === "Delete" || e.key === "Backspace") { if (!c.ro) saveCell(sel.id, sel.k, c.kind === "bool" ? false : ""); }
    else if (mod && e.key.toLowerCase() === "c") { try { navigator.clipboard.writeText(r[c.k] || ""); } catch { /* no clipboard access */ } return; }
    else if (!mod && !e.altKey && e.key.length === 1 && !c.ro && c.kind !== "bool" && c.kind !== "select") startEdit(e.key);
    else return;
    e.preventDefault();
  });

  // ---------- paste from Google Sheets or Excel: the copied cells fill the grid from the selected cell (right and down), new rows are added as needed
  const parseTsv = (text) => {
    const rows = [[""]];
    let q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i], row = rows[rows.length - 1];
      if (q) { if (ch === '"' && text[i + 1] === '"') { row[row.length - 1] += '"'; i++; } else if (ch === '"') q = false; else row[row.length - 1] += ch; }
      else if (ch === '"' && row[row.length - 1] === "") q = true;
      else if (ch === "\t") row.push("");
      else if (ch === "\n") rows.push([""]);
      else if (ch !== "\r") row[row.length - 1] += ch;
    }
    if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop(); // the newline at the end of a copy
    return rows;
  };
  const onPaste = async (e) => {
    if (!wrap.isConnected) return document.removeEventListener("paste", onPaste);
    if (edit || location.hash !== cfg.hash || !wrap.contains(document.activeElement)) return;
    if (!sel) return toast("Click the cell where the paste should start.", "bad");
    e.preventDefault();
    const text = e.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    const grid = parseTsv(text), vis = shownRows();
    const r0 = vis.findIndex((r) => r.id === sel.id);
    if (r0 < 0) return;
    const edits = [], fresh = [];
    grid.forEach((cells, i) => {
      const row = vis[r0 + i], values = {};
      cells.forEach((v, j) => {
        const c = COLS[sel.k + j];
        if (!c || c.ro) return;
        if (row) edits.push({ id: row.id, field: c.k, value: v }); else values[c.k] = v;
      });
      if (!row) { if (st.pick && !(cfg.filter.k in values)) values[cfg.filter.k] = st.pick; fresh.push(values); }
    });
    try {
      const out = await api(cfg.prefix + "bulk", { edits, new: fresh });
      for (const r of out.rows) { const old = rowOf(r.id); if (old) Object.assign(old, r); else data.rows.push(r); }
      knownV = out.v;
      draw();
      toast(`Pasted ${fmt(grid.length)} row${grid.length === 1 ? "" : "s"}${fresh.length ? `, ${fmt(fresh.length)} new` : ""}.`);
    } catch (err) { toast(err.message, "bad"); }
  };
  document.addEventListener("paste", onPaste);

  // ---------- toolbar, delete, live refresh
  el.onclick = async (e) => {
    const t = e.target;
    if (t.closest("#kadd")) {
      try {
        const out = await api(cfg.prefix + "add", { values: st.pick ? { [cfg.filter.k]: st.pick } : {} });
        data.rows.push(out.row); knownV = out.v;
        sel = { id: out.row.id, k: COLS.findIndex((c) => !c.ro && c.kind !== "select" && c.kind !== "bool") };
        draw();
        cellEl(out.row.id, sel.k)?.scrollIntoView({ block: "center" });
        wrap.focus({ preventScroll: true });
      } catch (err) { toast(err.message, "bad"); }
      return;
    }
    const del = t.closest("[data-del]");
    if (del) {
      const r = rowOf(+del.dataset.del);
      const res = await dialog({ title: "Delete this row?", body: `<p>${esc(cfg.delText(r))}</p>`, actions: [["Cancel", "close"], ["Delete", "ok", "primary"]] });
      if (res.value !== "ok") return;
      try { await api(cfg.prefix + "delete", { id: +del.dataset.del }); data.rows = data.rows.filter((x) => x.id !== +del.dataset.del); draw(); toast("Deleted."); } catch (err) { toast(err.message, "bad"); }
    }
  };
  el.oninput = debounce((e) => { if (e.target.id === "kq") { st.q = e.target.value.trim(); draw(); } }, 200);
  if (filterCol) $("#kstore").onchange = (e) => { st.pick = e.target.value; draw(); };

  const timer = setInterval(async () => {
    if (!el.isConnected || location.hash !== cfg.hash) { closeChoices(); return clearInterval(timer); }
    if (document.hidden || edit || pop || document.querySelector("dialog[open]")) return;
    try {
      const { v } = await api("/api/version");
      if (knownV === null) knownV = v;
      else if (v !== knownV) { knownV = v; data = await api(cfg.list); draw(); }
    } catch { /* offline for a moment */ }
  }, 3000);

  draw();
}
