// Scan: the 3PL scans the TBA number on each package; the app says what to do with every item in it.
import { $, api, brand, dialog, esc, fmt, store, toast } from "./util.js";
import { labelPages, printPages, printTest } from "./print.js";

const PILL = { ok: "s-ok", warn: "s-warn", crit: "s-crit", violet: "s-violet", info: "s-info", neutral: "s-neutral" };
const OUTCOME_LABEL = {
  complete: ["Complete: shipped", "ok"], hold: ["Hold", "warn"], overdue: ["Overdue hold", "crit"], return: ["Return to Amazon", "violet"],
  voided: ["Voided / refunded", "crit"], pnr: ["Package not received", "crit"], processed: ["Already processed", "warn"],
  nolabel: ["No label found", "crit"], count: ["Counting items", "info"], notfound: ["Not found", "crit"], pnr_marked: ["Marked not received", "crit"], pnr_cleared: ["Flag removed", "neutral"], printed: ["Label printed", "ok"], printed_overdue: ["Overdue shipped", "warn"],
};

let audio;
function beep(kind) {
  try {
    audio ||= new AudioContext();
    const tones = { ok: [[880, 0.12]], warn: [[520, 0.12], [520, 0.12]], bad: [[220, 0.45]] }[kind] || [];
    let t = audio.currentTime;
    for (const [hz, len] of tones) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = hz; g.gain.value = 0.15;
      o.connect(g); g.connect(audio.destination);
      o.start(t); o.stop(t + len);
      t += len + 0.08;
    }
  } catch { /* no sound is fine */ }
}

const time = (s) => (s || "").slice(11, 16);

export async function mount(el, params, ctx) {
  let practice = store.get("gt_scan_practice", "") === "1";
  let sound = store.get("gt_scan_sound", "1") !== "0";
  const operator = ctx.me.name; // whoever is signed in; the server records the scan under this account
  let queue = Promise.resolve(); // labels print one after the other

  el.innerHTML = `<div class="section-head"><div><div class="eyebrow">${esc(brand.name)}</div><h2>Scan</h2>
      <p>Scan the TBA number on each package (or type it and press Enter). The app shows every item in the package and what to do with it.</p></div></div>
    <div class="panel scanbar">
      <div class="signedas"><span class="muted">Scanning as</span><b>${esc(operator)}</b></div>
      <label class="check"><input type="checkbox" id="practice"> Practice mode</label>
      <label class="check"><input type="checkbox" id="sound"> Sound</label>
      <button class="btn small" id="testPrint">Print a test label</button>
    </div>
    <details class="panel silent"><summary><b>Print without the print window</b> (recommended for the scanning stations)</summary>
      <ol>
        <li>Right-click the Chrome (or Edge) shortcut you use for this app and choose <b>Properties</b>.</li>
        <li>In <b>Target</b>, add a space and <span class="mono">--kiosk-printing</span> at the very end, for example <span class="mono">"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --kiosk-printing</span>. Click OK.</li>
        <li>Close every Chrome window, then open Chrome from that shortcut.</li>
        <li>Make the label printer the Windows <b>default printer</b> on that PC. Labels now print straight to it with no window. Press <b>Print a test label</b> to check the size and edges.</li>
      </ol>
      <p class="hint">Without this, the browser shows its normal print window once per scan, and the operator presses Enter or Print.</p>
    </details>
    <div class="banner" id="practiceBanner" hidden><b>Practice mode.</b> Scans are checked as usual, but nothing is saved and no label is printed.</div>
    <form id="scanForm" class="scanbox"><input id="scan" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="Scan or type a tracking number, then press Enter"><button class="btn primary" type="submit">Scan</button></form>
    <div id="samples" class="samples" hidden></div>
    <div id="out"></div>
    <div class="two" style="margin-top:22px">
      <div class="panel"><div class="btnrow" style="justify-content:space-between"><h3>On hold</h3><span class="muted" id="holdNote"></span></div><div id="holds"></div></div>
      <div class="panel"><h3 style="margin-bottom:8px">Recent scans</h3><div id="recent"></div></div>
    </div>`;

  const syncChrome = () => {
    $("#practice").checked = practice; $("#sound").checked = sound;
    $("#practiceBanner").hidden = !practice;
    $("#samples").hidden = !practice;
  };
  syncChrome();

  // ---------- results
  const card = (r, i) => {
    const b = r.boxes;
    return `<article class="scard ${r.tone}" data-i="${i}">
      <div class="sc-img">${/^https?:/.test(r.image) ? `<img src="${esc(r.image)}" alt="" referrerpolicy="no-referrer">` : ""}</div>
      <div class="sc-main">
        <div class="sc-top"><span class="pill ${PILL[r.tone]} sc-title">${esc(r.title)}</span>
          ${b ? `<span class="pill s-neutral">Box ${b.received} of ${b.expected}</span>` : ""}${r.items && r.items.qty > 1 ? `<span class="pill s-neutral">Items ${r.items.received} of ${r.items.qty}</span>` : ""}${r.duplicate ? `<span class="pill s-info">Box already counted</span>` : ""}</div>
        <h3>${esc(r.product || "(no product name)")}</h3>
        <div class="muted">${esc([r.brand, r.qty && `Qty ${r.qty}`, r.customer].filter(Boolean).join(" · "))}</div>
        <div class="muted mono">${esc(r.label)} · ${esc(r.store_order)} · ${esc(r.source_order)}</div>
        <p class="sc-msg">${esc(r.message)}</p>
        ${(r.siblings || []).length ? `<div class="banner sc-warn">Another item in this customer order is on hold: ${r.siblings.map((s) => esc(s.label)).join(", ")}</div>` : ""}
        ${r.outcome === "count" ? `<form class="sc-count" data-count="${i}"><label class="field" style="margin:0"><span>Items in this package (the order is for ${r.qty_declared}${r.items_received ? `, ${r.items_received} already received` : ""})</span>
          <input type="number" min="0" max="9999" inputmode="numeric" name="items" value="${r.qty_declared - r.items_received}" required></label>
          <button class="btn primary" type="submit">Confirm count</button></form>` : ""}
        ${r.print ? `<div class="sc-print" id="pr${i}"></div>` : ""}
        ${["pnr", "voided"].includes(r.outcome) ? "" : `<div class="sc-pnr" id="pnr${i}"><button class="btn small danger" data-pnr="${i}">Package not received</button></div>`}
      </div></article>`;
  };

  function show(res) {
    const out = $("#out");
    if (!res.found && res.results.length === 0) {
      out.innerHTML = `<article class="scard crit big"><div class="sc-main"><div class="sc-top"><span class="pill s-crit sc-title">NOT FOUND</span></div>
        <h3>${esc(res.code)}</h3><p class="sc-msg">No order has this tracking number. Check the number and try again.</p></div></article>`;
      if (sound) beep("bad");
      return;
    }
    const tally = {};
    res.results.forEach((r) => (tally[r.title] = (tally[r.title] || 0) + 1));
    out.innerHTML = `<div class="sc-summary"><b>${esc(res.code)}</b> · ${res.results.length} item${res.results.length === 1 ? "" : "s"}: ${Object.entries(tally).map(([t, n]) => `${n} × ${esc(t.toLowerCase())}`).join(" · ")}${res.practice ? " · practice" : ""}</div>
      ${res.results.map(card).join("")}`;
    const worst = res.results.some((r) => r.tone === "crit") ? "bad" : res.results.some((r) => r.tone === "warn") ? "warn" : "ok";
    if (sound) beep(worst);
    const toPrint = res.results.map((r, i) => ({ r, i })).filter(({ r }) => r.print);
    if (toPrint.length) queue = queue.then(() => printBatch(toPrint, res.code));
  }

  const printState = (i, html) => { const n = $("#pr" + i); if (n) n.innerHTML = html; };

  // All the labels of one scan go to the printer as ONE print job, so the browser asks (if it asks at all) only once.
  async function printBatch(items, code, { reprint = false } = {}) {
    const kind = (r) => (r.print === "return" ? "return label" : "label");
    if (practice) {
      items.forEach(({ r, i }) => printState(i, `<span class="muted">Practice mode: the ${kind(r)} is not printed.</span> <button class="btn small" data-preview="${i}">Preview the label</button>`));
      return;
    }
    items.forEach(({ r, i }) => printState(i, `<span class="muted">Getting the ${kind(r)}…</span>`));
    const ready = [];
    await Promise.all(items.map(async (it) => {
      try {
        ready.push({ ...it, pages: await labelPages(`/api/label?rn=${it.r.rn}`) });
      } catch (e) {
        printState(it.i, `<div class="banner bad" style="margin:0 0 6px">PRINT ERROR: ${esc(e.message)}</div><button class="btn small primary" data-retry="${it.i}">Try again</button>`);
        if (sound) beep("bad");
      }
    }));
    if (!ready.length) return;
    ready.sort((a, b) => a.i - b.i);
    ready.forEach(({ i }) => printState(i, `<span class="muted">Printing…</span>`));
    try {
      await printPages(ready.flatMap((x) => x.pages));
      for (const { r, i } of ready) {
        if (!reprint) await api("/api/scan/confirm", { rn: r.rn, kind: r.print, operator, code, dry: false });
        printState(i, `<span class="pill s-ok">✓ ${r.print === "return" ? "Return label" : "Label"} sent to the printer${reprint ? "" : r.print === "return" ? ", marked shipped to Amazon" : ", marked shipped"}</span>
          <button class="btn small" data-reprint="${i}">Print again</button> <button class="btn small" data-preview="${i}">Preview</button>`);
      }
      refreshSide();
    } catch (e) {
      ready.forEach(({ i }) => printState(i, `<div class="banner bad" style="margin:0 0 6px">PRINT ERROR: ${esc(e.message)}</div><button class="btn small primary" data-retry="${i}">Try again</button> <button class="btn small" data-preview="${i}">Preview</button>`));
      if (sound) beep("bad");
    }
  }
  const printResult = (r, i, code, opts) => printBatch([{ r, i }], code, opts);

  // a product is missing from the package: tick Package Not Received on its order (and let the operator undo it)
  const pnrUndo = {}; // per card: what to put back if the operator undoes the flag
  async function setPnr(i, flag) {
    const r = lastRes.results[i], box = $("#pnr" + i);
    if (box) box.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      const out = await api("/api/scan/pnr", { rn: r.rn, flag, operator, dry: practice, code: lastRes.code, restore: flag ? undefined : pnrUndo[i]?.restore });
      const label = $("#pr" + i);
      if (flag) {
        pnrUndo[i] = { restore: out.restore, labelHtml: label?.innerHTML };
        if (out.unshipped && label) label.innerHTML = `<span class="muted">The label was already printed. The order is no longer marked shipped.</span>`;
      } else {
        if (pnrUndo[i]?.labelHtml != null && label) label.innerHTML = pnrUndo[i].labelHtml;
        delete pnrUndo[i];
      }
      if (box) box.innerHTML = flag
        ? `<div class="banner bad" style="margin:0 0 6px"><b>FLAGGED: PACKAGE NOT RECEIVED.</b> ${practice ? "(Practice: nothing was saved.) " : "Package Not Received is ticked on this order. "}${out.unshipped ? "Label Used and Shipped to Customer were unticked, so it can be sent again when the package arrives. " : ""}Tell the PH team.</div><button class="btn small" data-pnrundo="${i}">Undo</button>`
        : `<button class="btn small danger" data-pnr="${i}">Package not received</button>`;
      if (sound) beep(flag ? "bad" : "ok");
      if (!practice) refreshSide();
    } catch (e) {
      toast(e.message, "bad");
      if (box) box.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  }

  async function previewLabel(rn) {
    try {
      const pages = await labelPages(`/api/label?rn=${rn}`);
      await dialog({ title: "Label preview", wide: true, body: pages.map((p) => `<img alt="" src="${p.img}" style="max-width:100%;border:1px solid var(--line);border-radius:6px">`).join(""), actions: [["Close", "close"]] });
    } catch (e) { toast(e.message, "bad"); }
  }

  // ---------- the operator counted the items in a package whose order is for more than one
  async function sendCount(form) {
    const i = +form.dataset.count, r = lastRes.results[i], items = +form.elements.items.value;
    form.querySelectorAll("input, button").forEach((x) => (x.disabled = true));
    try {
      const out = await api("/api/scan/count", { rn: r.rn, code: lastRes.code, items, dry: practice });
      lastRes.results[i] = out.result;
      const art = el.querySelector(`article[data-i="${i}"]`);
      if (art) art.outerHTML = card(out.result, i);
      if (sound) beep(out.result.tone === "crit" ? "bad" : out.result.tone === "warn" ? "warn" : "ok");
      if (out.result.print) queue = queue.then(() => printBatch([{ r: out.result, i }], lastRes.code));
      if (!practice) refreshSide();
    } catch (e) {
      toast(e.message, "bad");
      form.querySelectorAll("input, button").forEach((x) => (x.disabled = false));
    }
    $("#scan").focus();
  }

  // ---------- scanning
  let lastRes = null;
  async function doScan(code) {
    code = code.trim();
    if (!code) return;
    $("#scan").disabled = true;
    try {
      lastRes = await api("/api/scan", { code, operator, dry: practice });
      show(lastRes);
    } catch (e) {
      $("#out").innerHTML = `<div class="banner bad"><b>${esc(e.message)}</b></div>`;
      if (sound) beep("bad");
    }
    $("#scan").value = "";
    $("#scan").disabled = false;
    $("#scan").focus();
    refreshSide();
  }

  el.onsubmit = (e) => {
    e.preventDefault();
    if (e.target.dataset?.count != null) sendCount(e.target);
    else doScan($("#scan").value);
  };
  el.onchange = (e) => {
    if (e.target.id === "practice") { practice = e.target.checked; store.set("gt_scan_practice", practice ? "1" : "0"); syncChrome(); }
    if (e.target.id === "sound") { sound = e.target.checked; store.set("gt_scan_sound", sound ? "1" : "0"); }
  };
  el.onclick = async (e) => {
    const t = e.target;
    const idx = (a) => +t.closest(`[data-${a}]`).dataset[a];
    if (t.closest("#testPrint")) {
      await printTest(operator);
      toast("Sent a test label to the printer.");
    } else if (t.closest("[data-sample]")) {
      $("#scan").value = t.closest("[data-sample]").dataset.sample;
      doScan($("#scan").value);
    } else if (t.closest("[data-pnr]")) {
      setPnr(idx("pnr"), true);
    } else if (t.closest("[data-pnrundo]")) {
      setPnr(idx("pnrundo"), false);
    } else if (t.closest("[data-preview]")) {
      previewLabel(lastRes.results[idx("preview")].rn);
    } else if (t.closest("[data-reprint]")) {
      const i = idx("reprint");
      queue = queue.then(() => printResult(lastRes.results[i], i, lastRes.code, { reprint: true }));
    } else if (t.closest("[data-retry]")) {
      const i = idx("retry");
      queue = queue.then(() => printResult(lastRes.results[i], i, lastRes.code));
    } else if (t.closest("[data-release]")) {
      try {
        lastRes = await api("/api/scan/release", { rn: +t.closest("[data-release]").dataset.release, operator, dry: practice });
        show(lastRes);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } catch (err) { toast(err.message, "bad"); }
    } else if (!t.closest("input, button, select, textarea, a, label, dialog")) {
      $("#scan").focus();
    }
  };

  // ---------- the two lists beside the scanner
  async function refreshSide() {
    try {
      const [h, r] = await Promise.all([api("/api/scan/holds"), api("/api/scan/recent")]);
      const od = h.holds.filter((x) => x.overdue).length;
      $("#holdNote").textContent = h.holds.length ? `${fmt(h.holds.length)} waiting${od ? ` · ${od} overdue` : ""}` : "";
      $("#holds").innerHTML = h.holds.length ? `<div class="tablewrap" style="max-height:340px"><table style="min-width:0"><thead><tr><th>Item</th><th class="num">Boxes</th><th class="num">Items</th><th>On hold</th><th></th></tr></thead><tbody>${h.holds.slice(0, 100).map((x) =>
        `<tr><td><b class="mono">${esc(x.label)}</b><div class="muted clip">${esc(x.product)}</div></td><td class="num">${x.received} / ${x.expected}</td><td class="num">${x.qty_total > 1 ? `${x.items} / ${x.qty_total}` : "—"}</td>
          <td>${x.hours == null ? "—" : `${x.hours >= 48 ? Math.round(x.hours / 24) + " d" : Math.round(x.hours) + " h"}`} ${x.overdue ? `<span class="pill s-crit">Overdue</span>` : ""}</td>
          <td>${x.overdue ? `<button class="btn small" data-release="${x.rn}">Ship now</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="muted">Nothing is on hold.</p>`;
      $("#recent").innerHTML = r.scans.length ? `<div class="tablewrap" style="max-height:340px"><table style="min-width:0"><tbody>${r.scans.map((s) => {
        const [text, tone] = OUTCOME_LABEL[s.outcome] || [s.outcome, "neutral"];
        return `<tr><td class="muted">${esc(time(s.at))}</td><td>${esc(s.operator)}</td><td class="mono">${esc(s.code)}</td><td><span class="pill ${PILL[tone]}">${esc(text)}</span></td></tr>`;
      }).join("")}</tbody></table></div>` : `<p class="muted">No scans yet.</p>`;
    } catch { /* the scanner keeps working without the lists */ }
  }

  api("/api/scan/samples").then(({ samples }) => {
    $("#samples").innerHTML = `<span class="muted">Try a real example:</span> ${samples.map((s) => `<button class="btn small" data-sample="${esc(s.code)}" title="${esc(s.product)}">${esc(s.scenario)}</button>`).join("")}`;
  }).catch(() => {});

  refreshSide();
  const timer = setInterval(() => { if (!el.isConnected || location.hash !== "#scan") clearInterval(timer); else refreshSide(); }, 60000);
  $("#scan").focus();
}
