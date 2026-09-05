/**
 * Single source of truth for the live game state, its persistence, and the current view.
 * UI modules read through getState(); only controllers call setState().
 */
import { importGame, exportGame } from "../engine.js";
import { showToast } from "./helpers.js";

export const STORAGE_KEY = "boardroom-chaos-state-v1";
const VIEW_KEY = "boardroom-chaos-view-v1";

let state = null;
let renderer = () => {};
const view = { tab: "dashboard", sections: {} };

try {
  const saved = JSON.parse(sessionStorage.getItem(VIEW_KEY) || "null");
  if (saved && typeof saved === "object") Object.assign(view, saved);
} catch { /* ignore */ }

function persistView() {
  try { sessionStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* ignore */ }
}

export function getState() { return state; }

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state = raw ? importGame(raw) : null;
  } catch (error) {
    console.error(error);
    localStorage.removeItem(STORAGE_KEY);
    state = null;
  }
  return state;
}

export function saveState() {
  if (state) localStorage.setItem(STORAGE_KEY, exportGame(state));
}

/** Replace the game state, persist it, re-render, and optionally toast. */
export function setState(next, message = "Saved") {
  state = next;
  saveState();
  renderer();
  if (message) showToast(message);
}

/** Directly replace state without a ledger action (new game, import, settings edits). */
export function replaceState(next) {
  state = next;
  if (next) saveState();
  else localStorage.removeItem(STORAGE_KEY);
}

export function registerRenderer(fn) { renderer = fn; }
export function rerender() { renderer(); }

export function getTab() { return view.tab; }
export function setTab(tab) { view.tab = tab; persistView(); }
export function getSection(page, fallback) { return view.sections[page] || fallback; }
export function setSection(page, section) { view.sections[page] = section; persistView(); }
