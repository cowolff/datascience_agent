// Tiny DOM helpers shared by the client-side renderers (render/table.js,
// render/chart.js). Kept separate so each renderer file stays focused on its
// own artifact type.

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function placeholder(text) {
  return el("span", "text-xs text-slate-400 dark:text-slate-500", text);
}
