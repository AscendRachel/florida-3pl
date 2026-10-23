// App shell: who is signed in, navigation, and the view router. Add the next tabs to VIEWS.
import { $, api, dialog, esc, store, toast, tzEastern } from "./util.js";

const VIEWS = {
  dashboard: { label: "Dashboard", mod: "./v-dashboard.js" },
  scan: { label: "Scan", mod: "./v-scan.js" },
  orders: { label: "All Orders", mod: "./v-orders.js" },
  returns: { label: "Returns", mod: "./v-returns.js" },
  import: { label: "Import", mod: "./v-import.js", admin: true },
  team: { label: "Team", mod: "./v-team.js", admin: true },
};
const ctx = { me: null, isAdmin: () => ctx.me?.role === "admin" };
const allowed = (k) => VIEWS[k] && (!VIEWS[k].admin || ctx.isAdmin());

export function route() {
  const [name, ...rest] = (location.hash || "#" + store.get("gt_last_view", "dashboard")).slice(1).split("?");
  return { name: allowed(name) ? name : "dashboard", params: new URLSearchParams(rest.join("?")) };
}

function renderNav() {
  const cur = route().name;
  $("#tabs").innerHTML = Object.entries(VIEWS)
    .filter(([k]) => allowed(k))
    .map(([k, v]) => `<a class="tab" href="#${k}" ${cur === k ? 'aria-current="page"' : ""}>${v.label}</a>`)
    .join("");
  const me = ctx.me;
  $("#me").innerHTML = me
    ? `<span><b>${esc(me.name)}</b> · ${me.role === "admin" ? "Admin" : "Member"}</span>
       <button class="btn small" id="themeBtn" title="Switch light/dark">◐</button>
       <button class="btn small" id="pwBtn">Password</button><button class="btn small" id="outBtn">Sign out</button>`
    : "";
}

document.addEventListener("click", async (e) => {
  const t = e.target.closest("#themeBtn, #pwBtn, #outBtn");
  if (!t) return;
  if (t.id === "themeBtn") {
    const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "light" : "dark";
    store.set("gt_theme", document.documentElement.dataset.theme);
  } else if (t.id === "outBtn") {
    await api("/api/logout", {});
    location.href = "/login";
  } else {
    const r = await dialog({
      title: "Change your password",
      body: `<label class="field"><span>Current password</span><input type="password" name="cur" autocomplete="current-password" required></label>
             <label class="field"><span>New password (8+ characters)</span><input type="password" name="new" autocomplete="new-password" minlength="8" required></label>`,
      actions: [["Cancel", "close"], ["Change password", "ok", "primary"]],
    });
    if (r.value !== "ok") return;
    try {
      const f = new FormData(r.el.querySelector("form"));
      await api("/api/me/password", { current: f.get("cur"), new: f.get("new") });
      toast("Password changed.");
    } catch (err) {
      toast(err.message, "bad");
    }
  }
});

// A new version of the app: the page notices by itself and offers to reload (and reloads when you change tab).
let loadedBuild = null, newVersion = false;
async function checkBuild() {
  try {
    const { build } = await (await fetch("/api/build", { cache: "no-store" })).json();
    if (loadedBuild === null) {
      loadedBuild = build;
      document.body.insertAdjacentHTML("beforeend", `<div class="build-tag" title="The version of the app this page is running">version ${build.slice(0, 6)}</div>`);
    }
    else if (build !== loadedBuild && !newVersion) {
      newVersion = true;
      document.body.insertAdjacentHTML("beforeend", `<div class="update-bar" role="status">A new version of the app is ready. <button class="btn small primary" id="reloadNow">Reload now</button></div>`);
      $("#reloadNow").onclick = () => location.reload();
    }
  } catch { /* the server may be restarting; try again at the next check */ }
}
setInterval(checkBuild, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkBuild(); });
checkBuild();

let token = 0;
async function show() {
  if (newVersion) return location.reload(); // moving to another tab is a natural moment to pick up the new version
  const my = ++token;
  const { name, params } = route();
  store.set("gt_last_view", name);
  renderNav();
  const main = $("#main");
  main.innerHTML = `<div class="empty">Loading…</div>`;
  for (const h of ["onclick", "onchange", "oninput", "onsubmit"]) main[h] = null;
  document.querySelectorAll(".drawer, .scrim").forEach((n) => n.remove());
  try {
    const mod = await import(VIEWS[name].mod);
    if (my !== token) return;
    await mod.mount(main, params, ctx);
  } catch (err) {
    if (my !== token) return;
    main.innerHTML = `<div class="banner bad">Something went wrong: ${esc(err.message)}. If the server window was closed, start it again and refresh.</div>`;
  }
}

window.addEventListener("hashchange", show);
(async () => {
  try {
    ctx.me = await api("/api/me");
    tzEastern.off = ctx.me.tz_offset_min ?? 300;
  } catch (err) {
    $("#main").innerHTML = `<div class="banner bad">Can't reach the server (${esc(err.message)}).</div>`;
    return;
  }
  show();
})();
