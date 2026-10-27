// The app's name, initials, colour and logo (set by an admin in the Team tab). Used by the app and the sign-in page.
import { brand } from "./util.js";

const initialsIcon = (b) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='${b.color}'/><text x='16' y='21' font-size='${b.initials.length > 2 ? 11 : 14}' font-weight='700' text-anchor='middle' fill='white' font-family='sans-serif'>${b.initials.replace(/[<&]/g, "")}</text></svg>`)}`;
const inkFor = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#08130d" : "#ffffff";
};

export function applyBranding(b, titlePrefix = "") {
  Object.assign(brand, b);
  document.title = titlePrefix + b.name;
  const ink = inkFor(b.color), dark = `color-mix(in srgb, ${b.color} 70%, white)`;
  let st = document.getElementById("brandcss");
  if (!st) { st = document.createElement("style"); st.id = "brandcss"; document.head.append(st); }
  const light = `--brand:${b.color};--brand-ink:${ink};--brand-soft:color-mix(in srgb, ${b.color} 14%, var(--panel))`;
  const night = `--brand:${dark};--brand-ink:#08130d;--brand-soft:color-mix(in srgb, ${b.color} 22%, var(--panel))`;
  st.textContent = `:root{${light}}@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${night}}}:root[data-theme="dark"]{${night}}`;
  const src = b.logo ? `/branding/logo?v=${b.v}` : initialsIcon(b);
  let ic = document.querySelector('link[rel="icon"]');
  if (!ic) { ic = document.createElement("link"); ic.rel = "icon"; document.head.append(ic); }
  ic.href = src;
  document.querySelectorAll(".brand .logo").forEach((el) => {
    el.classList.toggle("logo-img", !!b.logo);
    if (b.logo) el.innerHTML = `<img alt="" src="${src}">`;
    else el.textContent = b.initials;
  });
  document.querySelectorAll(".brand h1[data-brand]").forEach((el) => { el.textContent = b.name; });
}

export async function loadBranding(titlePrefix = "") {
  try { applyBranding(await (await fetch("/api/branding", { cache: "no-store" })).json(), titlePrefix); } catch { /* the built-in name stays */ }
}
