/** Rendering helpers used by more than one page. */
import { SYSTEM_ENTITIES, entityName, getStock } from "../../engine.js";
import { getState } from "../store.js";
import { money, escapeHtml, titleCase, dateTime } from "../helpers.js";
import { aiStatus } from "../ai.js";

export function playerOptions(selected = "", includeBank = false, includePot = false) {
  const state = getState();
  if (!state) return "";
  const system = [
    includeBank ? `<option value="${SYSTEM_ENTITIES.BANK}" ${selected === SYSTEM_ENTITIES.BANK ? "selected" : ""}>Bank</option>` : "",
    includePot ? `<option value="${SYSTEM_ENTITIES.POT}" ${selected === SYSTEM_ENTITIES.POT ? "selected" : ""}>Free Parking pot</option>` : ""
  ].join("");
  return system + state.players.filter(p => !p.bankrupt && !p.mergedInto).map(player => `<option value="${player.id}" ${selected === player.id ? "selected" : ""}>${escapeHtml(player.name)} — ${money(player.cash)}</option>`).join("");
}

export function propertyOptions(filter = () => true, selected = "") {
  const state = getState();
  return state.properties.filter(filter).map(property => `<option value="${property.id}" ${selected === property.id ? "selected" : ""}>${escapeHtml(property.name)}${property.ownerShares.length ? ` — ${ownershipText(property)}` : " — Bank"}</option>`).join("");
}

export function ownershipText(property) {
  const state = getState();
  if (!property.ownerShares.length) return "Bank";
  return property.ownerShares.map(share => `${entityName(state, share.entityId)} ${share.percent}%`).join(" + ");
}

export function activePlayers() {
  return getState().players.filter(player => !player.bankrupt && !player.mergedInto);
}

export function propertyCard(property) {
  const groupClass = `group-${property.group.toLowerCase().replaceAll(" ", "-")}`;
  const badge = `<span class="chip ${property.type === "street" ? groupClass : ""}">${escapeHtml(property.group)}</span>`;
  return `<article class="property-card ${property.mortgaged ? "mortgaged" : ""}">
    <div class="property-band ${groupClass}"></div>
    <div class="property-body">
      <div class="row between"><div>${badge}<h3>${escapeHtml(property.name)}</h3></div><strong>${money(property.price)}</strong></div>
      <p class="muted">${escapeHtml(ownershipText(property))}</p>
      <div class="mini-grid">
        <span>Mortgage <strong>${money(property.mortgage)}</strong></span>
        <span>Status <strong>${property.mortgaged ? "Mortgaged" : "Active"}</strong></span>
        ${property.type === "street" ? `<span>Buildings <strong>${property.buildings === 5 ? "Hotel" : property.buildings}</strong></span><span>Build <strong>${money(property.buildCost)}</strong></span>` : ""}
      </div>
      ${property.ownerShares.length ? `<div class="button-row compact">
        <button class="secondary small" data-action="toggle-mortgage" data-property="${property.id}">${property.mortgaged ? "Unmortgage" : "Mortgage"}</button>
        ${property.type === "street" && !property.mortgaged ? `<button class="secondary small" data-action="building-down" data-property="${property.id}" ${property.buildings <= 0 ? "disabled" : ""}>− House</button><button class="secondary small" data-action="building-up" data-property="${property.id}" ${property.buildings >= 5 ? "disabled" : ""}>+ House</button>` : ""}
      </div>` : ""}
    </div>
  </article>`;
}

export function eventRow(event) {
  return `<article class="event-row"><div class="event-dot"></div><div><strong>${escapeHtml(event.description)}</strong><span>Round ${event.round} · ${dateTime(event.at)} · ${titleCase(event.type)}</span></div></article>`;
}

export function voteControls(snapshot, votes, action, subjectId, companyId) {
  const state = getState();
  if (!snapshot) return "";
  return `<div class="vote-box"><div class="row between"><strong>${escapeHtml(getStock(state, companyId).ticker)} shareholder vote</strong><span class="muted">Record date: round ${snapshot.capturedRound}</span></div>${snapshot.holdings.map(holding => {
    const selected = votes?.[holding.entityId];
    return `<div class="vote-row"><span>${escapeHtml(entityName(state, holding.entityId))} · ${holding.shares} votes</span><div class="button-row"><button class="small ${selected === "yes" ? "signed" : "secondary"}" data-action="${action}" data-subject="${subjectId}" data-company="${companyId}" data-voter="${holding.entityId}" data-vote="yes">Yes</button><button class="small ${selected === "no" ? "danger" : "secondary"}" data-action="${action}" data-subject="${subjectId}" data-company="${companyId}" data-voter="${holding.entityId}" data-vote="no">No</button></div></div>`;
  }).join("")}</div>`;
}

export function assetSummary(assets) {
  const state = getState();
  if (!assets?.length) return "Nothing immediate";
  return assets.map(asset => {
    if (asset.type === "cash") return money(asset.amount);
    if (asset.type === "property_share") return `${asset.percent || 100}% of ${state.properties.find(p => p.id === asset.propertyId)?.name || "property"}`;
    if (asset.type === "company_share") return `${asset.shares} ${getStock(state, asset.companyId).ticker} voting shares${asset.issuance ? " (new issue)" : ""} @ ${money(asset.lockedPrice || getStock(state, asset.companyId).price)}`;
    if (asset.type === "jail_card") return `${asset.quantity || 1} jail card(s)`;
    return titleCase(asset.type);
  }).join(" + ");
}

/** Compact "which AI is wired up" pill shown on pages that use AI. Links to Settings. */
export function aiStatusPill() {
  const status = aiStatus();
  const tone = status.configured ? "success" : "warning";
  const text = status.configured ? `${status.label} · ${status.model}${status.source === "server" ? " (server)" : ""}` : "No AI provider — add a key";
  return `<button type="button" class="ai-pill ${tone}" data-go="settings" title="AI settings"><span class="status-dot"></span>${escapeHtml(text)}</button>`;
}
