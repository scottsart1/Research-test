import { entityName, buildJudgePacket, recordJudgement } from "../../engine.js";
import { getState, setState } from "../store.js";
import { money, escapeHtml, titleCase, dateTime, showToast } from "../helpers.js";
import { playerOptions, aiStatusPill } from "./shared.js";
import { aiStatus, judgeDispute } from "../ai.js";

function disputeCard(dispute) {
  const state = getState();
  const latest = state.judgements.find(j => j.disputeId === dispute.id);
  const ai = aiStatus();
  return `<article class="dispute-card embedded-case">
    <div class="row between"><div><span class="chip">${titleCase(dispute.status)}</span><h3>${escapeHtml(dispute.title)}</h3></div><span class="muted">Round ${dispute.createdRound}</span></div>
    <p><strong>Question:</strong> ${escapeHtml(dispute.issue)}</p>
    ${dispute.evidence ? `<p><strong>Evidence:</strong> ${escapeHtml(dispute.evidence)}</p>` : ""}
    ${dispute.requestedRemedy ? `<p><strong>Requested remedy:</strong> ${escapeHtml(dispute.requestedRemedy)}</p>` : ""}
    ${latest ? `<div class="approval-result"><strong>Latest ruling: ${escapeHtml(titleCase(latest.verdict))}</strong><span>${Math.round(latest.confidence * 100)}% confidence · ${escapeHtml(latest.model)}</span></div>` : ""}
    <div class="button-row right"><button class="secondary" data-action="local-judge" data-dispute="${dispute.id}">Local rule test</button><button class="primary" data-action="ai-judge" data-dispute="${dispute.id}" ${ai.configured ? "" : "disabled"} title="${ai.configured ? "" : "Add an AI provider key in Settings"}">AI legal review</button></div>
  </article>`;
}

function legalContractCard(contract) {
  const state = getState();
  const cases = state.disputes.filter(dispute => dispute.linkedContractId === contract.id);
  const caseIds = new Set(cases.map(item => item.id));
  const rulings = state.judgements.filter(item => caseIds.has(item.disputeId));
  const latest = rulings[0];
  const option = (value, label) => `<option value="${value}" ${contract.status === value ? "selected" : ""}>${label}</option>`;
  return `<article class="panel contract-card legal-contract-card">
    <div class="row between"><div><span class="chip">${titleCase(contract.type)}</span><h2>${escapeHtml(contract.title)}</h2></div><span class="status-pill status-${contract.status}">${titleCase(contract.status)}</span></div>
    <p class="muted">${contract.partyIds.map(id => entityName(state, id)).map(escapeHtml).join(" · ")} · Created round ${contract.createdRound}${contract.expiresRound ? ` · Expires round ${contract.expiresRound}` : ""}</p>
    <div class="contract-terms">${escapeHtml(contract.terms)}</div>
    <div class="contract-control-row"><label>Status<select data-contract-status="${contract.id}">${option("draft", "Draft")}${option("active", "Active")}${option("fulfilled", "Fulfilled")}${option("breached", "Breached")}${option("disputed", "Disputed")}${option("voided", "Voided")}${option("expired", "Expired")}</select></label><div class="legal-counts"><span>Cases<strong>${cases.length}</strong></span><span>Rulings<strong>${rulings.length}</strong></span></div><button class="secondary" data-review-contract="${contract.id}">Review this contract</button></div>
    ${latest ? `<div class="approval-result"><strong>Latest ruling: ${escapeHtml(titleCase(latest.verdict))}</strong><span>${Math.round(latest.confidence * 100)}% confidence · ${escapeHtml(latest.model)}</span></div>` : ""}
    ${cases.length ? `<div class="attached-cases">${cases.map(disputeCard).join("")}</div>` : ""}
  </article>`;
}

function judgementCard(judgement) {
  const state = getState();
  const dispute = state.disputes.find(d => d.id === judgement.disputeId);
  return `<article class="panel ruling-card">
    <div class="row between"><div><span class="chip ${judgement.confidence >= .75 ? "success" : "warning"}">${Math.round(judgement.confidence * 100)}% confidence</span><h2>${escapeHtml(titleCase(judgement.verdict))}</h2></div><span class="muted">${escapeHtml(judgement.model)}</span></div>
    <p class="muted">Case: ${escapeHtml(dispute?.title || judgement.disputeId)} · ${dateTime(judgement.createdAt)}</p>
    <p>${escapeHtml(judgement.explanation)}</p>
    ${judgement.findings?.length ? `<h3>Findings</h3><ul>${judgement.findings.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
    ${judgement.orders?.length ? `<h3>Order / next action</h3><ul>${judgement.orders.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}
    <div class="rule-citations">${(judgement.citedRuleIds || []).map(id => `<span>${escapeHtml(id)}</span>`).join("")}</div>
    ${judgement.tableOverride ? `<div class="callout"><strong>Table override: ${escapeHtml(titleCase(judgement.tableOverride.outcome))}</strong> ${escapeHtml(judgement.tableOverride.notes)}</div>` : `<form class="override-form" data-judgement="${judgement.id}"><select name="outcome"><option value="upheld">Uphold</option><option value="overturned">Overturn</option><option value="modified">Modify</option></select><input name="notes" placeholder="Vote result or modified remedy" /><button class="secondary" type="submit">Record table decision</button></form>`}
  </article>`;
}

export function renderLegal() {
  const state = getState();
  const ai = aiStatus();
  const openCases = state.disputes.filter(dispute => dispute.status === "open").length;
  return `<section class="page legal-page">
    <div class="section-head"><div><p class="eyebrow">Contract & Legal Desk</p><h1>Document, review, and arbitrate in one place</h1><p>Create the agreement once, then attach every question, ruling, and table decision to that same record.</p></div></div>
    <div class="legal-status-bar">
      <div><span class="chip ${ai.configured ? "success" : "warning"}">${ai.configured ? "AI legal review ready" : "Local review available"}</span><strong>${escapeHtml(ai.configured ? `${ai.label} · ${ai.model}` : "No AI provider configured")}</strong><small>${ai.configured ? `Requests go ${ai.transport === "server" ? "through the local server" : "directly from this device"}. The deterministic local rule test always works.` : "Add a Claude, GPT, Kimi, or DeepSeek key in Settings to enable AI rulings. The local rule test works without one."}</small></div>
      <div><span>Contracts</span><strong>${state.contracts.length}</strong></div>
      <div><span>Open cases</span><strong>${openCases}</strong></div>
      <button class="secondary" data-go="settings">AI settings</button>
    </div>

    <div class="legal-workbench">
      <form id="contractForm" class="panel featured">
        <div><p class="eyebrow">Step 1</p><h2>Document a contract</h2><p class="muted">The saved wording becomes the official text used in later review.</p></div>
        <div class="two-col"><label>Title<input name="title" required placeholder="Orange Group Development Agreement" /></label><label>Type<select name="type"><option value="custom">Custom</option><option value="loan">Loan</option><option value="alliance">Alliance</option><option value="rent_immunity">Rent immunity</option><option value="joint_venture">Joint venture</option><option value="merger">Merger support</option></select></label></div>
        <fieldset><legend>Parties</legend><div class="checkbox-grid">${state.players.filter(p => !p.bankrupt && !p.mergedInto).map(player => `<label class="check-card"><input type="checkbox" name="partyIds" value="${player.id}" /> ${escapeHtml(player.name)}</label>`).join("")}</div></fieldset>
        <label>Legal-fee sponsor<select name="sponsorId">${playerOptions()}</select></label>
        <label>Complete terms<textarea name="terms" required rows="6" placeholder="Who gives what, what revenue is shared, voting rights, deadlines, expiration, default, and remedy."></textarea></label>
        <div class="two-col"><label>Status<select name="status"><option value="draft">Draft</option><option value="active">Active</option></select></label><label>Expires after round<input name="expiresRound" type="number" min="1" placeholder="Optional" /></label></div>
        <button class="primary full" type="submit">Save contract · ${money(state.settings.legalFee)} legal fee</button>
      </form>

      <form id="disputeForm" class="panel" data-legal-review-form>
        <div><p class="eyebrow">Step 2</p><h2>Legal review or dispute</h2><p class="muted">Link the contract so the judge reviews the exact documented wording.</p></div>
        <label>Linked contract<select id="legalLinkedContract" name="linkedContractId"><option value="">General rules question</option>${state.contracts.map(c => `<option value="${c.id}">${escapeHtml(c.title)}</option>`).join("")}</select></label>
        <label>Review title<input id="legalCaseTitle" name="title" required placeholder="Review of Orange Group Development Agreement" /></label>
        <div class="two-col"><label>Claimant<select name="claimantId"><option value="">Neutral review</option>${playerOptions()}</select></label><label>Respondent<select name="respondentId"><option value="">No respondent</option>${playerOptions()}</select></label></div>
        <label>Question for legal review<textarea id="legalCaseIssue" name="issue" required rows="4" placeholder="Is this contract clear and enforceable under the house rules? Identify missing terms or decide the dispute."></textarea></label>
        <label>Evidence or table testimony<textarea name="evidence" rows="3" placeholder="Ledger entries, exact statements, witnesses, or facts not contained in the contract."></textarea></label>
        <label>Requested remedy<input name="requestedRemedy" placeholder="Clarify before signature, enforce payment, declare no breach…" /></label>
        <button class="primary full" type="submit">Open legal review</button>
      </form>
    </div>

    <div class="section-head"><div><p class="eyebrow">Official records</p><h2>Contracts and attached legal history</h2></div>${aiStatusPill()}</div>
    <div class="stack">${state.contracts.map(legalContractCard).join("") || '<div class="empty-panel">No contracts yet. Document the agreement above before relying on it.</div>'}</div>

    ${state.disputes.some(dispute => !dispute.linkedContractId) ? `<div class="section-head"><h2>General rule cases</h2></div><div class="stack">${state.disputes.filter(dispute => !dispute.linkedContractId).map(disputeCard).join("")}</div>` : ""}
    ${state.judgements.length ? `<div class="section-head"><h2>All rulings</h2></div><div class="stack">${state.judgements.map(judgementCard).join("")}</div>` : ""}
  </section>`;
}

/** Controller: send the evidence packet to the configured AI provider and record its ruling. */
export async function askAiJudge(disputeId) {
  showToast("Preparing the evidence packet…");
  const state = getState();
  const packet = buildJudgePacket(state, disputeId);
  const data = await judgeDispute(packet);
  const judgement = { ...data.judgement, model: data.model, mode: "ai", evidenceSnapshot: data.evidenceSnapshot };
  setState(recordJudgement(getState(), disputeId, judgement), "AI ruling recorded");
}
