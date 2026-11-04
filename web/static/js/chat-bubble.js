// The floating Work Log chat bubble on the Dashboard: a round button you can drag anywhere; click it to open a small chat.
// What a person writes is saved in the Work Log (admins read it there). The bubble shows only that person's own messages of today.
import { api, esc, store, toast } from "./util.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-03-06 15:04:05" -> "3:04 PM" / "Mar 6, 2026" (the app's clock is US Eastern; the text is already in it)
export const showTime = (at) => {
  const h = +String(at).slice(11, 13), m = String(at).slice(14, 16);
  return `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
};
export const showDay = (at) => `${MONTHS[+String(at).slice(5, 7) - 1] || ""} ${+String(at).slice(8, 10)}, ${String(at).slice(0, 4)}`;

const SIZE = 56, PANEL_W = 340, PANEL_H = 440, KEY = "gt_chat_pos";
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const readPos = () => { try { const p = JSON.parse(store.get(KEY, "") || "null"); return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null; } catch { return null; } };

export function mountChat() {
  document.getElementById("chatBubble")?.remove();
  document.getElementById("chatPanel")?.remove();
  let open = false, items = [], day = "";

  const bubble = document.createElement("button");
  bubble.id = "chatBubble";
  bubble.type = "button";
  bubble.title = "Work Log chat. Click to write, drag to move.";
  bubble.setAttribute("aria-label", "Work Log chat");
  bubble.innerHTML = `<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 3.5V17H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M7.5 9.5h9M7.5 12.5h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

  const panel = document.createElement("section");
  panel.id = "chatPanel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Work Log chat");
  panel.innerHTML = `<header class="cp-head"><div><b>Work Log</b><span>Write what you are working on. Admins can read it.</span></div><button type="button" class="cp-x" aria-label="Close chat">✕</button></header>
    <div class="cp-list" id="cpList"></div>
    <form class="cp-form" id="cpForm"><textarea id="cpText" rows="1" maxlength="1000" placeholder="Type a message…" autocomplete="off"></textarea><button type="submit" class="btn primary" id="cpSend">Send</button></form>
    <div class="cp-hint">Enter sends · Shift+Enter makes a new line</div>`;
  document.body.append(bubble, panel);

  // ---- where the bubble sits (kept in the browser), and the panel next to it
  let pos = readPos() || { x: innerWidth - SIZE - 24, y: innerHeight - SIZE - 24 };
  const place = () => {
    pos = { x: clamp(pos.x, 8, Math.max(8, innerWidth - SIZE - 8)), y: clamp(pos.y, 8, Math.max(8, innerHeight - SIZE - 8)) };
    bubble.style.left = pos.x + "px"; bubble.style.top = pos.y + "px";
    const w = Math.min(PANEL_W, innerWidth - 16), h = Math.min(PANEL_H, innerHeight - 16);
    panel.style.width = w + "px"; panel.style.height = h + "px";
    // open towards the middle of the screen, so the panel is never cut off
    const left = pos.x + SIZE / 2 > innerWidth / 2 ? pos.x + SIZE - w : pos.x;
    const top = pos.y + SIZE / 2 > innerHeight / 2 ? pos.y - h - 10 : pos.y + SIZE + 10;
    panel.style.left = clamp(left, 8, innerWidth - w - 8) + "px";
    panel.style.top = clamp(top, 8, innerHeight - h - 8) + "px";
  };
  const save = () => store.set(KEY, JSON.stringify(pos));
  place();
  const onResize = () => place();
  addEventListener("resize", onResize);

  // ---- dragging: the bubble moves with the pointer; a press that hardly moved is a click
  let drag = null;
  bubble.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y, moved: false };
    bubble.setPointerCapture(e.pointerId);
  });
  bubble.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    bubble.classList.add("moving");
    pos = { x: drag.ox + dx, y: drag.oy + dy };
    place();
  });
  const endDrag = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    bubble.classList.remove("moving");
    if (moved) save(); else toggle();
  };
  bubble.addEventListener("pointerup", endDrag);
  bubble.addEventListener("pointercancel", () => { drag = null; bubble.classList.remove("moving"); });
  bubble.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });

  // ---- the chat
  const list = panel.querySelector("#cpList"), text = panel.querySelector("#cpText");
  function draw() {
    if (!items.length) {
      list.innerHTML = `<div class="cp-empty"><b>No messages yet today.</b><p>Write what you are doing, for example “Sorting stock 93” or “Packed 12 orders”. Each message is saved with the date and time.</p></div>`;
      return;
    }
    list.innerHTML = items.map((m) => `<div class="cp-msg"><div class="cp-bub">${esc(m.text).replace(/\n/g, "<br>")}</div><div class="cp-time">${esc(showTime(m.at))}</div></div>`).join("");
    list.scrollTop = list.scrollHeight;
  }
  async function load() {
    try {
      const r = await api("/api/chat");
      items = r.items; day = r.today;
      draw();
    } catch (e) { list.innerHTML = `<div class="cp-empty"><b>The chat could not load.</b><p>${esc(e.message)}</p></div>`; }
  }
  function toggle(force) {
    open = force ?? !open;
    panel.hidden = !open;
    bubble.classList.toggle("on", open);
    if (open) { place(); load(); setTimeout(() => text.focus(), 0); }
  }
  async function send() {
    const v = text.value.trim();
    if (!v) return;
    const btn = panel.querySelector("#cpSend");
    btn.disabled = true;
    try {
      const r = await api("/api/chat/send", { text: v });
      text.value = ""; grow();
      if (!day || r.item.at.slice(0, 10) === day) items.push(r.item); else { items = [r.item]; day = r.item.at.slice(0, 10); }
      draw();
    } catch (e) { toast(e.message, "bad"); }
    btn.disabled = false;
    text.focus();
  }
  const grow = () => { text.style.height = "auto"; text.style.height = Math.min(text.scrollHeight, 110) + "px"; };
  text.addEventListener("input", grow);
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  panel.querySelector("#cpForm").addEventListener("submit", (e) => { e.preventDefault(); send(); });
  panel.querySelector(".cp-x").addEventListener("click", () => toggle(false));
  panel.addEventListener("keydown", (e) => { if (e.key === "Escape") toggle(false); });

  // the bubble belongs to the Dashboard: it goes away when another tab opens
  const timer = setInterval(() => {
    if (document.querySelector("#main #day")) return;
    clearInterval(timer);
    removeEventListener("resize", onResize);
    bubble.remove(); panel.remove();
  }, 1000);
}
