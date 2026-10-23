// Printing a shipping label from the browser. The label PDF is drawn to pictures with pdf.js (served from this app),
// then printed through a hidden frame whose page size is the label's own size, so it prints on the operator's own
// default printer. With Chrome started with --kiosk-printing it prints without a dialog.
import { esc } from "./util.js";

let pdfLoad;
function loadPdfJs() {
  pdfLoad ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/static/vendor/pdf.min.js";
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdf.worker.min.js";
      resolve(window.pdfjsLib);
    };
    s.onerror = () => { pdfLoad = null; reject(new Error("Could not load the PDF reader.")); };
    document.head.append(s);
  });
  return pdfLoad;
}

// The label of an order (downloaded by the server from Google Drive) as pictures: [{img, wIn, hIn}]
export async function labelPages(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || `Could not get the label (error ${res.status}).`);
  }
  const data = await res.arrayBuffer();
  const pdf = await (await loadPdfJs()).getDocument({ data }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const size = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: 300 / 72 }); // 300 dpi
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // intent "print" draws without waiting for animation frames, so it also works when the tab is in the background
    await page.render({ canvasContext: ctx, viewport: vp, intent: "print" }).promise;
    pages.push({ img: canvas.toDataURL("image/png"), wIn: size.width / 72, hIn: size.height / 72 });
  }
  return pages;
}

// Print some HTML on pages of the given size (inches). Resolves once the print dialog was handled.
export function printHtml(body, wIn, hIn) {
  return new Promise((resolve) => {
    const f = document.createElement("iframe");
    f.setAttribute("aria-hidden", "true");
    f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    f.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: ${wIn}in ${hIn}in; margin: 0 }
      html, body { margin: 0; padding: 0; background: #fff }
      section { overflow: hidden; break-after: page; page-break-after: always }
      section:last-child { break-after: auto; page-break-after: auto }
      img { display: block; width: 100%; height: 100% }
    </style></head><body>${body}</body></html>`;
    let done = false;
    const finish = () => { if (!done) { done = true; setTimeout(() => f.remove(), 1000); resolve(true); } };
    f.onload = async () => {
      const w = f.contentWindow;
      await Promise.all([...w.document.images].map((i) => (i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))));
      w.addEventListener("afterprint", finish);
      w.focus();
      w.print(); // waits for the dialog in most browsers; silent when the browser prints without asking
      setTimeout(finish, 1500);
    };
    document.body.append(f);
  });
}

export const printPages = (pages) =>
  printHtml(pages.map((p) => `<section style="width:${p.wIn}in;height:${p.hIn}in"><img alt="" src="${p.img}"></section>`).join(""), pages[0].wIn, pages[0].hIn);

// A 4 x 6 inch page to check that a printer is set up for labels: all four edges and corners should be visible.
export const printTest = (who) => printHtml(
  `<section style="width:4in;height:6in;box-sizing:border-box;border:4px solid #000;padding:.2in;display:flex;flex-direction:column;justify-content:space-between;font-family:Arial,sans-serif">
    <div style="display:flex;justify-content:space-between;font-weight:700;font-size:12pt"><span>&#9700; TOP LEFT</span><span>TOP RIGHT &#9701;</span></div>
    <div><h1 style="margin:0 0 .12in;font-size:32pt">PRINTER TEST</h1>
      <p style="margin:0 0 .08in;font-size:16pt">Operator: ${esc(who || "(no name)")}</p>
      <p style="margin:0 0 .15in;font-size:13pt">${esc(new Date().toLocaleString())}</p>
      <p style="margin:0;font-size:12pt;line-height:1.4">The label printer is set up correctly if you can read all of this, the frame is visible on all four sides and nothing is cut off.</p></div>
    <div style="display:flex;justify-content:space-between;font-weight:700;font-size:12pt"><span>&#9699; BOTTOM LEFT</span><span>BOTTOM RIGHT &#9698;</span></div>
  </section>`, 4, 6);
