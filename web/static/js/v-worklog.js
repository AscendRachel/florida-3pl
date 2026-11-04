// Work Log (admins): everything the team wrote in the chat bubble on the Dashboard, with who, the date and the time.
import { showDay, showTime } from "./chat-bubble.js";
import { $, api, brand, debounce, esc, fmt, toast } from "./util.js";

export async function mount(el, params, ctx) {
  const st = { date: "", user: "", q: "", all: false };
  let data = null, known = null;

  el.innerHTML = `<div class="section-head"><div><div class="eyebrow">${esc(brand.name)}</div><h2>Work Log</h2>
      <p>What the team wrote in the chat bubble on the Dashboard. Newest first. Times are US Eastern.</p></div></div>
    <div class="panel wl-bar">
      <label class="field"><span>Date</span><input type="date" id="wlDate"></label>
      <button class="btn" id="wlToday">Today</button>
      <button class="btn" id="wlAll">All dates</button>
      <label class="field"><span>Person</span><select id="wlUser"><option value="">Everyone</option></select></label>
      <label class="field wl-search"><span>Search</span><input type="search" id="wlQ" placeholder="Words in a message or a name" autocomplete="off"></label>
    </div>
    <div class="panel"><div class="wl-count muted" id="wlCount"></div><div class="tablewrap" style="max-height:none"><table class="wl-table"><thead><tr><th>Date</th><th>Time</th><th>Person</th><th>Message</th></tr></thead><tbody id="wlRows"></tbody></table></div></div>`;

  const query = () => "/api/worklog?" + new URLSearchParams({ date: st.all ? "" : st.date, user: st.user, q: st.q }).toString();
  function draw() {
    $("#wlDate").value = st.all ? "" : st.date;
    $("#wlAll").classList.toggle("primary", st.all);
    $("#wlToday").classList.toggle("primary", !st.all && st.date === data.today);
    const sel = $("#wlUser");
    sel.innerHTML = `<option value="">Everyone</option>` + data.people.map((p) => `<option value="${esc(p.username)}"${p.username === st.user ? " selected" : ""}>${esc(p.name || p.username)}</option>`).join("");
    const n = data.total, shown = data.items.length;
    $("#wlCount").textContent = n ? `${fmt(n)} message${n === 1 ? "" : "s"}${shown < n ? ` (showing the newest ${fmt(shown)})` : ""}` : "";
    $("#wlRows").innerHTML = data.items.length
      ? data.items.map((m) => `<tr><td class="wl-date">${esc(showDay(m.at))}</td><td class="wl-time">${esc(showTime(m.at))}</td><td class="wl-who"><b>${esc(m.name || m.username)}</b></td><td class="wl-text">${esc(m.text).replace(/\n/g, "<br>")}</td></tr>`).join("")
      : `<tr><td colspan="4" class="empty">${st.q || st.user || st.all ? "No messages match." : "No messages on this date."}</td></tr>`;
  }
  async function load() {
    data = await api(query());
    if (!st.date) st.date = data.today;
    draw();
  }
  const reload = () => load().catch((e) => toast(e.message, "bad"));

  el.onchange = (e) => {
    if (e.target.id === "wlDate") { st.date = e.target.value || st.date; st.all = false; reload(); }
    else if (e.target.id === "wlUser") { st.user = e.target.value; reload(); }
  };
  el.oninput = debounce((e) => { if (e.target.id === "wlQ") { st.q = e.target.value.trim(); reload(); } }, 250);
  el.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "wlToday") { st.date = data.today; st.all = false; reload(); }
    else if (b.id === "wlAll") { st.all = !st.all; reload(); }
  };

  await load();
  const timer = setInterval(async () => {
    if (!el.isConnected || location.hash.split("?")[0] !== "#worklog") return clearInterval(timer);
    if (document.hidden) return;
    try {
      const { v } = await api("/api/version");
      if (known === null) known = v;
      else if (v !== known) { known = v; await load(); }
    } catch { /* offline for a moment */ }
  }, 3000);
}
