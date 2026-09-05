/** Small formatting and DOM helpers shared by every UI module. */

export const money = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.round(Number(value || 0)));
export const dateTime = value => value ? new Date(value).toLocaleString() : "—";
export const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
export const titleCase = value => String(value || "").replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase());
export const roundVisual = value => Math.round(value * 100) / 100;
export const clone = value => globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));

const toast = () => document.querySelector("#toast");

export function showToast(message, tone = "normal") {
  const element = toast();
  if (!element) return;
  element.textContent = message;
  element.dataset.tone = tone;
  element.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => element.classList.remove("show"), 2800);
}

export function fail(error) {
  console.error(error);
  showToast(error?.message || "Something went wrong.", "error");
}

/** showModal() throws on a dialog that is already open, so every opener goes through here. */
export function openDialog(dialog) {
  if (dialog && !dialog.open) dialog.showModal();
}

export function downloadFile(filename, content, type = "application/json") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function slug(value) {
  return String(value || "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

/** Segmented sub-navigation used by the longer pages. */
export function segmented(name, sections, current) {
  return `<nav class="segmented" role="tablist" aria-label="${escapeHtml(name)} sections">${sections.map(([id, label]) =>
    `<button type="button" role="tab" data-segment="${name}" data-section="${id}" aria-selected="${current === id}" class="${current === id ? "active" : ""}">${escapeHtml(label)}</button>`
  ).join("")}</nav>`;
}
