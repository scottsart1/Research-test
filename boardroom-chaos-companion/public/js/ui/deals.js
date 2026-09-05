import { entityName, weightedVoteSummary, dealFairness } from "../../engine.js";
import { getState } from "../store.js";
import { money, escapeHtml, titleCase } from "../helpers.js";
import { playerOptions, voteControls, assetSummary } from "./shared.js";

export function ownedPropertyOptions(ownerId) {
  const state = getState();
  const owned = state.properties.filter(p => p.ownerShares.some(s => s.entityId === ownerId));
  return `<option value="">None</option>${owned.map(p => `<option value="${p.id}">${escapeHtml(p.name)} — owns ${p.ownerShares.find(s => s.entityId === ownerId).percent}%</option>`).join("")}`;
}

function assetFields(prefix, ownerId) {
  return `<div class="asset-builder">
    <label>Cash<input name="${prefix}Cash" type="number" min="0" step="1" placeholder="0" /></label>
    <label>Property<select name="${prefix}Property">${ownedPropertyOptions(ownerId)}</select></label>
    <label>Property share %<input name="${prefix}Percent" type="number" min="1" max="100" value="100" /></label>
  </div>`;
}

function dealCard(deal) {
  const state = getState();
  const fairness = dealFairness(state, deal);
  const signedA = Boolean(deal.signatures[deal.proposerId]);
  const signedB = Boolean(deal.signatures[deal.counterpartyId]);
  const conditionDefined = deal.approval.outcome !== "approved_with_conditions" || (deal.approval.condition && deal.approval.condition !== "AI condition pending.");
  const conditionalComplete = deal.approval.outcome !== "approved_with_conditions" || [deal.proposerId, deal.counterpartyId].every(id => deal.approval.conditionAcceptedBy.includes(id));
  const approvalGood = deal.approval.outcome === "approved" || (deal.approval.outcome === "approved_with_conditions" && conditionDefined && conditionalComplete);
  const votesPassed = (deal.requiredCompanyVoteIds || []).every(companyId => weightedVoteSummary(deal.voteSnapshots?.[companyId], deal.votes?.[companyId], deal.voteThresholdPercent || 50).passed);
  const closed = ["executed", "rejected", "cancelled"].includes(deal.status);
  const executable = signedA && signedB && approvalGood && votesPassed && deal.settlementRound && state.round >= deal.settlementRound && !closed;
  const acceptButton = playerId => `<button class="secondary" data-action="accept-condition" data-deal="${deal.id}" data-player="${playerId}" ${deal.approval.conditionAcceptedBy.includes(playerId) ? "disabled" : ""}>${deal.approval.conditionAcceptedBy.includes(playerId) ? "✓ Condition accepted" : `${escapeHtml(entityName(state, playerId))}: accept condition`}</button>`;
  const signButton = (playerId, signed) => `<button class="${signed ? "signed" : "secondary"}" data-action="sign-deal" data-deal="${deal.id}" data-player="${playerId}" ${signed || closed ? "disabled" : ""}>${signed ? "✓ " : ""}${escapeHtml(entityName(state, playerId))}</button>`;
  return `<article class="panel deal-card status-${deal.status}">
    <div class="row between"><div><span class="chip">${titleCase(deal.kind || deal.status)}</span><h2>${escapeHtml(deal.title)}</h2></div><span class="status-pill">${titleCase(deal.status)}</span></div>
    <div class="deal-summary">
      <div><strong>${escapeHtml(entityName(state, deal.proposerId))}</strong><span>gives</span><p>${escapeHtml(assetSummary(deal.proposerGives))}</p></div>
      <div class="deal-arrow">⇄</div>
      <div><strong>${escapeHtml(entityName(state, deal.counterpartyId))}</strong><span>gives</span><p>${escapeHtml(assetSummary(deal.counterpartyGives))}</p></div>
    </div>
    ${deal.terms ? `<div class="contract-terms">${escapeHtml(deal.terms)}</div>` : ""}
    <div class="mini-grid"><span>Estimated side A<strong>${money(fairness.proposerValue)}</strong></span><span>Estimated side B<strong>${money(fairness.counterpartyValue)}</strong></span><span>Legal fee paid<strong>${money(deal.legalFee)}</strong></span><span>Settlement round<strong>${deal.settlementRound || "Not started"}</strong></span></div>
    ${deal.approval.rolledAt ? `<div class="approval-result ${deal.approval.outcome}"><strong>${titleCase(deal.approval.outcome)}</strong><span>Fixed 10/40/50 system · draw band ${deal.approval.percentile || "—"}</span>${deal.approval.condition ? `<p>Condition: ${escapeHtml(deal.approval.condition)}</p>` : ""}</div>` : ""}
    ${deal.approval.outcome === "approved_with_conditions" && conditionDefined && !closed ? `<div class="signature-grid">${acceptButton(deal.proposerId)}${acceptButton(deal.counterpartyId)}</div>` : ""}
    ${approvalGood ? `<div class="signature-grid">${signButton(deal.proposerId, signedA)}${signButton(deal.counterpartyId, signedB)}</div>` : ""}
    ${closed ? "" : (deal.requiredCompanyVoteIds || []).map(companyId => voteControls(deal.voteSnapshots[companyId], deal.votes[companyId], "deal-vote", deal.id, companyId)).join("")}
    <div class="callout">${deal.settlementRound ? `Final deal accepted in round ${deal.readyRound}; settlement is permitted in round <strong>${deal.settlementRound}</strong>.` : "The two-round settlement clock begins only after approval, final signatures, accepted conditions, and any required shareholder vote."}</div>
    <div class="button-row right">
      ${!deal.approval.rolledAt && !closed ? `<button class="secondary" data-action="roll-approval" data-deal="${deal.id}">Run 10/40/50 approval</button>` : ""}
      <button class="primary" data-action="execute-deal" data-deal="${deal.id}" ${!executable ? "disabled" : ""}>Settle deal</button>
    </div>
  </article>`;
}

export function renderDeals() {
  const state = getState();
  const proposer = state.players[state.activePlayerIndex];
  const counterparty = state.players.find(p => p.id !== proposer.id && !p.bankrupt && !p.mergedInto) || state.players[0];
  return `<section class="page">
    <div class="section-head"><div><p class="eyebrow">Negotiation desk</p><h1>Deals and delayed settlement</h1><p>Every formal deal costs ${money(state.settings.legalFee)}, receives the fixed 10/40/50 approval result, and settles two rounds after the final version is accepted.</p></div></div>
    <form id="dealForm" class="panel deal-builder">
      <label>Deal title<input name="title" maxlength="80" placeholder="Orange alliance rescue package" required /></label>
      <div class="deal-parties">
        <section><label>Proposer<select id="dealProposer" name="proposerId">${playerOptions(proposer.id)}</select></label><h3>Proposer gives</h3>${assetFields("proposer", proposer.id)}</section>
        <div class="deal-arrow">⇄</div>
        <section><label>Counterparty<select id="dealCounterparty" name="counterpartyId">${playerOptions(counterparty.id)}</select></label><h3>Counterparty gives</h3>${assetFields("counterparty", counterparty.id)}</section>
      </div>
      <label>Future terms and promises<textarea name="terms" rows="4" placeholder="State triggers, duration, repayment deadline, rent immunity, remedies, and anything the judge may need later."></textarea></label>
      <div class="callout"><strong>Approval is fixed:</strong> 10% approved as written, 40% approved with one AI-defined condition, and 50% rejected. No dice and no rerolls.</div>
      <button class="primary full" type="submit">File deal · ${money(state.settings.legalFee)} legal fee</button>
    </form>
    <div class="section-head"><div><p class="eyebrow">Deal room</p><h2>${state.deals.length ? "Current proposals" : "No proposals yet"}</h2></div></div>
    <div class="stack">${state.deals.map(dealCard).join("") || '<div class="empty-panel">Create a deal above. Filing fees, approval, signatures, shareholder votes, settlement dates, and execution are all logged.</div>'}</div>
  </section>`;
}
