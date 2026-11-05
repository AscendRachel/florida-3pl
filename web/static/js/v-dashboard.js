// Dashboard: the day's numbers (the sheet's Dashboard tab). Times are US Eastern, the warehouse's clock.
import { mountChat } from "./chat-bubble.js";
import { textOn } from "./cond-format.js";
import { $, api, brand, dialog, esc, fmt, toast, tzEastern } from "./util.js";

const hourLabel = (h) => {
  const f = (x) => `${x % 12 || 12}:00 ${x < 12 ? "AM" : "PM"}`;
  return `${f(h)} - ${f(h).replace(":00", ":59")}`;
};
// the Rows Color Legend of the SOP: the fills are the ones All Orders paints (cond-format.js)
const LEGEND = [
  ["Yellow-Green", "#00ff00", "The shipment status of the order to the warehouse is marked as delivered from Amazon."],
  ["Gray", "#b7b7b7", "The order is in transit to the customer from the Florida warehouse."],
  ["Yellow", "#ffff00", "The order has been successfully delivered to the customer."],
  ["Cyan Blue", "#00ffff", "The order has already been refunded by Amazon for reasons such as cancellation, return, or damage."],
  ["Red", "#ff0000", "Late delivery. The estimated delivery date scheduled by Amazon has passed, and the order was not delivered on time."],
  ["Dark Green", "#6aa84f", "Unfulfilled order or the order was not placed on Amazon."],
  ["Orange", "#ff9900", "Assumed not received. This happens when Amazon marks the shipment as delivered, but it has not actually arrived at the warehouse."],
  ["Magenta", "#ff00ff", "Shipped by 3PL, but the tracking status shows no movement."],
  ["Brown", "#783f04", "Orders that need to be returned to Amazon."],
  ["Pink", "#f4cccc", "Orders that need to be refunded through Amazon."],
  ["Purple", "#9900ff", "Return to Sender. The package was unsuccessfully delivered and is being returned to the sender (3PL/warehouse)."],
];

const TONE = { estimated: "info", warehouse: "violet", hold: "warn", customer: "ok", amazon: "info", arrived: "ok" };

export async function mount(el, params, ctx) {
  let day = params.get("date") || "", data = null, timer = null;
  const shift = (n) => {
    const d = new Date(day + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  function table(title, rows, ops, total, hint) {
    const showOther = rows.some((r) => r.other);
    const nowHour = data.date === data.today ? +data.now.slice(11, 13) : -1;
    return `<div class="panel dash-table"><div class="dash-head"><h3>${title}</h3><span class="muted">${hint}</span></div>
      <div class="tablewrap" style="max-height:none"><table><thead><tr><th>Time (US)</th><th class="num">Total</th>
        ${ops.map((o) => `<th class="num">${esc(o)}</th>`).join("")}${showOther ? '<th class="num">Others</th>' : ""}</tr></thead><tbody>
      ${rows.map((r, h) => `<tr class="${r.total ? "" : "zero"}${h === nowHour ? " nowrow" : ""}"><td>${hourLabel(h)}</td><td class="num"><b>${fmt(r.total)}</b></td>
        ${r.by.map((n) => `<td class="num">${fmt(n)}</td>`).join("")}${showOther ? `<td class="num">${fmt(r.other)}</td>` : ""}</tr>`).join("")}
      </tbody><tfoot><tr><td><b>Total today</b></td><td class="num"><b>${fmt(total)}</b></td>
        ${ops.map((_, i) => `<td class="num"><b>${fmt(rows.reduce((s, r) => s + r.by[i], 0))}</b></td>`).join("")}
        ${showOther ? `<td class="num"><b>${fmt(rows.reduce((s, r) => s + r.other, 0))}</b></td>` : ""}</tr></tfoot></table></div></div>`;
  }

  function draw() {
    const isToday = data.date === data.today;
    el.innerHTML = `<div class="section-head"><div><div class="eyebrow">${esc(brand.name)}</div><h2>Dashboard</h2>
        <p>The day's numbers in US Eastern time${isToday ? ` — it is ${esc(data.now.slice(11))} there now` : ""}. Updates live.</p></div>
        <div class="btnrow dash-date"><button class="btn" id="prev" title="Day before">‹</button>
          <label class="field" style="margin:0"><span>Select date</span><input type="date" id="day" value="${esc(data.date)}"></label>
          <button class="btn" id="next" title="Next day">›</button>
          ${isToday ? "" : '<button class="btn" id="today">Today</button>'}
          ${ctx.isAdmin() ? '<button class="btn" id="ops">Operators</button>' : ""}</div></div>
      <div class="dash-cards">${data.cards.map((c) => `<div class="scard ${TONE[c.key] || ""} dash-card"><div class="dash-n">${fmt(c.n)}</div>
        <div class="dash-l">${esc(c.label)}${c.note ? `<div class="muted">${esc(c.note)}</div>` : ""}</div></div>`).join("")}</div>
      <div class="dash-cards dash-counters">${data.counters.map((c) => `<div class="scard neutral dash-card" title="${esc(c.note)}"><div class="dash-n">${fmt(c.n)}</div>
        <div class="dash-l">${esc(c.label)}<div class="muted">${esc(c.note)}</div></div></div>`).join("")}</div>
      <div class="dash-legend-head"><h3>Rows color legend</h3><span class="muted">Always refer to the row color in All Orders to understand the status of an order and take the appropriate action.</span></div>
      <div class="dash-cards dash-legend">${LEGEND.map(([name, hex, text], i) => `<a class="legend-card" href="#orders?color=${encodeURIComponent(hex)}" title="Show the ${esc(name)} orders in All Orders" style="--lg:${hex};--lg-fg:${textOn(hex)}"><div class="legend-title"><span class="legend-n">${i + 1}</span>${esc(name)}<span class="legend-count" title="Rows with this color right now">${fmt((data.colors || {})[hex] || 0)}</span></div>
        <div class="legend-text">${esc(text)}</div></a>`).join("")}</div>
      <div class="dash-tables dash-two">
        ${table("All Orders", data.orders, data.operators, data.orders_total, "Shipped to customer, by the hour")}
        ${table("Store Returns", data.returns, data.operators, data.returns_total, "Shipped to Amazon, by the hour")}
        ${table("Stock Sorting", data.sorting, data.operators, data.sorting_total, "Stock no. put on a stock item, by the hour")}
      </div>`;
  }

  async function load() {
    const q = day ? "?date=" + encodeURIComponent(day) : "";
    data = await api("/api/dashboard" + q);
    day = data.date;
    draw();
  }

  async function editOperators() {
    const ops = data.operators_list;
    let team = [];
    try { team = (await api("/api/team")).items.map((u) => u.name); } catch { /* the list is only a hint */ }
    const r = await dialog({
      title: "Operators",
      body: `<p class="muted" style="margin-top:0">Each operator is a column in the hourly tables. The “Updated by” column in All Orders holds the name of the operator who scanned the package, and the tables count by it. Put that name for each operator, one per line (an e-mail address works too if that is what is in the column). Anything else is counted under Others.${team.length ? `<br>Names on your team: <b>${team.map(esc).join(", ")}</b>` : ""}</p>
        ${[0, 1, 2, 3].map((i) => `<div class="op-edit"><label class="field"><span>Operator ${i + 1} — name</span><input name="label${i}" value="${esc(ops[i]?.label || "")}"></label>
          <label class="field"><span>Name(s) in “Updated by”</span><textarea name="match${i}" rows="2">${esc((ops[i]?.match || []).join("\n"))}</textarea></label></div>`).join("")}`,
      actions: [["Cancel", "close"], ["Save", "ok", "primary"]],
    });
    if (r.value !== "ok") return;
    const f = new FormData(r.el.querySelector("form"));
    const operators = [0, 1, 2, 3].map((i) => ({ label: f.get("label" + i), match: String(f.get("match" + i)).split(/[\n,;]+/) }));
    try {
      await api("/api/dashboard/operators", { operators });
      await load();
      toast("Operators saved.");
    } catch (err) {
      toast(err.message, "bad");
    }
  }

  el.onchange = (e) => {
    if (e.target.id === "day" && e.target.value) { day = e.target.value; load().catch((x) => toast(x.message, "bad")); }
  };
  el.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "prev") day = shift(-1);
    else if (b.id === "next") day = shift(1);
    else if (b.id === "today") day = "";
    else if (b.id === "ops") return editOperators();
    else return;
    load().catch((x) => toast(x.message, "bad"));
  };

  // live: look at the app's change counter every 2 seconds and redraw as soon as anything changed (a scan, a tick, a sync)
  await load();
  mountChat(); // the floating Work Log chat
  let knownV = (await api("/api/version")).v;
  clearInterval(window.__dashTimer);
  window.__dashTimer = setInterval(async () => {
    if (location.hash.split("?")[0] !== "#dashboard" || !$("#day")) return clearInterval(window.__dashTimer);
    if (document.hidden) return;
    try {
      const { v } = await api("/api/version");
      if (v !== knownV) { knownV = v; await load(); }
      else if (data.date === data.today) { // the clock moves on even when the data does not
        const now = new Date(Date.now() - tzEastern.off * 60000).toISOString().slice(0, 16).replace("T", " ");
        if (now.slice(0, 10) !== data.today) await load();
        else if (now !== data.now) { data.now = now; draw(); }
      }
    } catch { /* offline for a moment */ }
  }, 2000);
  // coming back to this browser tab: refresh, but only while the Dashboard is still the page on screen
  const onVisible = () => {
    if (location.hash.split("?")[0] !== "#dashboard" || !$("#day")) return document.removeEventListener("visibilitychange", onVisible);
    if (!document.hidden) load().catch(() => {});
  };
  document.removeEventListener("visibilitychange", window.__dashVisible);
  window.__dashVisible = onVisible;
  document.addEventListener("visibilitychange", onVisible);
}
