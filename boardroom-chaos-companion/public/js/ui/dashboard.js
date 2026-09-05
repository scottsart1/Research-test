import { getBankLendingQuote, getStock, playerNetWorthBreakdown } from "../../engine.js";
import { getState } from "../store.js";
import { money, escapeHtml } from "../helpers.js";
import { eventRow } from "./shared.js";

function netWorthStanding(player, rank, breakdown) {
  const state = getState();
  const stock = getStock(state, player.id);
  const merged = Boolean(player.mergedInto);
  return `<article class="net-worth-row ${merged ? "merged-player" : ""}" style="--player-color:${escapeHtml(player.color)}">
    <div class="net-worth-rank">${rank}</div>
    <div class="net-worth-name"><span class="avatar compact-avatar">${escapeHtml(player.name.slice(0, 2).toUpperCase())}</span><div><strong>${escapeHtml(player.name)}</strong><small>${merged ? `Merged into ${escapeHtml(getStock(state, player.mergedInto).ticker)}` : escapeHtml(stock.ticker)}</small></div></div>
    <div class="net-worth-total"><span>Net worth</span><strong>${money(breakdown.total)}</strong></div>
    <details class="net-worth-details"><summary>Breakdown</summary><div class="net-worth-breakdown"><span>Cash<strong>${money(breakdown.cash)}</strong></span><span>Property<strong>${money(breakdown.propertyEquity)}</strong></span><span>Other stocks<strong>${money(breakdown.stockInvestments)}</strong></span><span>Receivables<strong>${money(breakdown.receivables)}</strong></span><span>Debt<strong>−${money(breakdown.debts)}</strong></span></div></details>
    ${merged ? "" : `<button class="secondary small" data-quick-player="${player.id}">Pay / collect</button>`}
  </article>`;
}

export function renderDashboard() {
  const state = getState();
  const active = state.players[state.activePlayerIndex];
  const bankQuote = getBankLendingQuote(state);
  const pendingDeals = state.deals.filter(d => !["executed", "rejected", "cancelled"].includes(d.status)).length;
  const openDisputes = state.disputes.filter(d => d.status === "open").length;
  const dueTaxes = state.taxBills.filter(bill => bill.status === "due").length;
  const pendingMergers = state.mergers.filter(item => !["executed", "rejected", "cancelled"].includes(item.status)).length;
  const standings = state.players
    .map(player => ({ player, breakdown: playerNetWorthBreakdown(state, player.id) }))
    .sort((a, b) => b.breakdown.total - a.breakdown.total);
  const activeSidelined = Boolean(active.bankrupt || active.mergedInto);
  return `<section class="page dashboard-page">
    <div class="hero-card dashboard-hero">
      <div>
        <p class="eyebrow">Round ${state.round}</p>
        <h1>${escapeHtml(active.name)} ${activeSidelined ? "is out of the game" : "is up"}</h1>
        <p>Use the quick controls for normal play. Corporate filings and legal work stay in their dedicated workspaces.</p>
      </div>
      <button class="primary large" data-action="advance-turn">End ${escapeHtml(active.name)}’s turn →</button>
    </div>

    <section class="quick-desk" aria-label="Quick game actions">
      <div class="section-head"><div><p class="eyebrow">One-tap desk</p><h2>What just happened?</h2></div></div>
      <div class="quick-action-grid">
        <button class="quick-action primary-quick" data-action="pass-go" ${activeSidelined ? "disabled" : ""}><span>GO</span><strong>Passed GO</strong><small>Collect $200 for ${escapeHtml(active.name)}</small></button>
        <button class="quick-action" data-go-action="rentForm"><span>🧾</span><strong>Pay rent</strong><small>Calculate from the deed</small></button>
        <button class="quick-action" data-go-action="buyPropertyForm"><span>🏠</span><strong>Buy property</strong><small>Purchase from the bank</small></button>
        <button class="quick-action" data-go-action="cashTransferForm"><span>⇄</span><strong>Pay / collect</strong><small>Simple From → To transfer</small></button>
        <button class="quick-action" data-action="collect-free-parking" data-player="${active.id}" ${state.freeParkingPot <= 0 ? "disabled" : ""}><span>🚗</span><strong>Free Parking</strong><small>${money(state.freeParkingPot)} jackpot</small></button>
        <button class="quick-action" data-go="voice"><span>🎙</span><strong>Speak action</strong><small>Transcribe, interpret, confirm</small></button>
      </div>
    </section>

    <section class="net-worth-board">
      <div class="section-head"><div><p class="eyebrow">All four players</p><h2>Net-worth standings</h2><p>Cash, property equity, outside stock, receivables, and all unpaid debt are included.</p></div></div>
      <div class="net-worth-list">${standings.map(({ player, breakdown }, index) => netWorthStanding(player, index + 1, breakdown)).join("")}</div>
    </section>

    <div class="status-strip">
      <button data-go="deals"><span>Open deals</span><strong>${pendingDeals}</strong></button>
      <button data-go="market" data-go-section="governance"><span>Mergers</span><strong>${pendingMergers}</strong></button>
      <button data-go="market" data-go-section="governance"><span>Taxes due</span><strong>${dueTaxes}</strong></button>
      <button data-go="legal"><span>Legal cases</span><strong>${openDisputes}</strong></button>
      <button data-go="market" data-go-section="bank"><span>Bank rate</span><strong>${bankQuote.ratePercent.toFixed(0)}%</strong></button>
    </div>

    <div class="section-head"><div><p class="eyebrow">Recent activity</p><h2>What just happened</h2></div><button class="ghost" data-go="ledger">Full ledger</button></div>
    <div class="timeline">${state.ledger.slice(0, 7).map(eventRow).join("")}</div>
  </section>`;
}
