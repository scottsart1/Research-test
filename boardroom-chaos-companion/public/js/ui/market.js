import { SYSTEM_ENTITIES, GAME_DEFAULTS, getStock, stockOwnershipPercent, stockMarketValue, weightedVoteSummary, getBankLendingQuote, antitrustEligibility, entityName } from "../../engine.js";
import { getState, getSection } from "../store.js";
import { money, escapeHtml, titleCase, roundVisual, segmented } from "../helpers.js";
import { voteControls, activePlayers } from "./shared.js";

export const MARKET_SECTIONS = [["exchange", "Exchange"], ["bank", "Bank"], ["filings", "File"], ["governance", "Governance"]];

function sparkline(values, className, label) {
  if (values.length < 2) return "";
  const min = Math.min(...values), max = Math.max(...values);
  const range = Math.max(max - min, 0.01);
  const points = values.map((value, index) => `${roundVisual(index / (values.length - 1) * 100)},${roundVisual(34 - ((value - min) / range) * 30)}`).join(" ");
  return `<svg class="sparkline ${className}" viewBox="0 0 100 38" role="img" aria-label="${escapeHtml(label)}"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2.4" vector-effect="non-scaling-stroke" /></svg>`;
}

function stockCard(stock) {
  const state = getState();
  const change = Number(stock.lastChangePercent || 0);
  const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const available = Math.max(0, stock.authorizedShares - stock.outstandingShares);
  const history = (stock.history || []).slice(-14).map(item => Number(item.price));
  const holdings = stock.holdings.map(holding => `<li><span>${escapeHtml(entityName(state, holding.entityId))}</span><strong>${holding.shares} · ${stockOwnershipPercent(state, stock.companyId, holding.entityId)}%</strong></li>`).join("");
  return `<article class="stock-card ${stock.status !== "active" ? "delisted" : ""}">
    <div class="row between"><div><span class="ticker">${escapeHtml(stock.ticker)}</span><h2>${escapeHtml(stock.name)}</h2></div><span class="status-pill">${titleCase(stock.status)}</span></div>
    <div class="stock-price-row"><strong>${money(stock.price)}</strong><span class="market-${direction}">${change > 0 ? "+" : ""}${change.toFixed(1)}%</span></div>
    ${sparkline(history, "", `${stock.ticker} recent price movement`) || '<div class="sparkline-empty">Market opens after the first completed round.</div>'}
    <div class="mini-grid"><span>Market cap<strong>${money(stockMarketValue(state, stock.companyId))}</strong></span><span>Shares available<strong>${available}</strong></span><span>Outstanding<strong>${stock.outstandingShares}</strong></span><span>Rent dividend<strong>${Math.round((state.settings.stockDividendRate || GAME_DEFAULTS.stockDividendRate) * 100)}%</strong></span></div>
    <ul class="holdings-list">${holdings}</ul>
  </article>`;
}

function policyCard(policy) {
  const state = getState();
  const vote = weightedVoteSummary(policy.voteSnapshot, policy.votes, policy.voteThresholdPercent || 50);
  const approvalResolved = policy.approval.outcome === "approved" || (policy.approval.outcome === "approved_with_conditions" && policy.approval.condition && policy.approval.condition !== "AI condition pending.");
  const canActivate = approvalResolved && vote.passed && policy.effectiveRound && state.round >= policy.effectiveRound && policy.status !== "active";
  return `<article class="panel">
    <div class="row between"><div><span class="chip">${escapeHtml(getStock(state, policy.companyId).ticker)} policy</span><h2>${escapeHtml(policy.title)}</h2></div><span class="status-pill">${titleCase(policy.status)}</span></div>
    <p>${escapeHtml(policy.terms)}</p>
    <div class="mini-grid"><span>Legal fee<strong>${money(policy.legalFee)}</strong></span><span>Vote yes<strong>${vote.yesPercent.toFixed(1)}%</strong></span><span>Required<strong>&gt; ${vote.thresholdPercent}%</strong></span><span>Effective round<strong>${policy.effectiveRound || "Not set"}</strong></span></div>
    ${policy.approval.rolledAt ? `<div class="approval-result ${policy.approval.outcome}"><strong>${titleCase(policy.approval.outcome)}</strong><span>Fixed 10/40/50 approval system</span>${policy.approval.condition ? `<p>${escapeHtml(policy.approval.condition)}</p>` : ""}</div>` : ""}
    ${approvalResolved ? voteControls(policy.voteSnapshot, policy.votes, "policy-vote", policy.id, policy.companyId) : ""}
    <div class="button-row right">${!policy.approval.rolledAt ? `<button class="secondary" data-action="policy-approval" data-policy="${policy.id}">Run approval</button>` : ""}<button class="primary" data-action="activate-policy" data-policy="${policy.id}" ${canActivate ? "" : "disabled"}>Activate policy</button></div>
  </article>`;
}

function mergerCard(merger) {
  const state = getState();
  const acquirerStock = getStock(state, merger.acquirerId);
  const targetStock = getStock(state, merger.targetId);
  const voteA = weightedVoteSummary(merger.voteSnapshots[merger.acquirerId], merger.votes[merger.acquirerId], merger.voteThresholdPercent || 50);
  const voteB = weightedVoteSummary(merger.voteSnapshots[merger.targetId], merger.votes[merger.targetId], merger.voteThresholdPercent || 50);
  const conditionalDone = merger.approval.outcome !== "approved_with_conditions" || [merger.acquirerId, merger.targetId].every(id => merger.approval.conditionAcceptedBy.includes(id));
  const conditionDefined = merger.approval.condition && merger.approval.condition !== "AI condition pending.";
  const approvalDone = merger.approval.outcome === "approved" || (merger.approval.outcome === "approved_with_conditions" && conditionDefined && conditionalDone);
  const canExecute = approvalDone && voteA.passed && voteB.passed && merger.consents[merger.acquirerId] && merger.consents[merger.targetId] && merger.settlementRound && state.round >= merger.settlementRound && merger.status !== "executed";
  const acceptButton = playerId => `<button class="secondary" data-action="accept-merger-condition" data-merger="${merger.id}" data-player="${playerId}" ${merger.approval.conditionAcceptedBy.includes(playerId) ? "disabled" : ""}>${merger.approval.conditionAcceptedBy.includes(playerId) ? "✓ Accepted" : `${escapeHtml(getStock(state, playerId).ticker)} accepts condition`}</button>`;
  const consentButton = playerId => `<button class="${merger.consents[playerId] ? "signed" : "secondary"}" data-action="sign-merger" data-merger="${merger.id}" data-player="${playerId}" ${merger.consents[playerId] ? "disabled" : ""}>${merger.consents[playerId] ? "✓ " : ""}${escapeHtml(getStock(state, playerId).ticker)} consent</button>`;
  return `<article class="panel merger-card">
    <div class="row between"><div><span class="chip">Merger</span><h2>${escapeHtml(merger.title)}</h2></div><span class="status-pill">${titleCase(merger.status)}</span></div>
    <div class="merger-flow"><strong>${escapeHtml(acquirerStock.ticker)}</strong><span>acquires</span><strong>${escapeHtml(targetStock.ticker)}</strong></div>
    <p>Locked exchange ratio: each ${escapeHtml(targetStock.ticker)} share converts into <strong>${merger.exchangeRatio}</strong> ${escapeHtml(acquirerStock.ticker)} shares.</p>
    <div class="mini-grid"><span>Legal fee<strong>${money(merger.legalFee)}</strong></span><span>Merger fee<strong>${money(merger.mergerFee)}</strong></span><span>${escapeHtml(acquirerStock.ticker)} yes<strong>${voteA.yesPercent.toFixed(1)}%</strong></span><span>${escapeHtml(targetStock.ticker)} yes<strong>${voteB.yesPercent.toFixed(1)}%</strong></span></div>
    ${merger.approval.rolledAt ? `<div class="approval-result ${merger.approval.outcome}"><strong>${titleCase(merger.approval.outcome)}</strong><span>Fixed 10/40/50 approval system</span>${merger.approval.condition ? `<p>${escapeHtml(merger.approval.condition)}</p>` : ""}</div>` : ""}
    ${merger.approval.outcome === "approved_with_conditions" && conditionDefined ? `<div class="signature-grid">${acceptButton(merger.acquirerId)}${acceptButton(merger.targetId)}</div>` : ""}
    ${approvalDone ? `<div class="signature-grid">${consentButton(merger.acquirerId)}${consentButton(merger.targetId)}</div>${voteControls(merger.voteSnapshots[merger.acquirerId], merger.votes[merger.acquirerId], "merger-vote", merger.id, merger.acquirerId)}${voteControls(merger.voteSnapshots[merger.targetId], merger.votes[merger.targetId], "merger-vote", merger.id, merger.targetId)}` : ""}
    <div class="callout">${merger.settlementRound ? `Settlement round: <strong>${merger.settlementRound}</strong>.` : "The two-round clock begins only after final consent and both shareholder votes pass."}</div>
    <div class="button-row right">${!merger.approval.rolledAt ? `<button class="secondary" data-action="merger-approval" data-merger="${merger.id}">Run approval</button>` : ""}<button class="primary" data-action="execute-merger" data-merger="${merger.id}" ${canExecute ? "" : "disabled"}>Complete merger</button></div>
  </article>`;
}

function antitrustCard(review) {
  const state = getState();
  const company = state.players.find(player => player.id === review.companyId);
  const outcomeText = {
    cleared: "Cleared",
    fine_200: "$200 fine paid",
    half_rent: `Half rent through round ${company?.antitrustHalfRentUntilRound || "—"}`,
    construction_freeze: `Construction frozen through round ${company?.constructionFreezeUntilRound || "—"}`,
    divestiture: review.fallbackFine ? "$150 fallback fine paid" : "Property auction required"
  }[review.outcome] || titleCase(review.outcome);
  const fineButton = review.status === "fine_due" ? `<button class="primary" data-action="pay-antitrust-fine" data-review="${review.id}">Pay ${money(review.fineAmount)} into Free Parking</button>` : "";
  const saleForm = review.status === "divestiture_due" ? `<form class="panel antitrust-sale-form" data-antitrust-sale="${review.id}"><div><strong>Complete forced-sale auction</strong><p class="muted">The table conducts the auction. Enter the winning bidder and final price; proceeds go to the divesting company.</p></div><label>Eligible property<select name="propertyId">${review.eligiblePropertyIds.map(id => { const property = state.properties.find(item => item.id === id); return `<option value="${id}">${escapeHtml(property?.name || id)}</option>`; }).join("")}</select></label><label>Winning bidder<select name="buyerId">${activePlayers().filter(player => player.id !== review.companyId).map(player => `<option value="${player.id}">${escapeHtml(player.name)}</option>`).join("")}</select></label><label>Winning price<input name="price" type="number" min="1" step="1" required placeholder="Auction price" /></label><button class="primary" type="submit">Record sale</button></form>` : "";
  return `<article class="panel"><div class="row between"><div><span class="chip">Antitrust</span><h2>${escapeHtml(company?.companyName || entityName(state, review.companyId))}</h2></div><span class="status-pill">${escapeHtml(titleCase(review.status))}</span></div><p><strong>${escapeHtml(outcomeText)}</strong></p><p class="muted">Trigger: ${escapeHtml(review.reasons.map(titleCase).join(" · "))} · Round ${review.createdRound}</p>${fineButton}${saleForm}</article>`;
}

function bankLoanCard(loan) {
  const state = getState();
  const borrower = state.players.find(player => player.id === loan.borrowerId);
  const canRepay = ["active", "delinquent"].includes(loan.status) && borrower && borrower.cash + 0.001 >= loan.balance;
  return `<article class="loan-row ${loan.status === "delinquent" ? "delinquent" : ""}">
    <div><div class="row gap"><strong>${escapeHtml(borrower?.name || loan.borrowerId)}</strong><span class="status-pill">${titleCase(loan.status)}</span></div><p class="muted">Borrowed ${money(loan.principal)} at ${Number(loan.ratePercent).toFixed(0)}% · due round ${loan.dueRound}</p></div>
    <div class="loan-balance"><span>Repayment</span><strong>${money(loan.balance)}</strong></div>
    ${["active", "delinquent"].includes(loan.status) ? `<button class="${canRepay ? "primary" : "secondary"}" data-action="repay-bank-loan" data-loan="${loan.id}" ${canRepay ? "" : "disabled"}>Repay in full</button>` : ""}
  </article>`;
}

function exchangeSection() {
  const state = getState();
  return `<div class="market-rule-strip"><span><strong>20%</strong> of rent becomes dividends</span><span><strong>$${state.settings.legalFee}</strong> legal fee per filing</span><span><strong>2 rounds</strong> to settle</span><span><strong>10 / 40 / 50</strong> approval odds</span></div>
    <div class="stock-grid">${state.market.stocks.map(stockCard).join("")}</div>`;
}

function bankSection() {
  const state = getState();
  const players = activePlayers();
  const bankQuote = getBankLendingQuote(state);
  const bankLoans = state.loans.filter(loan => loan.lenderId === SYSTEM_ENTITIES.BANK);
  const history = (state.bank?.lending?.history || []).slice(-16).map(item => Number(item.ratePercent));
  const previousBankRate = history.length > 1 ? history.at(-2) : bankQuote.ratePercent;
  const rateDirection = bankQuote.ratePercent > previousBankRate ? "up" : bankQuote.ratePercent < previousBankRate ? "down" : "flat";
  return `<section class="bank-desk">
      <div class="bank-rate-panel">
        <div class="row between"><div><p class="eyebrow">Bank credit desk</p><h2>Dynamic lending rate</h2></div><span class="market-${rateDirection} rate-badge">${bankQuote.ratePercent.toFixed(0)}%</span></div>
        <p>The rate rises as bank cash is depleted, falls as liquidity returns, and receives a bounded random spread once each round.</p>
        ${sparkline(history, "bank-rate-line", "Recent bank lending-rate movement") || '<div class="sparkline-empty">The rate history begins after the first completed round.</div>'}
        <div class="mini-grid"><span>Bank cash<strong>${money(bankQuote.cash)}</strong></span><span>Available to lend<strong>${money(bankQuote.availableLiquidity)}</strong></span><span>Liquidity base rate<strong>${bankQuote.baseRatePercent.toFixed(0)}%</strong></span><span>Random spread<strong>${bankQuote.randomSpreadPercent >= 0 ? "+" : ""}${bankQuote.randomSpreadPercent.toFixed(0)}%</strong></span><span>Emergency liquidity<strong>${money(bankQuote.emergencyCredit)}</strong></span><span>Rate range<strong>${GAME_DEFAULTS.bankRateMinimumPercent}%–${GAME_DEFAULTS.bankRateMaximumPercent}%</strong></span></div>
        ${bankQuote.emergencyCredit > 0 ? `<div class="voice-warning"><strong>Emergency liquidity active:</strong> required bank payouts were honored beyond available cash. New bank loans are suspended and the lending rate remains at ${GAME_DEFAULTS.bankRateMaximumPercent}% until bank receipts repay ${money(bankQuote.emergencyCredit)}.</div>` : ""}
        <div class="callout">Current loans lock this rate for <strong>${bankQuote.termRounds} rounds</strong>. One unpaid bank loan is allowed per company; the maximum new loan is <strong>${money(bankQuote.maximumSingleLoan)}</strong>. All principal, interest, prices, taxes, dividends, and settlements use whole Monopoly dollars.</div>
      </div>
      <form id="bankLoanForm" class="panel bank-loan-form"><div class="panel-icon">🏦</div><h2>Borrow from the bank</h2><p class="muted">Immediate funding. No legal filing, approval randomizer, or settlement lag.</p><label>Borrower<select name="borrowerId">${players.map(player => `<option value="${player.id}">${escapeHtml(player.name)} — ${money(player.cash)}</option>`).join("")}</select></label><label>Principal<input name="principal" type="number" min="${bankQuote.minimumLoan}" max="${bankQuote.maximumSingleLoan}" step="10" value="${Math.min(200, bankQuote.maximumSingleLoan)}" required /></label><div class="mini-grid"><span>Locked rate<strong>${bankQuote.ratePercent.toFixed(0)}%</strong></span><span>Term<strong>${bankQuote.termRounds} rounds</strong></span></div><button class="primary full" type="submit" ${bankQuote.maximumSingleLoan < bankQuote.minimumLoan ? "disabled" : ""}>Issue bank loan</button></form>
    </section>
    <div class="stack bank-loan-list">${bankLoans.length ? bankLoans.map(bankLoanCard).join("") : '<div class="empty-panel">No bank loans have been issued.</div>'}</div>`;
}

function filingsSection() {
  const state = getState();
  const players = activePlayers();
  const activeStocks = state.market.stocks.filter(stock => stock.status === "active");
  const tickerOption = player => `<option value="${player.id}">${escapeHtml(getStock(state, player.id).ticker)} — ${escapeHtml(player.name)}</option>`;
  return `<div class="action-grid">
      <form id="primaryStockForm" class="panel featured"><div class="panel-icon">📈</div><h2>Raise capital</h2><p class="muted">Issue new voting shares at the current locked market price. Proceeds go to the company for property, houses, hotels, or taxes.</p><label>Company<select name="companyId">${activeStocks.map(stock => `<option value="${stock.companyId}">${escapeHtml(stock.ticker)} — ${money(stock.price)} · ${roundVisual(stock.authorizedShares - stock.outstandingShares)} available</option>`).join("")}</select></label><label>Investor<select name="buyerId">${players.map(player => `<option value="${player.id}">${escapeHtml(player.name)}</option>`).join("")}</select></label><label>New shares<input name="shares" type="number" min="1" step="1" value="10" required /></label><button class="primary full" type="submit">File capital raise</button></form>
      <form id="secondaryStockForm" class="panel"><div class="panel-icon">↔️</div><h2>Trade existing shares</h2><p class="muted">The price locks when filed. Ownership and cash move only after approval and two-round settlement.</p><label>Stock<select name="companyId">${activeStocks.map(stock => `<option value="${stock.companyId}">${escapeHtml(stock.ticker)} — ${money(stock.price)}</option>`).join("")}</select></label><div class="two-col"><label>Seller<select name="sellerId">${state.players.map(player => `<option value="${player.id}">${escapeHtml(player.name)}</option>`).join("")}</select></label><label>Buyer<select name="buyerId">${players.map(player => `<option value="${player.id}">${escapeHtml(player.name)}</option>`).join("")}</select></label></div><label>Shares<input name="shares" type="number" min="1" step="1" value="5" required /></label><button class="secondary full" type="submit">File stock trade</button></form>
      <form id="policyForm" class="panel"><div class="panel-icon">🗳️</div><h2>Corporate policy</h2><p class="muted">Shareholders vote by record-date shares. Use policies for development budgets, property strategy, dividend promises, or management limits.</p><label>Company<select name="companyId">${activeStocks.map(stock => `<option value="${stock.companyId}">${escapeHtml(stock.ticker)}</option>`).join("")}</select></label><label>Policy type<select name="type"><option value="development">House / hotel development</option><option value="financing">Financing</option><option value="property_strategy">Property strategy</option><option value="governance">Governance</option><option value="custom">Custom</option></select></label><label>Title<input name="title" required placeholder="Authorize orange-group development budget" /></label><label>Exact policy<textarea name="terms" required rows="4" placeholder="Authorize up to $450 for evenly built houses on the orange group through round 10."></textarea></label><button class="secondary full" type="submit">File policy</button></form>
      <form id="mergerForm" class="panel"><div class="panel-icon">🏢</div><h2>Propose merger</h2><p class="muted">The acquiring company pays both the legal fee and the nonrefundable merger fee. Both companies’ shareholders vote.</p><label>Acquirer<select name="acquirerId">${players.map(tickerOption).join("")}</select></label><label>Target<select name="targetId">${players.map(tickerOption).join("")}</select></label><label>Merger name<input name="title" placeholder="The Atlantic Property Consolidation" /></label><div class="callout">Nonrefundable filing cost: <strong>${money(state.settings.legalFee + state.settings.mergerFee)}</strong> into Free Parking.</div><button class="secondary full" type="submit">File merger</button></form>
    </div>`;
}

function governanceSection() {
  const state = getState();
  const players = activePlayers();
  const dueBills = state.taxBills.filter(bill => bill.status === "due");
  const antitrustEligible = players.map(player => ({ player, eligibility: antitrustEligibility(state, player.id) })).filter(item => item.eligibility.eligible);
  return `${dueBills.length ? `<div class="section-head"><div><p class="eyebrow">Tax Day</p><h2>Outstanding bills</h2></div></div><div class="stack">${dueBills.map(bill => `<article class="panel tax-bill"><div><h3>${escapeHtml(entityName(state, bill.playerId))}</h3><p class="muted">Round ${bill.round} · Property ${money(bill.propertyTax)} + net-worth income tax ${money(bill.incomeTax)}</p></div><strong>${money(bill.total)}</strong><button class="primary" data-action="pay-tax" data-tax="${bill.id}">Pay into Free Parking</button></article>`).join("")}</div>` : ""}
    <div class="panel free-parking-desk"><div><p class="eyebrow">Free Parking jackpot</p><h2>${money(state.freeParkingPot)}</h2><p>Taxes, legal fees, merger fees, and designated fines accumulate here.</p></div><div class="button-row">${players.map(player => `<button class="secondary" data-action="collect-free-parking" data-player="${player.id}">${escapeHtml(player.name)} landed here</button>`).join("")}</div></div>
    <div class="section-head"><div><p class="eyebrow">Market power</p><h2>Antitrust</h2><p>Each company receives at most one review after a merger, four railroads, or three complete color groups.</p></div></div>
    ${antitrustEligible.length ? `<div class="button-row">${antitrustEligible.map(({ player, eligibility }) => `<button class="secondary" data-action="run-antitrust" data-player="${player.id}">Review ${escapeHtml(getStock(state, player.id).ticker)} · ${escapeHtml(eligibility.reasons.map(titleCase).join(" / "))}</button>`).join("")}</div>` : ""}
    <div class="stack">${state.antitrustReviews.map(antitrustCard).join("") || '<div class="empty-panel">No antitrust review has been triggered.</div>'}</div>
    <div class="section-head"><div><p class="eyebrow">Governance</p><h2>Policies</h2></div></div><div class="stack">${state.policies.map(policyCard).join("") || '<div class="empty-panel">No corporate policies filed.</div>'}</div>
    <div class="section-head"><div><p class="eyebrow">Consolidation</p><h2>Mergers</h2></div></div><div class="stack">${state.mergers.map(mergerCard).join("") || '<div class="empty-panel">No mergers filed.</div>'}</div>`;
}

export function renderMarket() {
  const state = getState();
  const section = getSection("market", "exchange");
  const dueTaxes = state.taxBills.filter(bill => bill.status === "due").length;
  const pending = state.mergers.filter(item => !["executed", "rejected", "cancelled"].includes(item.status)).length + state.policies.filter(item => !["active", "rejected", "cancelled"].includes(item.status)).length;
  const sections = MARKET_SECTIONS.map(([id, label]) => [id, id === "governance" && (dueTaxes || pending) ? `${label} · ${dueTaxes + pending}` : label]);
  const body = { exchange: exchangeSection, bank: bankSection, filings: filingsSection, governance: governanceSection }[section] || exchangeSection;
  return `<section class="page">
    <div class="section-head"><div><p class="eyebrow">Boardroom exchange</p><h1>Market, bank, and filings</h1><p>Prices move randomly after every completed four-player round. No news, explanations, or performance logic are attached.</p></div></div>
    ${segmented("market", sections, section)}
    ${body()}
  </section>`;
}
