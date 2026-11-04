// Returns, Kohl's Returns side: the list the warehouse keeps by hand for Kohl's (store, stock no., SKU, order number, product, image, quantity, condition).
import { mountSheet } from "./sheet-grid.js";
import { returnTabs } from "./card-tabs.js";

export async function mount(el, params, ctx) {
  return mountSheet(el, ctx, {
    hash: "#returns?tab=kohls",
    heading: "Returns",
    tabs: returnTabs("kohls"),
    intro: "The Kohl's returns the warehouse keeps by hand. Click a cell to select it (Ctrl+V pastes cells copied from a sheet); double-click or press Enter to type in it.",
    totalLabel: "KOHL'S RETURNS TOTAL:",
    searchPlaceholder: "Search stock no., SKU, order number, product, notes…",
    list: "/api/kohls",
    prefix: "/api/kohls/",
    cols: [
      { k: "store", name: "STORE", kind: "select", w: 150, opts: "stores" },
      { k: "stock_no", name: "STOCK NO.", kind: "text", w: 90 },
      { k: "sku", name: "SKU", kind: "text", w: 90 },
      { k: "order_number", name: "ORDER NUMBER", kind: "text", w: 130 },
      { k: "product", name: "Product Name", kind: "text", w: 260 },
      { k: "image", name: "Image link", kind: "link", w: 160 },
      { k: "qty", name: "QTY", kind: "num", w: 54 },
      { k: "good", name: "GOOD CONDITION", kind: "bool", w: 110 },
      { k: "used", name: "SHIPPED TO CUSTOMER", kind: "bool", w: 130 },
      { k: "notes", name: "Notes", kind: "text", w: 200 },
    ],
    filter: { k: "store", all: "All stores" },
    delText: (r) => `${r?.sku || r?.order_number || "This row"} will be removed from the Kohl's list.`,
    emptyText: "Nothing here yet. Press Add row, or select a cell and paste cells copied from a sheet.",
    zoomTitle: (r) => r.product || r.sku || "Image",
  });
}
