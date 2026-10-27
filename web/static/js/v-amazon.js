// Amazon orders: upload the orders file downloaded from Amazon, check what it would change, then apply it.
import { $, api, brand, esc, fmt, toast } from "./util.js";

export async function mount(el) {
  let plan = null, busy = false;

  const draw = () => {
    el.innerHTML = `<div class="section-head"><div><div class="eyebrow">${esc(brand.name)}</div><h2>Amazon Orders</h2>
      <p>Upload the orders file you download from Amazon (.csv). Each line is matched to an All Orders row by <b>Order ID</b> = Source Order Number, and by product title when an order has several items. The <b>Carrier Tracking #</b> goes into Source Tracking Number and the <b>Delivery Status</b> updates Source Order Status. You see the result first and nothing changes until you confirm.</p></div></div>
      <div class="card">
        <label class="dropzone" id="drop"><input type="file" id="file" accept=".csv" hidden>
          <b>${plan ? esc(plan.file) : "Choose the Amazon .csv file"}</b><span class="muted">${plan ? "Choose a different file" : "or drag it here"}</span></label>
        <p class="hint">Rows that are already <b>Delivered, Refunded, For Refund or Cancelled</b> are left exactly as they are (nothing is rewritten), so a whole month's file is safe. Several items of one store order are Partially Delivered until the last one has arrived, then all become Delivered.</p>
      </div>
      <div id="result">${plan ? preview() : ""}</div>`;
  };

  const preview = () => {
    const p = plan;
    const cards = [["Lines in the file", p.lines, ""], ["Rows matched in All Orders", p.matched_rows, "ok"], ["Already finished, left alone", p.skipped_done, "neutral"], ["Tracking numbers added", p.tracking_added, "info"], ["Statuses changed", p.status_changed, "warn"],
      ["Orders not in All Orders", p.unmatched_total, p.unmatched_total ? "neutral" : ""], ["Could not tell which item", p.unsure.length, p.unsure.length ? "crit" : ""]];
    const trk = (c) => (c.changes["Source Tracking Number"] ? `<div class="mono" style="font-size:12px">${esc(c.was["Source Tracking Number"].replace(/\s*\|\s*/g, " | ").replace(/\n/g, " ") || "(blank)")} <span class="muted">→</span> ${esc(c.changes["Source Tracking Number"].replace(/\|/g, " | "))}</div>` : "");
    const st = (c) => (c.changes["Source Order Status"] ? `${esc(c.was["Source Order Status"] || "(blank)")} <span class="muted">→</span> <b>${esc(c.changes["Source Order Status"])}</b>` : '<span class="muted">—</span>');
    return `<div class="dash-cards" style="margin-top:14px">${cards.map(([l, n, t]) => `<div class="scard ${t} dash-card"><div class="dash-n">${fmt(n)}</div><div class="dash-l">${esc(l)}</div></div>`).join("")}</div>
      ${p.moves.length ? `<div class="panel"><b>Status changes</b><div class="btnrow" style="margin-top:8px;flex-wrap:wrap">${p.moves.map((m) => `<span class="pill">${esc(m.move)} · ${fmt(m.n)}</span>`).join("")}</div></div>` : ""}
      <div class="panel"><div class="btnrow" style="justify-content:space-between;align-items:center">
        <div>${p.changed_total ? `<b>${fmt(p.changed_total)}</b> rows will change.` : "Nothing to change: All Orders already matches this file."}</div>
        ${p.changed_total ? `<button class="btn primary" id="apply" ${busy ? "disabled" : ""}>Apply to All Orders</button>` : ""}</div></div>
      ${p.changed_total ? `<div class="panel"><b>The changes</b>${p.changed_total > p.shown.length ? ` <span class="muted">(first ${p.shown.length} of ${fmt(p.changed_total)})</span>` : ""}
        <div class="tablewrap" style="max-height:420px;margin-top:8px"><table><thead><tr><th>Label</th><th>Amazon order</th><th>Product</th><th>Tracking</th><th>Status</th></tr></thead><tbody>
        ${p.shown.map((c) => `<tr><td>${esc(c.label)}</td><td class="mono">${esc(c.order)}</td><td class="clip" title="${esc(c.title)}">${esc(c.title)}</td><td>${trk(c) || '<span class="muted">—</span>'}</td><td>${st(c)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
      ${p.unsure.length ? `<div class="panel"><b>Could not tell which item (skipped)</b><div class="tablewrap" style="max-height:240px;margin-top:8px"><table><tbody>${p.unsure.map((u) => `<tr><td class="mono">${esc(u.order)}</td><td class="clip">${esc(u.title)}</td><td class="muted">${esc(u.why)}</td></tr>`).join("")}</tbody></table></div></div>` : ""}
      ${p.unmatched_total ? `<details class="panel"><summary><b>${fmt(p.unmatched_total)}</b> orders in the file are not in All Orders (skipped)</summary><div class="tablewrap" style="max-height:260px;margin-top:8px"><table><tbody>${p.unmatched_orders.map((u) => `<tr><td class="mono">${esc(u.order)}</td><td class="clip">${esc(u.title)}</td></tr>`).join("")}</tbody></table></div>${p.unmatched_total > p.unmatched_orders.length ? `<p class="hint">Showing the first ${p.unmatched_orders.length}.</p>` : ""}</details>` : ""}`;
  };

  const upload = async (f) => {
    if (!f) return;
    toast(`Reading ${f.name}…`);
    try {
      plan = await api("/api/amazon/preview", await f.arrayBuffer(), { headers: { "X-Filename": encodeURIComponent(f.name) } });
    } catch (e) {
      plan = null; draw();
      $("#result").innerHTML = `<div class="banner bad">${esc(e.message)}</div>`;
      return;
    }
    draw();
  };

  el.onchange = (e) => { if (e.target.id === "file") upload(e.target.files[0]); };
  el.onclick = async (e) => {
    if (e.target.closest("#apply") && plan && !busy) {
      busy = true; $("#apply").disabled = true;
      try {
        const out = await api("/api/amazon/apply", { token: plan.token });
        const done = plan;
        plan = null; busy = false; draw();
        $("#result").innerHTML = `<div class="banner" style="background:var(--ok-bg);color:var(--ok)">Done. ${fmt(out.rows)} rows updated: ${fmt(out.tracking_added)} tracking numbers added, ${fmt(out.status_changed)} statuses changed. Every change is in the cell's edit history as "Amazon import".</div>`;
        toast("Amazon file applied.");
      } catch (err) { busy = false; toast(err.message, "bad"); const b = $("#apply"); if (b) b.disabled = false; }
    }
  };
  el.ondragover = (e) => e.preventDefault();
  el.ondrop = (e) => { e.preventDefault(); upload(e.dataTransfer.files[0]); };
  draw();
}
