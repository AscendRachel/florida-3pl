// Conditional formatting of All Orders: the rules of the Google Sheet's March tab, with the same colours and the same order of priority.
// The first rule that applies to a cell decides its colour (as in Google Sheets). Times are US Eastern, the sheet's time zone.
import { tzEastern } from "./util.js";

const WHITE = "#ffffff";

// "A2:AC" of the sheet: the columns that the status colours paint across the row (plus Label Chip, AQ)
const ROW_COLS = new Set([
  "Label Number", "Gift Note", "Store Order No.", "Product Name", "Brand", "QTY", "Customer Name", "Address", "Source Order Date",
  "Source Order Number", "Source Tracking Number", "Shipping Label Link", "Product Image Link", "Source Order Status",
  "Package Not Received", "To Void", "ITEM ON HOLD", "Stock", "Label Used", "Shipped to Customer", "Shipped to Amazon",
  "Label Voided", "Tracking Number To Customer", "Delivery Date", "Tracking Status", "Notes", "Store", "PH Team Internal Notes",
  "Days In Transit", "Label Chip",
]);

// duplicates (the sheet's =countif(C:C,C2)>1 and the same on J, L and W)
export const DUP_COLUMNS = ["Store Order No.", "Source Order Number", "Shipping Label Link", "Tracking Number To Customer"];
// black with white text in the light theme, white with black text in the dark theme (the colours are set in orders.css)
const DUP = { bg: "var(--dup-bg)", fg: "var(--dup-fg)" };

const is = (a, b) => String(a || "").trim().toLowerCase() === b.toLowerCase(); // "=" in Sheets ignores capitals
const yes = (v) => String(v || "").toUpperCase() === "TRUE";

// rules 6-18 of the sheet, in priority order: each is [test(v), fill]
const ROW_RULES = [
  [(v) => is(v("Source Order Status"), "Refunded"), "#00ffff"],
  [(v) => is(v("Tracking Status"), "Store Returns"), "#c3b091"],
  [(v) => is(v("Tracking Status"), "Return to Sender"), "#9900ff"],
  [(v) => yes(v("Package Not Received")), "#ff9900"],
  [(v) => is(v("Source Order Status"), "For Refund"), "#f4cccc"],
  [(v) => is(v("Tracking Status"), "Return to Amazon"), "#783f04"],
  [(v) => yes(v("Shipped to Customer")) && is(v("Tracking Status"), "Preshipment"), "#ff00ff"],
  [(v) => is(v("Tracking Status"), "Delivered"), "#ffff00"],
  [(v) => is(v("Tracking Status"), "In Transit"), "#b7b7b7"],
  [(v) => is(v("Source Order Status"), "Unfulfilled"), "#6aa84f"],
  [(v) => is(v("Source Order Status"), "Cancelled"), "#6d9eeb"],
  [(v) => is(v("Source Order Status"), "Delivered"), "#00ff00"],
  // an Amazon order exists, the estimated delivery date has passed (an empty date counts as passed, as in Sheets) and it is not delivered
  [(v, now) => v("Source Order Number").trim() !== "" && (v("Delivery Date") === "" || v("Delivery Date").slice(0, 10) < now.day) && !is(v("Source Order Status"), "Delivered"), "#ff0000"],
];

// the text colour that stays readable on a fill the rule does not give a text colour for
export function textOn(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#000000" : WHITE;
}

const paint = (bg, fg) => ({ bg, fg: fg || textOn(bg) });

function nowEastern() {
  const d = new Date(Date.now() - tzEastern.off * 60000).toISOString(); // "2026-10-29T08:15:00.000Z" read as Eastern
  return { day: d.slice(0, 10), stamp: d.slice(0, 16).replace("T", " "), dayAgo: new Date(Date.now() - tzEastern.off * 60000 - 86400000).toISOString().slice(0, 16).replace("T", " ") };
}

// dupes: {column name: Set of lower-cased values that occur more than once}; keyIdx: {column name: index in the row array}
export function makeFormatter(keyIdx, dupes) {
  let now = nowEastern(), at = Date.now();
  return function format(row) {
    if (Date.now() - at > 30000) { now = nowEastern(); at = Date.now(); }
    const v = (name) => { const i = keyIdx[name]; return i === undefined ? "" : row[i + 1] || ""; };
    const out = {};
    // duplicates: highest priority
    for (const name of DUP_COLUMNS) {
      const val = v(name).trim().toLowerCase();
      if (val && dupes[name]?.has(val)) out[name] = DUP;
    }
    // status colours across the row
    for (const [test, fill] of ROW_RULES) {
      if (!test(v, now)) continue;
      const p = paint(fill);
      for (const name of ROW_COLS) if (!out[name]) out[name] = p;
      break;
    }
    // a tracking number that is filled in: light green
    if (!out["Source Tracking Number"] && v("Source Tracking Number").trim()) out["Source Tracking Number"] = paint("#b7e1cd");
    // on hold for more than a day
    if (yes(v("ITEM ON HOLD")) && v("Hold Date") && v("Hold Date").slice(0, 16) < now.dayAgo && !out["Hold Date"]) out["Hold Date"] = paint("#ff0000");
    // the Tapicker delivery date is earlier than its shipped date: red with white text
    const shipped = v("TAPICKER SHIPPED DATE"), delivered = v("TAPICKER DELIVERY DATE");
    if (shipped && delivered && shipped.slice(0, 16) > delivered.slice(0, 16)) {
      for (const name of ["TAPICKER SHIPPED DATE", "TAPICKER DELIVERY DATE"]) if (!out[name]) out[name] = { bg: "#ff0000", fg: WHITE };
    }
    // the Label Chip text does not contain the customer's name (spaces in the name match anything, as in the sheet)
    const chip = v("Label Chip"), who = v("Customer Name");
    if (chip && who && !out["Label Chip"]) {
      let found = true;
      try { found = new RegExp(who.toLowerCase().replace(/ /g, ".*")).test(chip.toLowerCase()); } catch { /* a name that is not a valid pattern: no colour, as in Sheets */ }
      if (!found) out["Label Chip"] = paint("#ff0000");
    }
    return out;
  };
}
