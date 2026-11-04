// Team: who can sign in (admins only).
import { applyBranding } from "./branding.js";
import { api, brand, confirmBox, dialog, esc, toast } from "./util.js";

const TAB_LIST = [["dashboard", "Dashboard"], ["scan", "Scan"], ["cards", "Order Cards"], ["orders", "All Orders"], ["returns", "Returns"], ["materials", "Materials"]];
const tabBoxes = (on) => `<fieldset class="tabpick" style="border:1px solid var(--line,#ccc);border-radius:8px;padding:8px 12px;margin:0 0 10px"><legend>Tabs this person can see</legend>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 14px">${TAB_LIST.map(([k, l]) => `<label class="check"><input type="checkbox" name="tab" value="${k}" ${!on || on.includes(k) ? "checked" : ""}> ${l}</label>`).join("")}</div></fieldset>`;
const ROLE_NAME = { admin: "Admin", warehouse: "Warehouse", member: "Member" };
const roleOptions = (cur) => Object.entries(ROLE_NAME).map(([k, l]) => `<option value="${k}"${k === cur ? " selected" : ""}>${l}</option>`).join("");
const pickedTabs = (form) => new FormData(form).getAll("tab");

export async function mount(el, params, ctx) {
  const draw = async () => {
    const rows = (await api("/api/team")).items;
    const me = ctx.me.username;
    el.innerHTML = `<div class="section-head"><div><div class="eyebrow">${esc(brand.name)}</div><h2>Team</h2>
        <p>Everyone who can sign in. <b>Warehouse</b> and <b>Members</b> can scan, edit orders, and work the returns (you choose which tabs each person sees). <b>Admins</b> can also import orders, change dropdown choices and sync settings, and manage the team.</p></div>
        <div class="btnrow"><button class="btn" id="brandBtn">App name &amp; logo</button><button class="btn primary" id="add">Add team member</button></div></div>
      <div class="panel"><div class="tablewrap"><table style="min-width:620px"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Tabs</th><th>Added</th><th></th></tr></thead><tbody>
      ${rows.map((u) => `<tr><td><b>${esc(u.name)}</b>${u.username === me ? ` <span class="muted">(you)</span>` : ""}</td><td class="mono">${esc(u.username)}</td>
        <td>${u.role === "admin" ? '<span class="pill s-ok">Admin</span>' : esc(ROLE_NAME[u.role] || "Member")}</td>
        <td class="muted">${u.role === "admin" || !u.tabs ? "All" : esc(u.tabs.map((k) => (TAB_LIST.find((t) => t[0] === k) || [k, k])[1]).join(", "))}</td><td class="muted">${esc((u.created_at || "").slice(0, 10))}</td>
        <td class="num">${u.role === "admin" ? "" : `<button class="btn small" data-tabs="${esc(u.username)}" data-have="${esc((u.tabs || []).join(","))}">Tabs</button> `}<button class="btn small" data-reset="${esc(u.username)}">Reset password</button>
          ${u.username === me ? "" : `<button class="btn small" data-role="${esc(u.username)}" data-cur="${esc(u.role)}">Role</button> <button class="btn small danger" data-remove="${esc(u.username)}">Remove</button>`}</td></tr>`).join("")}
      </tbody></table></div></div>
      <p class="hint">Whoever signs in is recorded by name on every scan, tick and edit they make.</p>`;
  };
  el.onclick = async (e) => {
    const t = e.target;
    try {
      if (t.closest("#add")) {
        const r = await dialog({
          title: "Add team member",
          body: `<label class="field"><span>Name</span><input name="name" required></label><label class="field"><span>Username</span><input name="username" required autocapitalize="off" autocomplete="off"></label>
                 <label class="field"><span>Temporary password (8+ characters)</span><input name="password" minlength="8" required autocomplete="new-password"></label>
                 <label class="field"><span>Role</span><select name="role">${roleOptions("member")}</select></label>
                 ${tabBoxes(null)}<p class="hint">The tab choice applies to members. Admins always see every tab.</p>`,
          actions: [["Cancel", "close"], ["Add", "ok", "primary"]],
        });
        if (r.value === "ok") {
          const form = r.el.querySelector("form"), body = Object.fromEntries(new FormData(form));
          delete body.tab;
          if (body.role !== "admin") body.tabs = pickedTabs(form);
          await api("/api/team/add", body);
          toast("Team member added. Share the password privately.");
          draw();
        }
      }
      if (t.closest("#brandBtn")) {
        const r = await dialog({
          title: "App name & logo",
          body: `<label class="field"><span>App name (shown at the top and in the browser tab)</span><input name="name" value="${esc(brand.name)}" maxlength="40" required></label>
            <div class="op-edit"><label class="field"><span>Initials (up to 3 letters, used when there is no logo)</span><input name="initials" value="${esc(brand.initials)}" maxlength="3"></label>
            <label class="field"><span>Colour</span><input type="color" name="color" value="${esc(brand.color)}" style="height:38px;width:100%;padding:2px"></label></div>
            <label class="field"><span>Logo (PNG, JPG, GIF or WebP, up to 1.5 MB; square works best)</span><input type="file" name="logo" accept="image/png,image/jpeg,image/gif,image/webp"></label>
            ${brand.logo ? `<label class="check"><input type="checkbox" name="remove_logo"> Remove the current logo (<img alt="" src="/branding/logo?v=${brand.v}" style="height:20px;vertical-align:middle">) and show the initials</label>` : ""}`,
          actions: [["Cancel", "close"], ["Save", "ok", "primary"]],
        });
        if (r.value === "ok") {
          const f = new FormData(r.el.querySelector("form")), file = f.get("logo");
          const body = { name: f.get("name"), initials: f.get("initials"), color: f.get("color"), remove_logo: !!f.get("remove_logo") };
          if (file && file.size) {
            if (file.size > 1_500_000) throw new Error("The logo can be up to 1.5 MB.");
            body.logo = await new Promise((ok, no) => { const rd = new FileReader(); rd.onload = () => ok(rd.result); rd.onerror = () => no(new Error("That image could not be read.")); rd.readAsDataURL(file); });
          }
          applyBranding(await api("/api/branding", body));
          toast("Saved. Everyone sees the new name and logo the next time their page loads.");
          draw();
        }
      }
      const rs = t.closest("[data-reset]");
      if (rs) {
        const r = await dialog({ title: "Reset password for " + rs.dataset.reset, body: `<label class="field"><span>New password (8+ characters)</span><input name="password" minlength="8" required autocomplete="new-password"></label><p class="hint">They are signed out everywhere and use the new password next time.</p>`, actions: [["Cancel", "close"], ["Reset", "ok", "primary"]] });
        if (r.value === "ok") {
          await api("/api/team/reset", { username: rs.dataset.reset, password: new FormData(r.el.querySelector("form")).get("password") });
          toast("Password reset.");
        }
      }
      const tb = t.closest("[data-tabs]");
      if (tb) {
        const r = await dialog({ title: "Tabs for " + tb.dataset.tabs, body: `${tabBoxes(tb.dataset.have ? tb.dataset.have.split(",") : null)}<p class="hint">They only see the ticked tabs. Takes effect the next time their page loads.</p>`, actions: [["Cancel", "close"], ["Save", "ok", "primary"]] });
        if (r.value === "ok") {
          await api("/api/team/tabs", { username: tb.dataset.tabs, tabs: pickedTabs(r.el.querySelector("form")) });
          toast("Tabs saved.");
          draw();
        }
      }
      const ro = t.closest("[data-role]");
      if (ro) {
        const r = await dialog({ title: "Role for " + ro.dataset.role, body: `<label class="field"><span>Role</span><select name="role">${roleOptions(ro.dataset.cur)}</select></label><p class="hint">Admins see every tab and can manage the team. Warehouse and Member only see the tabs you give them (the Tabs button).</p>`, actions: [["Cancel", "close"], ["Save", "ok", "primary"]] });
        if (r.value === "ok") {
          const to = new FormData(r.el.querySelector("form")).get("role");
          await api("/api/team/role", { username: ro.dataset.role, role: to });
          toast(`${ro.dataset.role} is now ${ROLE_NAME[to] || to}.`);
          draw();
        }
      }
      const rm = t.closest("[data-remove]");
      if (rm && (await confirmBox("Remove " + rm.dataset.remove + "?", "They will not be able to sign in any more. What they scanned and edited stays in the records.", "Remove"))) {
        await api("/api/team/remove", { username: rm.dataset.remove });
        draw();
      }
    } catch (err) { toast(err.message, "bad"); }
  };
  await draw();
}
