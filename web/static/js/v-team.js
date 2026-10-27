// Team: who can sign in (admins only).
import { applyBranding } from "./branding.js";
import { api, brand, confirmBox, dialog, esc, toast } from "./util.js";

export async function mount(el, params, ctx) {
  const draw = async () => {
    const rows = (await api("/api/team")).items;
    const me = ctx.me.username;
    el.innerHTML = `<div class="section-head"><div><div class="eyebrow">${esc(brand.name)}</div><h2>Team</h2>
        <p>Everyone who can sign in. <b>Members</b> can scan, edit orders, and work the returns. <b>Admins</b> can also import orders, change dropdown choices and sync settings, and manage the team.</p></div>
        <div class="btnrow"><button class="btn" id="brandBtn">App name &amp; logo</button><button class="btn primary" id="add">Add team member</button></div></div>
      <div class="panel"><div class="tablewrap"><table style="min-width:620px"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Added</th><th></th></tr></thead><tbody>
      ${rows.map((u) => `<tr><td><b>${esc(u.name)}</b>${u.username === me ? ` <span class="muted">(you)</span>` : ""}</td><td class="mono">${esc(u.username)}</td>
        <td>${u.role === "admin" ? '<span class="pill s-ok">Admin</span>' : "Member"}</td><td class="muted">${esc((u.created_at || "").slice(0, 10))}</td>
        <td class="num"><button class="btn small" data-reset="${esc(u.username)}">Reset password</button>
          ${u.username === me ? "" : `<button class="btn small" data-role="${esc(u.username)}" data-to="${u.role === "admin" ? "member" : "admin"}">Make ${u.role === "admin" ? "member" : "admin"}</button> <button class="btn small danger" data-remove="${esc(u.username)}">Remove</button>`}</td></tr>`).join("")}
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
                 <label class="field"><span>Role</span><select name="role"><option value="member">Member</option><option value="admin">Admin</option></select></label>`,
          actions: [["Cancel", "close"], ["Add", "ok", "primary"]],
        });
        if (r.value === "ok") {
          await api("/api/team/add", Object.fromEntries(new FormData(r.el.querySelector("form"))));
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
      const ro = t.closest("[data-role]");
      if (ro) {
        await api("/api/team/role", { username: ro.dataset.role, role: ro.dataset.to });
        toast(`${ro.dataset.role} is now ${ro.dataset.to === "admin" ? "an admin" : "a member"}.`);
        draw();
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
