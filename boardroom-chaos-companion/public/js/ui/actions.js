import { getState } from "../store.js";
import { escapeHtml } from "../helpers.js";
import { playerOptions, propertyOptions } from "./shared.js";

export function renderActions() {
  const state = getState();
  const active = state.players[state.activePlayerIndex];
  const ownedProperties = state.properties.filter(p => p.ownerShares.length && !p.mortgaged);
  return `<section class="page">
    <div class="section-head"><div><p class="eyebrow">From → To</p><h1>Fast actions</h1><p>One consistent flow for money, rent, and property.</p></div></div>
    <div class="action-grid">
      <form id="cashTransferForm" class="panel featured">
        <div class="panel-icon">⇄</div><h2>Send money</h2><p class="muted">Choose the sender, recipient, and amount.</p>
        <div class="from-to">
          <label>From<select name="fromId">${playerOptions(active.id, true, true)}</select></label>
          <span class="arrow">→</span>
          <label>To<select name="toId">${playerOptions("", true, true)}</select></label>
        </div>
        <label>Amount<input name="amount" type="number" min="1" step="1" placeholder="150" required /></label>
        <label>Memo<input name="memo" maxlength="100" placeholder="Rent, tax, bailout, suspicious consulting fee…" /></label>
        <button class="primary full" type="submit">Transfer money</button>
      </form>

      <form id="buyPropertyForm" class="panel">
        <div class="panel-icon">🏠</div><h2>Buy from bank</h2>
        <label>Buyer<select name="playerId">${playerOptions(active.id)}</select></label>
        <label>Property<select name="propertyId">${propertyOptions(p => !p.ownerShares.length)}</select></label>
        <label>Price override <input name="price" type="number" min="1" step="1" placeholder="Leave blank for printed price" /></label>
        <button class="secondary full" type="submit" ${state.properties.every(p => p.ownerShares.length) ? "disabled" : ""}>Complete purchase</button>
      </form>

      <form id="rentForm" class="panel">
        <div class="panel-icon">🧾</div><h2>Calculate and pay rent</h2>
        <label>Visitor<select name="visitorId">${playerOptions(active.id)}</select></label>
        <label>Property<select name="propertyId">${propertyOptions(p => p.ownerShares.length && !p.mortgaged)}</select></label>
        <div class="two-col"><label>Dice total<input name="diceTotal" type="number" min="2" max="12" placeholder="Utilities only" /></label><label>Discount %<input name="discount" type="number" min="0" max="100" value="0" /></label></div>
        <button class="secondary full" type="submit" ${!ownedProperties.length ? "disabled" : ""}>Pay calculated rent</button>
      </form>
    </div>
    <div class="turn-bar"><div><span>Current turn</span><strong>${escapeHtml(active.name)} · Round ${state.round}</strong></div><button data-action="advance-turn" class="primary">End turn →</button></div>
  </section>`;
}
