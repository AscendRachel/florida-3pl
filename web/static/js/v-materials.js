// Materials: the packaging supplies the warehouse keeps (poly mailers, bubble wrap, tape, boxes, labels ...), as a sheet.
// Stock Status, Last Stock Update and Updated By are filled in by the app.
import { mountSheet } from "./sheet-grid.js";

const STATUS_CLASS = { GOOD: "st-good", "REORDER ALERT": "st-warn", CRITICAL: "st-bad", "OUT OF STOCK": "st-bad" };

export async function mount(el, params, ctx) {
  return mountSheet(el, ctx, {
    hash: "#materials",
    heading: "Materials",
    tabs: "",
    intro: "The packing materials in the warehouse. Click a cell to select it (Ctrl+V pastes cells copied from a sheet); double-click or press Enter to type in it. Stock Status, Last Stock Update and Updated By fill in by themselves.",
    totalLabel: "MATERIALS TOTAL:",
    searchPlaceholder: "Search material ID, name, size, notes…",
    list: "/api/materials",
    prefix: "/api/materials/",
    cols: [
      { k: "mid", name: "Material ID", kind: "text", w: 90 },
      { k: "image", name: "Image", kind: "link", w: 130 },
      { k: "name", name: "Material Name", kind: "text", w: 150 },
      { k: "spec", name: "Size / Specification", kind: "text", w: 160 },
      { k: "unit", name: "Stock Unit", kind: "select", w: 90, opts: "units" },
      { k: "pack", name: "Pack Size", kind: "text", w: 120 },
      { k: "ordered", name: "Ordered Qty", kind: "num", w: 80 },
      { k: "current", name: "Current Stock", kind: "num", w: 90 },
      { k: "alert", name: "Alert Level", kind: "num", w: 80 },
      { k: "minimum", name: "Minimum Stock", kind: "num", w: 100 },
      { k: "status", name: "Stock Status", kind: "text", w: 120, ro: true },
      { k: "updated_at", name: "Last Stock Update", kind: "text", w: 150, ro: true },
      { k: "updated_by", name: "Updated By", kind: "text", w: 190, ro: true },
      { k: "notes", name: "Notes", kind: "text", w: 150 },
    ],
    cellClass: (r, c) => (c.k === "status" ? STATUS_CLASS[r.status] || "" : ""),
    delText: (r) => `${r?.mid || "This material"} ${r?.name || ""} will be removed from the list.`,
    emptyText: "No materials yet. Press Add row, or select a cell and paste cells copied from a sheet.",
    zoomTitle: (r) => `${r.mid} ${r.name}`.trim() || "Image",
  });
}
