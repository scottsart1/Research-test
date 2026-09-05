import { getState } from "../store.js";
import { eventRow } from "./shared.js";

export function renderLedger() {
  const state = getState();
  return `<section class="page">
    <div class="section-head"><div><p class="eyebrow">Audit trail</p><h1>Ledger</h1><p>Newest entries first. Undo is for clerical mistakes, not strategic regret.</p></div><button class="secondary" data-action="export-ledger">Export game</button></div>
    <div class="timeline ledger-full">${state.ledger.map(eventRow).join("")}</div>
  </section>`;
}
