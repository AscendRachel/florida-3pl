// Protect a column or some rows (admins), like "Protect range" in Google Sheets: who may type in them.
import { api, dialog, esc, toast } from "./util.js";

// The reason a person may not edit something locked with `lock`, or "" when they may.
export function lockReason(lock, me, what) {
  if (!lock) return "";
  const admin = me.role === "admin";
  if (lock.mode === "admins") return admin ? "" : `🔒 This ${what} is protected: only admins can edit it.`;
  if (lock.mode === "people") return admin || (lock.users || []).includes(me.username) ? "" : `🔒 This ${what} is protected: only admins and the people an admin chose can edit it.`;
  return `🔒 This ${what} is protected: nobody can type in it.${lock.note ? " " + lock.note : ""}`;
}

export const lockTip = (lock) => {
  if (!lock) return "";
  const who = lock.mode === "admins" ? "only admins can edit" : lock.mode === "people" ? `admins and ${lock.users.length ? lock.users.join(", ") : "nobody else"} can edit` : "nobody can type in it";
  return `Protected by ${lock.by}: ${who}.${lock.note ? " " + lock.note : ""}`;
};

// sheet: "orders" | "returns"; kind: "col" | "row"; targets: column keys, row numbers or return ids; what: "Brand" or "3 rows"
// Resolves true when something was saved.
export async function protectDialog({ sheet, kind, targets, what, current }) {
  let team = [];
  try { team = (await api("/api/team")).items; } catch { /* the people choice is then empty */ }
  const l = current || { mode: "", users: [], note: "" };
  const opt = (v, label, hint) => `<label class="check" style="display:block;margin:8px 0"><input type="radio" name="mode" value="${v}" ${l.mode === v ? "checked" : ""}> <b>${label}</b><div class="hint" style="margin-left:24px">${hint}</div></label>`;
  const r = await dialog({
    title: `Protect ${what}`,
    body: `<p class="muted">Choose who may type in ${kind === "col" ? "this column" : "these rows"}. Admins always keep control of the protection. Imports, scans and the returns sync still fill them.</p>
      ${opt("", "Not protected", "Everyone can edit.")}
      ${opt("admins", "Only admins", "Members can see it but cannot type in it.")}
      ${opt("people", "Admins and the people I choose", "Pick the team members below.")}
      <div id="peopleBox" style="margin:0 0 8px 24px;max-height:140px;overflow:auto">${team.filter((u) => u.role !== "admin").map((u) => `<label class="check" style="display:block"><input type="checkbox" name="u" value="${esc(u.username)}" ${(l.users || []).includes(u.username) ? "checked" : ""}> ${esc(u.name)} <span class="muted mono">${esc(u.username)}</span></label>`).join("") || `<span class="muted">There are no members yet. Add them in the Team tab.</span>`}</div>
      ${opt("nobody", "Nobody", "Nobody can type in it, not even admins, until the protection is changed.")}
      <label class="field"><span>Note (shown to people who are blocked)</span><input name="note" maxlength="200" value="${esc(l.note || "")}"></label>`,
    actions: [["Cancel", "close"], ["Save protection", "ok", "primary"]],
  });
  if (r.value !== "ok") return false;
  const f = new FormData(r.el.querySelector("form"));
  try {
    await api("/api/locks/set", { sheet, kind, targets, mode: f.get("mode") || "", users: f.getAll("u"), note: f.get("note") });
    toast(f.get("mode") ? `Protected ${what}.` : `${what[0].toUpperCase()}${what.slice(1)} is no longer protected.`);
    return true;
  } catch (e) {
    toast(e.message, "bad");
    return false;
  }
}

// Rename a column (admins). Resolves the new name, "" to put the original name back, or null when cancelled.
export async function renameDialog(current, original) {
  const r = await dialog({
    title: "Rename column",
    body: `<label class="field"><span>New name</span><input name="label" value="${esc(current)}" maxlength="60" autocomplete="off"></label>
      <p class="hint">Only the name changes. The data, filters, protection and history stay as they are. The original name is “${esc(original)}”; clear the box to put it back.</p>`,
    actions: [["Cancel", "close"], ["Rename", "ok", "primary"]],
  });
  if (r.value !== "ok") return null;
  const v = String(new FormData(r.el.querySelector("form")).get("label") || "").trim();
  return v === original ? "" : v;
}
