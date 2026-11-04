// The switch at the top of Order Cards and of Returns: the pages that share one place in the menu.
const link = (href, text, on) => `<a href="${href}"${on ? ' class="on"' : ""}>${text}</a>`;

export const cardTabs = (active) => [["", "All Orders"], ["returns", "Store Returns"], ["stock", "Stocks"], ["hold", "Item on Hold"], ["rta", "Return to Amazon"], ["rts", "Return to Sender"], ["materials", "Materials"]]
  .map(([tab, text]) => link(tab ? `#cards?tab=${tab}` : "#cards", text, tab === active)).join("");

export const returnTabs = (active) => [["", "Returns"], ["kohls", "Kohl's Returns"]]
  .map(([tab, text]) => link(tab ? `#returns?tab=${tab}` : "#returns", text, tab === active)).join("");
