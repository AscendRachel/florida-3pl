"""Colours of the conditional formatting, worked out in SQL, so All Orders can sort and filter by colour (like Google Sheets).

This mirrors web/static/js/cond-format.js, which paints the cells. Keep the two in step: a rule that is changed there must be
changed here. A colour is a hex like "#00ffff", "dup" for the duplicate colour (black or white by theme), or "" for no colour.
"""
import re

# the columns that the status colours paint across the row (plus Label Chip)
ROW_COLS = {
    "Label Number", "Gift Note", "Store Order No.", "Product Name", "Brand", "QTY", "Customer Name", "Address", "Source Order Date",
    "Source Order Number", "Source Tracking Number", "Shipping Label Link", "Product Image Link", "Source Order Status",
    "Package Not Received", "To Void", "ITEM ON HOLD", "Stock", "Label Used", "Shipped to Customer", "Shipped to Amazon",
    "Label Voided", "Tracking Number To Customer", "Delivery Date", "Tracking Status", "Notes", "Store", "PH Team Internal Notes",
    "Days In Transit", "Label Chip",
}
DUP_COLUMNS = ("Store Order No.", "Source Order Number", "Shipping Label Link", "Tracking Number To Customer")

NAMES = {
    "dup": "Duplicate", "#00ffff": "Cyan", "#c3b091": "Tan", "#9900ff": "Purple", "#ff9900": "Orange", "#f4cccc": "Light pink",
    "#783f04": "Brown", "#ff00ff": "Magenta", "#ffff00": "Yellow", "#b7b7b7": "Grey", "#6aa84f": "Green", "#6d9eeb": "Blue",
    "#00ff00": "Bright green", "#ff0000": "Red", "#b7e1cd": "Light green",
}


def _eq(col, text):
    return f"lower(trim({col})) = '{text.lower()}'"


def fill_sql(ix, name, today, day_ago, alias=""):
    """The SQL expression (one text value per row) for the fill colour of column `name`, or "''" when no rule can colour it.
    `today` is 'YYYY-MM-DD' and `day_ago` 'YYYY-MM-DD HH:MM', both US Eastern."""
    def c(n):
        return f"{alias}c{ix[n]}"
    if not re.fullmatch(r"\d{4}-\d\d-\d\d", today) or not re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d", day_ago):
        raise ValueError("bad date")
    whens = []
    if name in DUP_COLUMNS:
        col = c(name)
        whens.append(f"WHEN trim({col}) <> '' AND lower(trim({col})) IN (SELECT lower(trim(c{ix[name]})) FROM orders WHERE trim(c{ix[name]}) <> '' "
                     f"GROUP BY 1 HAVING COUNT(*) > 1) THEN 'dup'")
    if name in ROW_COLS:
        rules = [
            (_eq(c("Source Order Status"), "refunded"), "#00ffff"),
            (_eq(c("Tracking Status"), "store returns"), "#c3b091"),
            (_eq(c("Tracking Status"), "return to sender"), "#9900ff"),
            (f"upper(trim({c('Package Not Received')})) = 'TRUE'", "#ff9900"),
            (_eq(c("Source Order Status"), "for refund"), "#f4cccc"),
            (_eq(c("Tracking Status"), "return to amazon"), "#783f04"),
            (f"upper(trim({c('Shipped to Customer')})) = 'TRUE' AND {_eq(c('Tracking Status'), 'preshipment')}", "#ff00ff"),
            (_eq(c("Tracking Status"), "delivered"), "#ffff00"),
            (_eq(c("Tracking Status"), "in transit"), "#b7b7b7"),
            (_eq(c("Source Order Status"), "unfulfilled"), "#6aa84f"),
            (_eq(c("Source Order Status"), "cancelled"), "#6d9eeb"),
            (_eq(c("Source Order Status"), "delivered"), "#00ff00"),
            (f"trim({c('Source Order Number')}) <> '' AND (trim({c('Delivery Date')}) = '' OR substr({c('Delivery Date')}, 1, 10) < '{today}') "
             f"AND lower(trim({c('Source Order Status')})) <> 'delivered'", "#ff0000"),
        ]
        whens += [f"WHEN {cond} THEN '{colour}'" for cond, colour in rules]
    extra = []
    if name == "Source Tracking Number":
        extra.append(f"WHEN trim({c(name)}) <> '' THEN '#b7e1cd'")
    if name == "Hold Date":
        extra.append(f"WHEN upper(trim({c('ITEM ON HOLD')})) = 'TRUE' AND {c(name)} <> '' AND substr({c(name)}, 1, 16) < '{day_ago}' THEN '#ff0000'")
    if name in ("TAPICKER SHIPPED DATE", "TAPICKER DELIVERY DATE"):
        s, d = c("TAPICKER SHIPPED DATE"), c("TAPICKER DELIVERY DATE")
        extra.append(f"WHEN {s} <> '' AND {d} <> '' AND substr({s}, 1, 16) > substr({d}, 1, 16) THEN '#ff0000'")
    if name == "Label Chip":
        extra.append(f"WHEN {c(name)} <> '' AND {c('Customer Name')} <> '' AND cf_nomatch({c(name)}, {c('Customer Name')}) THEN '#ff0000'")
    whens += extra
    if not whens:
        return "''"
    return "(CASE " + " ".join(whens) + " ELSE '' END)"


def no_match(chip, who):
    """The sheet's NOT(REGEXMATCH(LOWER(chip), LOWER(SUBSTITUTE(name, " ", ".*")))): spaces in the name match anything."""
    try:
        return 0 if re.search(str(who).lower().replace(" ", ".*"), str(chip).lower()) else 1
    except re.error:
        return 0  # a name that is not a valid pattern gets no colour, as in Sheets
