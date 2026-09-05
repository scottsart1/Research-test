import {
  SYSTEM_ENTITIES,
  GAME_DEFAULTS,
  APPROVAL_CONDITIONS,
  createGame,
  transferCash,
  passGo,
  acquirePropertyFromBank,
  transferPropertyShare,
  payRent,
  calculateRent,
  advanceTurn,
  recordVoiceNote,
  createDeal,
  createPrimaryStockOffering,
  createSecondaryStockTrade,
  signDeal,
  rollDealApproval,
  setDealApprovalCondition,
  applyFallbackDealCondition,
  acceptDealCondition,
  castDealVote,
  executeDeal,
  createContract,
  updateContractStatus,
  createPolicy,
  rollPolicyApproval,
  setPolicyApprovalCondition,
  castPolicyVote,
  activatePolicy,
  createMerger,
  rollMergerApproval,
  setMergerApprovalCondition,
  acceptMergerCondition,
  signMerger,
  castMergerVote,
  executeMerger,
  weightedVoteSummary,
  getStock,
  stockOwnershipPercent,
  stockMarketValue,
  getBankLendingQuote,
  takeBankLoan,
  repayBankLoan,
  calculateTaxBill,
  payTaxBill,
  collectFreeParking,
  antitrustEligibility,
  runAntitrustReview,
  payAntitrustFine,
  completeAntitrustDivestiture,
  createDispute,
  localRuleTest,
  recordJudgement,
  overrideJudgement,
  setMortgage,
  setBuildings,
  playerNetWorthBreakdown,
  entityName,
  undoLast,
  exportGame,
  importGame,
  dealFairness,
  buildJudgePacket
} from "./engine.js";
import { RULES, RULEBOOK_VERSION } from "./rules.js";
import { VoiceTranscriber, AudioRecorderConstructor, transcribeAudioBlob, speakText } from "./voice.js";

const STORAGE_KEY = "boardroom-chaos-state-v1";
const app = document.querySelector("#app");
const setupDialog = document.querySelector("#setupDialog");
const gameDialog = document.querySelector("#gameDialog");
const confirmDialog = document.querySelector("#confirmDialog");
const toast = document.querySelector("#toast");
let activeTab = "dashboard";
let state = loadState();
let pendingInstallPrompt = null;
let pendingConfirm = null;
let judgeHealth = { checked: false, available: false, model: null, message: "Not checked", voiceModel: null, transcriptionConfigured: false, transcriptionModel: null };
let voiceState = {
  listening: false,
  localMode: false,
  status: AudioRecorderConstructor ? "Ready to record audio for OpenAI transcription." : "Live recording is unavailable. Use the audio upload/record control or type a command.",
  transcript: "",
  interim: "",
  plan: null,
  interpreting: false,
  model: null,
  error: null
};
const voiceTranscriber = new VoiceTranscriber({
  onStatus: message => { voiceState.status = message; renderVoiceIfActive(); },
  onStart: () => { voiceState.listening = true; voiceState.localMode = false; voiceState.status = "Recording… tap Stop when finished."; voiceState.error = null; renderVoiceIfActive(); },
  onResult: ({ finalTranscript, interimTranscript, model }) => { voiceState.transcript = finalTranscript; voiceState.interim = interimTranscript; voiceState.model = model || voiceState.model; renderVoiceIfActive(true); },
  onError: error => { voiceState.error = error.message; voiceState.status = "Voice transcription failed."; fail(error); renderVoiceIfActive(); },
  onEnd: ({ transcript, model }) => {
    voiceState.listening = false;
    voiceState.localMode = false;
    voiceState.interim = "";
    voiceState.transcript = transcript || voiceState.transcript;
    voiceState.model = model || voiceState.model;
    voiceState.status = voiceState.transcript ? "OpenAI transcript ready for DeepSeek interpretation." : "No usable speech was transcribed.";
    renderVoiceIfActive();
  }
});

const money = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.round(Number(value || 0)));
const dateTime = value => value ? new Date(value).toLocaleString() : "—";
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
const titleCase = value => String(value || "").replaceAll("_", " ").replace(/\b\w/g, char => char.toUpperCase());

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? importGame(raw) : null;
  } catch (error) {
    console.error(error);
    localStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

function saveState() {
  if (state) localStorage.setItem(STORAGE_KEY, exportGame(state));
}

function setState(next, message = "Saved") {
  state = next;
  saveState();
  render();
  if (message) showToast(message);
}

function showToast(message, tone = "normal") {
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function fail(error) {
  console.error(error);
  showToast(error?.message || "Something went wrong.", "error");
}

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

function playerOptions(selected = "", includeBank = false, includePot = false) {
  if (!state) return "";
  const system = [
    includeBank ? `<option value="${SYSTEM_ENTITIES.BANK}" ${selected === SYSTEM_ENTITIES.BANK ? "selected" : ""}>Bank</option>` : "",
    includePot ? `<option value="${SYSTEM_ENTITIES.POT}" ${selected === SYSTEM_ENTITIES.POT ? "selected" : ""}>Free Parking pot</option>` : ""
  ].join("");
  return system + state.players.filter(p => !p.bankrupt && !p.mergedInto).map(player => `<option value="${player.id}" ${selected === player.id ? "selected" : ""}>${escapeHtml(player.name)} — ${money(player.cash)}</option>`).join("");
}

function propertyOptions(filter = () => true, selected = "") {
  return state.properties.filter(filter).map(property => `<option value="${property.id}" ${selected === property.id ? "selected" : ""}>${escapeHtml(property.name)}${property.ownerShares.length ? ` — ${ownershipText(property)}` : " — Bank"}</option>`).join("");
}

function ownershipText(property) {
  if (!property.ownerShares.length) return "Bank";
  return property.ownerShares.map(share => `${entityName(state, share.entityId)} ${share.percent}%`).join(" + ");
}

function propertyCard(property) {
  const monopolyBadge = property.type === "street" ? `<span class="chip group-${property.group.toLowerCase().replaceAll(" ", "-")}">${property.group}</span>` : `<span class="chip">${property.group}</span>`;
  return `<article class="property-card ${property.mortgaged ? "mortgaged" : ""}">
    <div class="property-band group-${property.group.toLowerCase().replaceAll(" ", "-")}"></div>
    <div class="property-body">
      <div class="row between"><div>${monopolyBadge}<h3>${escapeHtml(property.name)}</h3></div><strong>${money(property.price)}</strong></div>
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

function render() {
  document.querySelectorAll(".bottom-nav button").forEach(button => button.classList.toggle("active", button.dataset.tab === activeTab));
  document.querySelector("#undoBtn").disabled = !state?.undoStack?.length;
  document.querySelector("#gameSubtitle").textContent = state ? `${state.name} · Round ${state.round}` : "Local-first game companion";
  if (!state) {
    app.innerHTML = `<section class="empty-state"><div class="hero-icon">⚖</div><h1>Deals without the bookkeeping headache</h1><p>Track money, property, contracts, mergers, randomized approvals, and rule judgements from one shared screen.</p><button id="openSetup" class="primary large">Create a game</button></section>`;
    queueMicrotask(() => openDialog(setupDialog));
    return;
  }
  const renderers = { dashboard: renderDashboard, voice: renderVoice, actions: renderActions, market: renderMarket, deals: renderDeals, legal: renderLegal, contracts: renderLegal, judge: renderLegal, assets: renderAssets, ledger: renderLedger, rules: renderRules };
  app.innerHTML = (renderers[activeTab] || renderDashboard)();
  syncSettingsControls();
  if (["legal", "voice"].includes(activeTab) && !judgeHealth.checked) checkJudgeHealth();
}

function netWorthStanding(player, rank, breakdown) {
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

function renderDashboard() {
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
        <button class="quick-action" data-go="voice"><span>🎙</span><strong>Speak action</strong><small>OpenAI transcript + DeepSeek detail</small></button>
      </div>
    </section>

    <section class="net-worth-board">
      <div class="section-head"><div><p class="eyebrow">All four players</p><h2>Net-worth standings</h2><p>Cash, property equity, outside stock, receivables, and all unpaid debt are included.</p></div></div>
      <div class="net-worth-list">${standings.map(({ player, breakdown }, index) => netWorthStanding(player, index + 1, breakdown)).join("")}</div>
    </section>

    <div class="status-strip">
      <button data-go="deals"><span>Open deals</span><strong>${pendingDeals}</strong></button>
      <button data-go="market"><span>Mergers</span><strong>${pendingMergers}</strong></button>
      <button data-go="market"><span>Taxes due</span><strong>${dueTaxes}</strong></button>
      <button data-go="legal"><span>Legal cases</span><strong>${openDisputes}</strong></button>
      <button data-go="market"><span>Bank rate</span><strong>${bankQuote.ratePercent.toFixed(0)}%</strong></button>
    </div>

    <div class="section-head"><div><p class="eyebrow">Recent activity</p><h2>What just happened</h2></div><button class="ghost" data-go="ledger">Full ledger</button></div>
    <div class="timeline">${state.ledger.slice(0, 7).map(eventRow).join("")}</div>
  </section>`;
}


function renderVoiceIfActive(light = false) {
  if (activeTab !== "voice") return;
  if (!light) return render();
  const transcript = document.querySelector("#voiceTranscript");
  const interim = document.querySelector("#voiceInterim");
  const status = document.querySelector("#voiceStatus");
  const mic = document.querySelector("#voiceMicBtn");
  if (transcript && document.activeElement !== transcript) transcript.value = voiceState.transcript;
  if (interim) interim.textContent = voiceState.interim || "";
  if (status) status.textContent = voiceState.status;
  if (mic) {
    mic.classList.toggle("listening", voiceState.listening);
    mic.setAttribute("aria-pressed", String(voiceState.listening));
    mic.querySelector("span").textContent = voiceState.listening ? "Stop" : "Speak";
  }
}

function voiceContext() {
  const active = state.players[state.activePlayerIndex];
  return {
    game: { id: state.id, name: state.name, round: state.round, activePlayerId: active?.id || null, activePlayerName: active?.name || null },
    players: state.players.map(({ id, name, cash, bankrupt, mergedInto }) => ({ id, name, cash, bankrupt, mergedInto })),
    properties: state.properties.map(({ id, name, type, group, price, ownerShares, mortgaged, buildings }) => ({ id, name, type, group, price, ownerShares, mortgaged, buildings })),
    deals: state.deals.slice(0, 20).map(({ id, title, proposerId, counterpartyId, status, signatures, approval }) => ({ id, title, proposerId, counterpartyId, status, signatures, approval })),
    contracts: state.contracts.slice(0, 30).map(({ id, title, type, partyIds, status, terms, expiresRound }) => ({ id, title, type, partyIds, status, terms, expiresRound })),
    disputes: state.disputes.slice(0, 20).map(({ id, title, claimantId, respondentId, linkedContractId, status, issue }) => ({ id, title, claimantId, respondentId, linkedContractId, status, issue })),
    supportedActions: ["transfer_cash", "buy_property", "pay_rent", "create_deal", "sign_deal", "roll_deal_approval", "accept_deal_condition", "execute_deal", "create_contract", "update_contract_status", "create_dispute", "pass_go", "advance_turn", "set_mortgage", "set_buildings", "voice_note"]
  };
}

function voiceActionName(type) {
  return ({
    transfer_cash: "Money transfer", buy_property: "Bank purchase", pay_rent: "Rent payment",
    create_deal: "Deal proposal", sign_deal: "Deal signature", roll_deal_approval: "Approval randomizer", accept_deal_condition: "Condition acceptance",
    execute_deal: "Execute deal", create_contract: "Contract", update_contract_status: "Contract status", create_dispute: "Rule case",
    pass_go: "Passed GO", advance_turn: "End turn", set_mortgage: "Mortgage", set_buildings: "Buildings", voice_note: "Nonbinding note"
  })[type] || titleCase(type);
}

function renderVoicePlan(plan) {
  if (!plan) return "";
  const ready = plan.actions?.length > 0;
  return `<section class="panel voice-plan">
    <div class="row between"><div><p class="eyebrow">Interpretation</p><h2>${escapeHtml(plan.summary || "Voice action plan")}</h2></div><span class="chip ${plan.status === "ready" ? "success" : "warning"}">${escapeHtml(titleCase(plan.status))} · ${Math.round(Number(plan.confidence || 0) * 100)}%</span></div>
    ${plan.unresolved?.length ? `<div class="voice-warning"><strong>Needs clarification</strong><ul>${plan.unresolved.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul>${plan.suggestedClarification ? `<p>${escapeHtml(plan.suggestedClarification)}</p>` : ""}</div>` : ""}
    <div class="stack">${(plan.actions || []).map((action, index) => {
      const selectable = !action.ambiguities?.length && Number(action.confidence || 0) >= 0.55;
      return `<label class="voice-action-card">
        <input class="voice-action-select" type="checkbox" data-index="${index}" ${selectable ? "checked" : ""} />
        <span class="voice-action-main"><span class="chip">${escapeHtml(voiceActionName(action.type))}</span><strong>${escapeHtml(action.description)}</strong><small>${Math.round(Number(action.confidence || 0) * 100)}% confidence${action.sourceQuote ? ` · “${escapeHtml(action.sourceQuote)}”` : ""}</small>${action.ambiguities?.length ? `<em>${escapeHtml(action.ambiguities.join(" · "))}</em>` : ""}</span>
      </label>`;
    }).join("") || '<div class="empty-panel">No executable action was identified. Edit the transcript or save it as a note.</div>'}</div>
    <div class="button-row right"><button class="secondary" data-action="discard-voice-plan">Discard</button><button class="primary" data-action="apply-voice-plan" ${ready ? "" : "disabled"}>Confirm and log selected actions</button></div>
  </section>`;
}

function renderVoice() {
  const supported = Boolean(AudioRecorderConstructor);
  const voiceEvents = state.ledger.filter(event => event.metadata?.voice || event.type === "voice_note").slice(0, 10);
  const secureWarning = !window.isSecureContext ? `<div class="voice-warning"><strong>Tablet connection warning:</strong> Live microphone recording is normally blocked on an ordinary HTTP local-IP address. You can still use the native “Record or upload audio” control below, or deploy the app behind HTTPS.</div>` : "";
  return `<section class="page voice-page">
    <div class="section-head"><div><p class="eyebrow">Hands-free game clerk</p><h1>Speak it. Review it. Log it.</h1><p>OpenAI transcribes the recorded audio; DeepSeek performs the detailed interpretation; the deterministic game engine validates and records.</p></div></div>
    ${secureWarning}
    <div class="voice-warning"><strong>Two-service pipeline:</strong> OpenAI handles speech-to-text only. DeepSeek receives the resulting transcript for contracts, categorization, conditions, and arbitration. A successful DeepSeek health check does not prove that microphone recording or OpenAI transcription is configured.</div>
    <div class="callout"><strong>Service status:</strong> ${escapeHtml(judgeHealth.checked ? judgeHealth.message : "Checking OpenAI transcription and DeepSeek interpretation…")}</div>
    <section class="voice-console">
      <button id="voiceMicBtn" class="voice-mic ${voiceState.listening ? "listening" : ""}" data-action="toggle-voice" aria-pressed="${voiceState.listening}" ${supported ? "" : "disabled"}><b>🎙</b><span>${voiceState.listening ? "Stop" : "Speak"}</span></button>
      <div class="voice-console-copy"><span class="chip ${voiceState.listening ? "warning" : "success"}">${voiceState.listening ? "Recording" : supported ? "Ready" : "Upload or type"}</span><h2 id="voiceStatus">${escapeHtml(voiceState.status)}</h2><p>Audio is sent through your local server to OpenAI for transcription. Only the transcript and compact game context are then sent to DeepSeek.</p><div id="voiceInterim" class="voice-interim">${escapeHtml(voiceState.interim)}</div></div>
    </section>
    <section class="panel">
      <label>Transcript<textarea id="voiceTranscript" rows="4" placeholder="Example: Sam pays Alex 200 dollars for the railroad deal.">${escapeHtml(voiceState.transcript)}</textarea></label>
      <div class="button-row"><button class="primary" data-action="interpret-voice" ${voiceState.interpreting ? "disabled" : ""}>${voiceState.interpreting ? "Interpreting…" : "Interpret command"}</button><label class="file-button secondary">Record or upload audio<input id="voiceAudioFile" type="file" accept="audio/*" capture hidden /></label><button class="secondary" data-action="save-voice-note">Save as nonbinding note</button><button class="ghost" data-action="clear-voice">Clear</button></div>
      <p class="fine-print">Financial and ownership actions always require visual confirmation. The native audio control is the fallback for Samsung or any browser that blocks live microphone recording. A voice note records testimony or table chatter but does not create a binding contract.</p>
    </section>
    ${renderVoicePlan(voiceState.plan)}
    <section class="panel voice-examples"><div><p class="eyebrow">Try saying</p><h2>Natural commands</h2></div><div class="example-grid"><button data-voice-example="Sam pays Alex 200 dollars for a consulting fee.">“Sam pays Alex $200…”</button><button data-voice-example="Jordan landed on Boardwalk. Pay the calculated rent.">“Jordan landed on Boardwalk…”</button><button data-voice-example="Create a deal where Priya gives Alex 300 dollars for Reading Railroad.">“Create a deal…”</button><button data-voice-example="Log an active contract between Alex and Sam: no orange property rent for three rounds.">“Log a contract…”</button><button data-voice-example="Open a case asking whether the rent immunity was still active.">“Open a case…”</button><button data-voice-example="End the current turn.">“End the current turn.”</button></div></section>
    <div class="section-head"><div><p class="eyebrow">Voice audit</p><h2>Recently spoken or typed</h2></div></div>
    <div class="timeline">${voiceEvents.map(eventRow).join("") || '<div class="empty-panel">Confirmed voice actions and notes will appear here.</div>'}</div>
  </section>`;
}

async function transcribeVoiceFile(file) {
  if (!file) return;
  voiceState.plan = null;
  voiceState.error = null;
  voiceState.interpreting = true;
  voiceState.status = "OpenAI is transcribing the selected recording…";
  renderVoiceIfActive();
  try {
    const result = await transcribeAudioBlob(file, { language: state.settings.voiceLanguage || "en" });
    voiceState.transcript = result.transcript;
    voiceState.model = result.model;
    voiceState.status = `Transcript ready from ${result.model}.`;
  } catch (error) {
    voiceState.error = error.message;
    voiceState.status = "Audio transcription failed.";
    fail(error);
  } finally {
    voiceState.interpreting = false;
    renderVoiceIfActive();
  }
}

async function toggleVoiceCapture() {
  if (voiceState.listening) return voiceTranscriber.stop();
  voiceState.plan = null;
  voiceState.error = null;
  voiceState.transcript = "";
  voiceState.interim = "";
  voiceState.status = "Preparing microphone…";
  renderVoiceIfActive();
  await voiceTranscriber.start({ language: state.settings.voiceLanguage || "en" });
}

function resolvePlayerLocally(fragment) {
  const lower = String(fragment || "").trim().toLowerCase();
  return state.players.find(player => player.name.toLowerCase() === lower) || null;
}

function localVoiceFallback(transcript) {
  const text = String(transcript || "").trim();
  if (/^(please )?(end|finish|advance)( the)?( current)? turn\.?$/i.test(text)) return { status: "ready", summary: "Advance to the next turn", confidence: .9, actions: [{ type: "advance_turn", description: "End the current turn", confidence: .9, fields: {}, ambiguities: [], sourceQuote: text }], unresolved: [], suggestedClarification: "" };
  const payment = text.match(/^(.+?)\s+(?:pays?|paid|gives?)\s+(.+?)\s+\$?([0-9]+(?:\.[0-9]{1,2})?)(?:\s+dollars?)?(?:\s+(?:for|as)\s+(.+))?\.?$/i);
  if (payment) {
    const from = resolvePlayerLocally(payment[1]);
    const to = resolvePlayerLocally(payment[2]);
    if (from && to) return { status: "ready", summary: `${from.name} pays ${to.name} ${money(payment[3])}`, confidence: .75, actions: [{ type: "transfer_cash", description: `${from.name} pays ${to.name} ${money(payment[3])}`, confidence: .75, fields: { fromId: from.id, toId: to.id, amount: Number(payment[3]), memo: payment[4] || "Voice payment" }, ambiguities: [], sourceQuote: text }], unresolved: [], suggestedClarification: "" };
  }
  return { status: "needs_review", summary: "DeepSeek was unavailable; transcript preserved as a note candidate", confidence: .2, actions: [{ type: "voice_note", description: "Save the transcript as a nonbinding note", confidence: .6, fields: { category: "unclassified", summary: text, actorIds: [] }, ambiguities: [], sourceQuote: text }], unresolved: ["The local fallback only understands simple payments and ending a turn."], suggestedClarification: "Edit the transcript or restore the DeepSeek connection." };
}

async function interpretVoiceTranscript() {
  const input = document.querySelector("#voiceTranscript");
  const transcript = String(input?.value || voiceState.transcript || "").trim();
  if (!transcript) throw new Error("Speak or type a command first.");
  voiceState.transcript = transcript;
  voiceState.interpreting = true;
  voiceState.plan = null;
  voiceState.status = "DeepSeek is categorizing the transcript…";
  renderVoiceIfActive();
  try {
    const response = await fetch("/api/voice/interpret", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript, context: voiceContext() }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Voice interpretation failed.");
    voiceState.plan = data.plan;
    voiceState.model = data.model;
    voiceState.status = `Interpreted with ${data.model}. Review before logging.`;
  } catch (error) {
    console.warn(error);
    voiceState.plan = localVoiceFallback(transcript);
    voiceState.model = "local-fallback";
    voiceState.status = "DeepSeek was unavailable; a limited local interpretation is shown.";
    showToast(error.message, "error");
  } finally {
    voiceState.interpreting = false;
    renderVoiceIfActive();
  }
}

function copyState(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function applyVoiceAction(current, action) {
  const f = action.fields || {};
  switch (action.type) {
    case "transfer_cash": return transferCash(current, f.fromId, f.toId, f.amount, f.memo || "Voice payment");
    case "buy_property": return acquirePropertyFromBank(current, f.playerId, f.propertyId, f.price ?? null);
    case "pay_rent": return payRent(current, f.visitorId, f.propertyId, Number(f.diceTotal || 0), Number(f.discountPercent || 0));
    case "create_deal": return createDeal(current, f);
    case "sign_deal": return signDeal(current, f.dealId, f.playerId);
    case "roll_deal_approval": return rollDealApproval(current, f.dealId);
    case "accept_deal_condition": return acceptDealCondition(current, f.dealId, f.playerId);
    case "execute_deal": return executeDeal(current, f.dealId);
    case "create_contract": return createContract(current, f);
    case "update_contract_status": return updateContractStatus(current, f.contractId, f.status);
    case "create_dispute": return createDispute(current, f);
    case "pass_go": return passGo(current, f.playerId);
    case "advance_turn": return advanceTurn(current);
    case "set_mortgage": return setMortgage(current, f.propertyId, Boolean(f.mortgaged));
    case "set_buildings": {
      const target = Number(f.buildings);
      if (!Number.isInteger(target) || target < 0 || target > 5) throw new Error("Voice building target must be 0–5.");
      let next = current;
      let level = next.properties.find(property => property.id === f.propertyId)?.buildings;
      if (!Number.isInteger(level)) throw new Error("Voice building property was not found.");
      while (level !== target) {
        level += target > level ? 1 : -1;
        next = setBuildings(next, f.propertyId, level);
      }
      return next;
    }
    case "voice_note": return recordVoiceNote(current, voiceState.transcript, f.category || "note", f.summary || voiceState.transcript, { source: "voice", model: voiceState.model || "local", confidence: action.confidence, actorIds: f.actorIds || [] });
    default: throw new Error(`Unsupported voice action: ${action.type}`);
  }
}

function applySelectedVoicePlan() {
  const selected = [...document.querySelectorAll(".voice-action-select:checked")].map(input => voiceState.plan.actions[Number(input.dataset.index)]).filter(Boolean);
  if (!selected.length) throw new Error("Select at least one interpreted action.");
  const originalSnapshot = copyState(state);
  originalSnapshot.undoStack = [];
  const oldIds = new Set(state.ledger.map(event => event.id));
  let next = state;
  for (const action of selected) next = applyVoiceAction(next, action);
  const voiceMeta = { transcript: voiceState.transcript, model: voiceState.model || "local", actionTypes: selected.map(action => action.type), interpretedConfidence: voiceState.plan.confidence, voice: true };
  for (const event of next.ledger) if (!oldIds.has(event.id)) event.metadata = { ...(event.metadata || {}), voice: voiceMeta };
  next.undoStack = [...(state.undoStack || []), originalSnapshot].slice(-30);
  const count = selected.length;
  voiceState = { ...voiceState, transcript: "", interim: "", plan: null, listening: false, interpreting: false, status: `${count} voice action${count === 1 ? "" : "s"} recorded.`, error: null };
  setState(next, `${count} voice action${count === 1 ? "" : "s"} recorded`);
  if (state.settings.voiceReadback !== false) speakText(`${count} action${count === 1 ? "" : "s"} recorded.`, { language: state.settings.voiceLanguage || "en-US" });
}

function saveTranscriptAsVoiceNote() {
  const input = document.querySelector("#voiceTranscript");
  const transcript = String(input?.value || voiceState.transcript || "").trim();
  if (!transcript) throw new Error("There is no transcript to save.");
  voiceState.transcript = "";
  voiceState.plan = null;
  setState(recordVoiceNote(state, transcript, "table_note", transcript, { source: "voice_or_typed", model: "none", confidence: 1 }), "Voice note saved");
  if (state.settings.voiceReadback !== false) speakText("Note recorded.", { language: state.settings.voiceLanguage || "en-US" });
}

function renderActions() {
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

function stockSparkline(stock) {
  const history = (stock.history || []).slice(-14);
  if (history.length < 2) return '<div class="sparkline-empty">Market opens after the first completed round.</div>';
  const values = history.map(item => Number(item.price));
  const min = Math.min(...values), max = Math.max(...values);
  const range = Math.max(max - min, 0.01);
  const points = values.map((value, index) => `${roundVisual(index / (values.length - 1) * 100)},${roundVisual(34 - ((value - min) / range) * 30)}`).join(" ");
  return `<svg class="sparkline" viewBox="0 0 100 38" role="img" aria-label="${escapeHtml(stock.ticker)} recent price movement"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2.4" vector-effect="non-scaling-stroke" /></svg>`;
}

function roundVisual(value) { return Math.round(value * 100) / 100; }

function stockCard(stock) {
  const change = Number(stock.lastChangePercent || 0);
  const direction = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const available = Math.max(0, stock.authorizedShares - stock.outstandingShares);
  const holdings = stock.holdings.map(holding => `<li><span>${escapeHtml(entityName(state, holding.entityId))}</span><strong>${holding.shares} · ${stockOwnershipPercent(state, stock.companyId, holding.entityId)}%</strong></li>`).join("");
  return `<article class="stock-card ${stock.status !== "active" ? "delisted" : ""}">
    <div class="row between"><div><span class="ticker">${escapeHtml(stock.ticker)}</span><h2>${escapeHtml(stock.name)}</h2></div><span class="status-pill">${titleCase(stock.status)}</span></div>
    <div class="stock-price-row"><strong>${money(stock.price)}</strong><span class="market-${direction}">${change > 0 ? "+" : ""}${change.toFixed(1)}%</span></div>
    ${stockSparkline(stock)}
    <div class="mini-grid"><span>Market cap<strong>${money(stockMarketValue(state, stock.companyId))}</strong></span><span>Shares available<strong>${available}</strong></span><span>Outstanding<strong>${stock.outstandingShares}</strong></span><span>Rent dividend<strong>${Math.round((state.settings.stockDividendRate || GAME_DEFAULTS.stockDividendRate) * 100)}%</strong></span></div>
    <ul class="holdings-list">${holdings}</ul>
  </article>`;
}

function voteControls(snapshot, votes, action, subjectId, companyId) {
  if (!snapshot) return "";
  return `<div class="vote-box"><div class="row between"><strong>${escapeHtml(getStock(state, companyId).ticker)} shareholder vote</strong><span class="muted">Record date: round ${snapshot.capturedRound}</span></div>${snapshot.holdings.map(holding => {
    const selected = votes?.[holding.entityId];
    return `<div class="vote-row"><span>${escapeHtml(entityName(state, holding.entityId))} · ${holding.shares} votes</span><div class="button-row"><button class="small ${selected === "yes" ? "signed" : "secondary"}" data-action="${action}" data-subject="${subjectId}" data-company="${companyId}" data-voter="${holding.entityId}" data-vote="yes">Yes</button><button class="small ${selected === "no" ? "danger" : "secondary"}" data-action="${action}" data-subject="${subjectId}" data-company="${companyId}" data-voter="${holding.entityId}" data-vote="no">No</button></div></div>`;
  }).join("")}</div>`;
}

function policyCard(policy) {
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
  const acquirerStock = getStock(state, merger.acquirerId);
  const targetStock = getStock(state, merger.targetId);
  const voteA = weightedVoteSummary(merger.voteSnapshots[merger.acquirerId], merger.votes[merger.acquirerId], merger.voteThresholdPercent || 50);
  const voteB = weightedVoteSummary(merger.voteSnapshots[merger.targetId], merger.votes[merger.targetId], merger.voteThresholdPercent || 50);
  const conditionalDone = merger.approval.outcome !== "approved_with_conditions" || [merger.acquirerId, merger.targetId].every(id => merger.approval.conditionAcceptedBy.includes(id));
  const approvalDone = merger.approval.outcome === "approved" || (merger.approval.outcome === "approved_with_conditions" && merger.approval.condition && merger.approval.condition !== "AI condition pending." && conditionalDone);
  const canExecute = approvalDone && voteA.passed && voteB.passed && merger.consents[merger.acquirerId] && merger.consents[merger.targetId] && merger.settlementRound && state.round >= merger.settlementRound && merger.status !== "executed";
  return `<article class="panel merger-card">
    <div class="row between"><div><span class="chip">Merger</span><h2>${escapeHtml(merger.title)}</h2></div><span class="status-pill">${titleCase(merger.status)}</span></div>
    <div class="merger-flow"><strong>${escapeHtml(acquirerStock.ticker)}</strong><span>acquires</span><strong>${escapeHtml(targetStock.ticker)}</strong></div>
    <p>Locked exchange ratio: each ${escapeHtml(targetStock.ticker)} share converts into <strong>${merger.exchangeRatio}</strong> ${escapeHtml(acquirerStock.ticker)} shares.</p>
    <div class="mini-grid"><span>Legal fee<strong>${money(merger.legalFee)}</strong></span><span>Merger fee<strong>${money(merger.mergerFee)}</strong></span><span>${escapeHtml(acquirerStock.ticker)} yes<strong>${voteA.yesPercent.toFixed(1)}%</strong></span><span>${escapeHtml(targetStock.ticker)} yes<strong>${voteB.yesPercent.toFixed(1)}%</strong></span></div>
    ${merger.approval.rolledAt ? `<div class="approval-result ${merger.approval.outcome}"><strong>${titleCase(merger.approval.outcome)}</strong><span>Fixed 10/40/50 approval system</span>${merger.approval.condition ? `<p>${escapeHtml(merger.approval.condition)}</p>` : ""}</div>` : ""}
    ${merger.approval.outcome === "approved_with_conditions" && merger.approval.condition && merger.approval.condition !== "AI condition pending." ? `<div class="signature-grid"><button class="secondary" data-action="accept-merger-condition" data-merger="${merger.id}" data-player="${merger.acquirerId}" ${merger.approval.conditionAcceptedBy.includes(merger.acquirerId) ? "disabled" : ""}>${merger.approval.conditionAcceptedBy.includes(merger.acquirerId) ? "✓ Accepted" : `${escapeHtml(acquirerStock.ticker)} accepts condition`}</button><button class="secondary" data-action="accept-merger-condition" data-merger="${merger.id}" data-player="${merger.targetId}" ${merger.approval.conditionAcceptedBy.includes(merger.targetId) ? "disabled" : ""}>${merger.approval.conditionAcceptedBy.includes(merger.targetId) ? "✓ Accepted" : `${escapeHtml(targetStock.ticker)} accepts condition`}</button></div>` : ""}
    ${approvalDone ? `<div class="signature-grid"><button class="${merger.consents[merger.acquirerId] ? "signed" : "secondary"}" data-action="sign-merger" data-merger="${merger.id}" data-player="${merger.acquirerId}" ${merger.consents[merger.acquirerId] ? "disabled" : ""}>${merger.consents[merger.acquirerId] ? "✓ " : ""}${escapeHtml(acquirerStock.ticker)} consent</button><button class="${merger.consents[merger.targetId] ? "signed" : "secondary"}" data-action="sign-merger" data-merger="${merger.id}" data-player="${merger.targetId}" ${merger.consents[merger.targetId] ? "disabled" : ""}>${merger.consents[merger.targetId] ? "✓ " : ""}${escapeHtml(targetStock.ticker)} consent</button></div>${voteControls(merger.voteSnapshots[merger.acquirerId], merger.votes[merger.acquirerId], "merger-vote", merger.id, merger.acquirerId)}${voteControls(merger.voteSnapshots[merger.targetId], merger.votes[merger.targetId], "merger-vote", merger.id, merger.targetId)}` : ""}
    <div class="callout">${merger.settlementRound ? `Settlement round: <strong>${merger.settlementRound}</strong>.` : "The two-round clock begins only after final consent and both shareholder votes pass."}</div>
    <div class="button-row right">${!merger.approval.rolledAt ? `<button class="secondary" data-action="merger-approval" data-merger="${merger.id}">Run approval</button>` : ""}<button class="primary" data-action="execute-merger" data-merger="${merger.id}" ${canExecute ? "" : "disabled"}>Complete merger</button></div>
  </article>`;
}

function antitrustCard(review) {
  const company = state.players.find(player => player.id === review.companyId);
  const outcomeText = {
    cleared: "Cleared",
    fine_200: "$200 fine paid",
    half_rent: `Half rent through round ${company?.antitrustHalfRentUntilRound || "—"}`,
    construction_freeze: `Construction frozen through round ${company?.constructionFreezeUntilRound || "—"}`,
    divestiture: review.fallbackFine ? "$150 fallback fine paid" : "Property auction required"
  }[review.outcome] || titleCase(review.outcome);
  const fineButton = review.status === "fine_due" ? `<button class="primary" data-action="pay-antitrust-fine" data-review="${review.id}">Pay ${money(review.fineAmount)} into Free Parking</button>` : "";
  const saleForm = review.status === "divestiture_due" ? `<form class="panel antitrust-sale-form" data-antitrust-sale="${review.id}"><div><strong>Complete forced-sale auction</strong><p class="muted">The table conducts the auction. Enter the winning bidder and final price; proceeds go to the divesting company.</p></div><label>Eligible property<select name="propertyId">${review.eligiblePropertyIds.map(id => { const property = state.properties.find(item => item.id === id); return `<option value="${id}">${escapeHtml(property?.name || id)}</option>`; }).join("")}</select></label><label>Winning bidder<select name="buyerId">${state.players.filter(player => !player.bankrupt && !player.mergedInto && player.id !== review.companyId).map(player => `<option value="${player.id}">${escapeHtml(player.name)}</option>`).join("")}</select></label><label>Winning price<input name="price" type="number" min="1" step="1" required placeholder="Auction price" /></label><button class="primary" type="submit">Record sale</button></form>` : "";
  return `<article class="panel"><div class="row between"><div><span class="chip">Antitrust</span><h2>${escapeHtml(company?.companyName || entityName(state, review.companyId))}</h2></div><span class="status-pill">${escapeHtml(titleCase(review.status))}</span></div><p><strong>${escapeHtml(outcomeText)}</strong></p><p class="muted">Trigger: ${escapeHtml(review.reasons.map(titleCase).join(" · "))} · Round ${review.createdRound}</p>${fineButton}${saleForm}</article>`;
}

function bankRateSparkline() {
  const history = (state.bank?.lending?.history || []).slice(-16);
  if (history.length < 2) return '<div class="sparkline-empty">The rate history begins after the first completed round.</div>';
  const values = history.map(item => Number(item.ratePercent));
  const min = Math.min(...values), max = Math.max(...values);
  const range = Math.max(max - min, 0.01);
  const points = values.map((value, index) => `${roundVisual(index / (values.length - 1) * 100)},${roundVisual(34 - ((value - min) / range) * 30)}`).join(" ");
  return `<svg class="sparkline bank-rate-line" viewBox="0 0 100 38" role="img" aria-label="Recent bank lending-rate movement"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2.4" vector-effect="non-scaling-stroke" /></svg>`;
}

function bankLoanCard(loan) {
  const borrower = state.players.find(player => player.id === loan.borrowerId);
  const canRepay = ["active", "delinquent"].includes(loan.status) && borrower && borrower.cash + 0.001 >= loan.balance;
  return `<article class="loan-row ${loan.status === "delinquent" ? "delinquent" : ""}">
    <div><div class="row gap"><strong>${escapeHtml(borrower?.name || loan.borrowerId)}</strong><span class="status-pill">${titleCase(loan.status)}</span></div><p class="muted">Borrowed ${money(loan.principal)} at ${Number(loan.ratePercent).toFixed(0)}% · due round ${loan.dueRound}</p></div>
    <div class="loan-balance"><span>Repayment</span><strong>${money(loan.balance)}</strong></div>
    ${["active", "delinquent"].includes(loan.status) ? `<button class="${canRepay ? "primary" : "secondary"}" data-action="repay-bank-loan" data-loan="${loan.id}" ${canRepay ? "" : "disabled"}>Repay in full</button>` : ""}
  </article>`;
}

function renderMarket() {
  const activeStocks = state.market.stocks.filter(stock => stock.status === "active");
  const activePlayers = state.players.filter(player => !player.bankrupt && !player.mergedInto);
  const bankQuote = getBankLendingQuote(state);
  const bankLoans = state.loans.filter(loan => loan.lenderId === SYSTEM_ENTITIES.BANK);
  const previousBankRate = state.bank.lending.history.length > 1 ? Number(state.bank.lending.history.at(-2).ratePercent) : bankQuote.ratePercent;
  const rateDirection = bankQuote.ratePercent > previousBankRate ? "up" : bankQuote.ratePercent < previousBankRate ? "down" : "flat";
  const dueBills = state.taxBills.filter(bill => bill.status === "due");
  const antitrustEligible = activePlayers.map(player => ({ player, eligibility: antitrustEligibility(state, player.id) })).filter(item => item.eligibility.eligible);
  return `<section class="page">
    <div class="section-head"><div><p class="eyebrow">Boardroom exchange</p><h1>Company stock market</h1><p>Prices move randomly after every completed four-player round. No news, explanations, or performance logic are attached.</p></div></div>
    <div class="market-rule-strip"><span><strong>20%</strong> of rent becomes dividends</span><span><strong>$${state.settings.legalFee}</strong> legal fee per filing</span><span><strong>2 rounds</strong> to settle</span><span><strong>10 / 40 / 50</strong> approval odds</span></div>
    <section class="bank-desk">
      <div class="bank-rate-panel">
        <div class="row between"><div><p class="eyebrow">Bank credit desk</p><h2>Dynamic lending rate</h2></div><span class="market-${rateDirection} rate-badge">${bankQuote.ratePercent.toFixed(0)}%</span></div>
        <p>The rate rises as bank cash is depleted, falls as liquidity returns, and receives a bounded random spread once each round.</p>
        ${bankRateSparkline()}
        <div class="mini-grid"><span>Bank cash<strong>${money(bankQuote.cash)}</strong></span><span>Available to lend<strong>${money(bankQuote.availableLiquidity)}</strong></span><span>Liquidity base rate<strong>${bankQuote.baseRatePercent.toFixed(0)}%</strong></span><span>Random spread<strong>${bankQuote.randomSpreadPercent >= 0 ? "+" : ""}${bankQuote.randomSpreadPercent.toFixed(0)}%</strong></span><span>Emergency liquidity<strong>${money(bankQuote.emergencyCredit)}</strong></span><span>Rate range<strong>${GAME_DEFAULTS.bankRateMinimumPercent}%–${GAME_DEFAULTS.bankRateMaximumPercent}%</strong></span></div>
        ${bankQuote.emergencyCredit > 0 ? `<div class="voice-warning"><strong>Emergency liquidity active:</strong> required bank payouts were honored beyond available cash. New bank loans are suspended and the lending rate remains at ${GAME_DEFAULTS.bankRateMaximumPercent}% until bank receipts repay ${money(bankQuote.emergencyCredit)}.</div>` : ""}
        <div class="callout">Current loans lock this rate for <strong>${bankQuote.termRounds} rounds</strong>. One unpaid bank loan is allowed per company; the maximum new loan is <strong>${money(bankQuote.maximumSingleLoan)}</strong>. All principal, interest, prices, taxes, dividends, and settlements use whole Monopoly dollars.</div>
      </div>
      <form id="bankLoanForm" class="panel bank-loan-form"><div class="panel-icon">🏦</div><h2>Borrow from the bank</h2><p class="muted">Immediate funding. No legal filing, approval randomizer, or settlement lag.</p><label>Borrower<select name="borrowerId">${activePlayers.map(player => `<option value="${player.id}">${escapeHtml(player.name)} — ${money(player.cash)}</option>`).join("")}</select></label><label>Principal<input name="principal" type="number" min="${bankQuote.minimumLoan}" max="${bankQuote.maximumSingleLoan}" step="10" value="${Math.min(200, bankQuote.maximumSingleLoan)}" required /></label><div class="mini-grid"><span>Locked rate<strong>${bankQuote.ratePercent.toFixed(0)}%</strong></span><span>Term<strong>${bankQuote.termRounds} rounds</strong></span></div><button class="primary full" type="submit" ${bankQuote.maximumSingleLoan < bankQuote.minimumLoan ? "disabled" : ""}>Issue bank loan</button></form>
    </section>
    <div class="stack bank-loan-list">${bankLoans.length ? bankLoans.map(bankLoanCard).join("") : '<div class="empty-panel">No bank loans have been issued.</div>'}</div>
    <div class="stock-grid">${state.market.stocks.map(stockCard).join("")}</div>
    <div class="action-grid">
      <form id="primaryStockForm" class="panel featured"><div class="panel-icon">📈</div><h2>Raise capital</h2><p class="muted">Issue new voting shares at the current locked market price. Proceeds go to the company for property, houses, hotels, or taxes.</p><label>Company<select name="companyId">${activeStocks.map(stock => `<option value="${stock.companyId}">${escapeHtml(stock.ticker)} — ${money(stock.price)} · ${roundVisual(stock.authorizedShares - stock.outstandingShares)} available</option>`).join("")}</select></label><label>Investor<select name="buyerId">${activePlayers.map(player => `<option value="${player.id}">${escapeHtml(player.name)}</option>`).join("")}</select></label><label>New shares<input name="shares" type="number" min="1" step="1" value="10" required /></label><button class="primary full" type="submit">File capital raise</button></form>
      <form id="secondaryStockForm" class="panel"><div class="panel-icon">↔️</div><h2>Trade existing shares</h2><p class="muted">The price locks when filed. Ownership and cash move only after approval and two-round settlement.</p><label>Stock<select name="companyId">${activeStocks.map(stock => `<option value="${stock.companyId}">${escapeHtml(stock.ticker)} — ${money(stock.price)}</option>`).join("")}</select></label><div class="two-col"><label>Seller<select name="sellerId">${state.players.map(player => `<option value="${player.id}">${escapeHtml(player.name)}</option>`).join("")}</select></label><label>Buyer<select name="buyerId">${activePlayers.map(player => `<option value="${player.id}">${escapeHtml(player.name)}</option>`).join("")}</select></label></div><label>Shares<input name="shares" type="number" min="1" step="1" value="5" required /></label><button class="secondary full" type="submit">File stock trade</button></form>
      <form id="policyForm" class="panel"><div class="panel-icon">🗳️</div><h2>Corporate policy</h2><p class="muted">Shareholders vote by record-date shares. Use policies for development budgets, property strategy, dividend promises, or management limits.</p><label>Company<select name="companyId">${activeStocks.map(stock => `<option value="${stock.companyId}">${escapeHtml(stock.ticker)}</option>`).join("")}</select></label><label>Policy type<select name="type"><option value="development">House / hotel development</option><option value="financing">Financing</option><option value="property_strategy">Property strategy</option><option value="governance">Governance</option><option value="custom">Custom</option></select></label><label>Title<input name="title" required placeholder="Authorize orange-group development budget" /></label><label>Exact policy<textarea name="terms" required rows="4" placeholder="Authorize up to $450 for evenly built houses on the orange group through round 10."></textarea></label><button class="secondary full" type="submit">File policy</button></form>
      <form id="mergerForm" class="panel"><div class="panel-icon">🏢</div><h2>Propose merger</h2><p class="muted">The acquiring company pays both the legal fee and the nonrefundable merger fee. Both companies’ shareholders vote.</p><label>Acquirer<select name="acquirerId">${activePlayers.map(player => `<option value="${player.id}">${escapeHtml(getStock(state, player.id).ticker)} — ${escapeHtml(player.name)}</option>`).join("")}</select></label><label>Target<select name="targetId">${activePlayers.map(player => `<option value="${player.id}">${escapeHtml(getStock(state, player.id).ticker)} — ${escapeHtml(player.name)}</option>`).join("")}</select></label><label>Merger name<input name="title" placeholder="The Atlantic Property Consolidation" /></label><div class="callout">Nonrefundable filing cost: <strong>${money(state.settings.legalFee + state.settings.mergerFee)}</strong> into Free Parking.</div><button class="secondary full" type="submit">File merger</button></form>
    </div>
    ${dueBills.length ? `<div class="section-head"><div><p class="eyebrow">Tax Day</p><h2>Outstanding bills</h2></div></div><div class="stack">${dueBills.map(bill => `<article class="panel tax-bill"><div><h3>${escapeHtml(entityName(state, bill.playerId))}</h3><p class="muted">Round ${bill.round} · Property ${money(bill.propertyTax)} + net-worth income tax ${money(bill.incomeTax)}</p></div><strong>${money(bill.total)}</strong><button class="primary" data-action="pay-tax" data-tax="${bill.id}">Pay into Free Parking</button></article>`).join("")}</div>` : ""}
    <div class="panel free-parking-desk"><div><p class="eyebrow">Free Parking jackpot</p><h2>${money(state.freeParkingPot)}</h2><p>Taxes, legal fees, merger fees, and designated fines accumulate here.</p></div><div class="button-row">${activePlayers.map(player => `<button class="secondary" data-action="collect-free-parking" data-player="${player.id}">${escapeHtml(player.name)} landed here</button>`).join("")}</div></div>
    <div class="section-head"><div><p class="eyebrow">Market power</p><h2>Antitrust</h2><p>Each company receives at most one review after a merger, four railroads, or three complete color groups.</p></div></div>
    ${antitrustEligible.length ? `<div class="button-row">${antitrustEligible.map(({ player, eligibility }) => `<button class="secondary" data-action="run-antitrust" data-player="${player.id}">Review ${escapeHtml(getStock(state, player.id).ticker)} · ${escapeHtml(eligibility.reasons.map(titleCase).join(" / "))}</button>`).join("")}</div>` : ""}
    <div class="stack">${state.antitrustReviews.map(antitrustCard).join("") || '<div class="empty-panel">No antitrust review has been triggered.</div>'}</div>
    <div class="section-head"><div><p class="eyebrow">Governance</p><h2>Policies</h2></div></div><div class="stack">${state.policies.map(policyCard).join("") || '<div class="empty-panel">No corporate policies filed.</div>'}</div>
    <div class="section-head"><div><p class="eyebrow">Consolidation</p><h2>Mergers</h2></div></div><div class="stack">${state.mergers.map(mergerCard).join("") || '<div class="empty-panel">No mergers filed.</div>'}</div>
  </section>`;
}

function assetFields(prefix, ownerId) {
  const owned = state.properties.filter(p => p.ownerShares.some(s => s.entityId === ownerId));
  return `<div class="asset-builder">
    <label>Cash<input name="${prefix}Cash" type="number" min="0" step="1" placeholder="0" /></label>
    <label>Property<select name="${prefix}Property"><option value="">None</option>${owned.map(p => `<option value="${p.id}">${escapeHtml(p.name)} — owns ${p.ownerShares.find(s => s.entityId === ownerId).percent}%</option>`).join("")}</select></label>
    <label>Property share %<input name="${prefix}Percent" type="number" min="1" max="100" value="100" /></label>
  </div>`;
}

function renderDeals() {
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
      <div class="callout"><strong>Approval is fixed:</strong> 10% approved as written, 40% approved with one DeepSeek-defined condition, and 50% rejected. No dice and no rerolls.</div>
      <button class="primary full" type="submit">File deal · ${money(state.settings.legalFee)} legal fee</button>
    </form>
    <div class="section-head"><div><p class="eyebrow">Deal room</p><h2>${state.deals.length ? "Current proposals" : "No proposals yet"}</h2></div></div>
    <div class="stack">${state.deals.map(dealCard).join("") || '<div class="empty-panel">Create a deal above. Filing fees, approval, signatures, shareholder votes, settlement dates, and execution are all logged.</div>'}</div>
  </section>`;
}

function assetSummary(assets) {
  if (!assets?.length) return "Nothing immediate";
  return assets.map(asset => {
    if (asset.type === "cash") return money(asset.amount);
    if (asset.type === "property_share") return `${asset.percent || 100}% of ${state.properties.find(p => p.id === asset.propertyId)?.name || "property"}`;
    if (asset.type === "company_share") return `${asset.shares} ${getStock(state, asset.companyId).ticker} voting shares${asset.issuance ? " (new issue)" : ""} @ ${money(asset.lockedPrice || getStock(state, asset.companyId).price)}`;
    if (asset.type === "jail_card") return `${asset.quantity || 1} jail card(s)`;
    return titleCase(asset.type);
  }).join(" + ");
}

function dealCard(deal) {
  const fairness = dealFairness(state, deal);
  const signedA = Boolean(deal.signatures[deal.proposerId]);
  const signedB = Boolean(deal.signatures[deal.counterpartyId]);
  const conditionDefined = deal.approval.outcome !== "approved_with_conditions" || (deal.approval.condition && deal.approval.condition !== "AI condition pending.");
  const conditionalComplete = deal.approval.outcome !== "approved_with_conditions" || [deal.proposerId, deal.counterpartyId].every(id => deal.approval.conditionAcceptedBy.includes(id));
  const approvalGood = deal.approval.outcome === "approved" || (deal.approval.outcome === "approved_with_conditions" && conditionDefined && conditionalComplete);
  const votesPassed = (deal.requiredCompanyVoteIds || []).every(companyId => weightedVoteSummary(deal.voteSnapshots?.[companyId], deal.votes?.[companyId], deal.voteThresholdPercent || 50).passed);
  const executable = signedA && signedB && approvalGood && votesPassed && deal.settlementRound && state.round >= deal.settlementRound && deal.status !== "executed";
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
    ${deal.approval.outcome === "approved_with_conditions" && conditionDefined ? `<div class="signature-grid"><button class="secondary" data-action="accept-condition" data-deal="${deal.id}" data-player="${deal.proposerId}" ${deal.approval.conditionAcceptedBy.includes(deal.proposerId) ? "disabled" : ""}>${deal.approval.conditionAcceptedBy.includes(deal.proposerId) ? "✓ Condition accepted" : `${escapeHtml(entityName(state, deal.proposerId))}: accept condition`}</button><button class="secondary" data-action="accept-condition" data-deal="${deal.id}" data-player="${deal.counterpartyId}" ${deal.approval.conditionAcceptedBy.includes(deal.counterpartyId) ? "disabled" : ""}>${deal.approval.conditionAcceptedBy.includes(deal.counterpartyId) ? "✓ Condition accepted" : `${escapeHtml(entityName(state, deal.counterpartyId))}: accept condition`}</button></div>` : ""}
    ${approvalGood ? `<div class="signature-grid"><button class="${signedA ? "signed" : "secondary"}" data-action="sign-deal" data-deal="${deal.id}" data-player="${deal.proposerId}" ${signedA || ["executed", "rejected"].includes(deal.status) ? "disabled" : ""}>${signedA ? "✓ " : ""}${escapeHtml(entityName(state, deal.proposerId))}</button><button class="${signedB ? "signed" : "secondary"}" data-action="sign-deal" data-deal="${deal.id}" data-player="${deal.counterpartyId}" ${signedB || ["executed", "rejected"].includes(deal.status) ? "disabled" : ""}>${signedB ? "✓ " : ""}${escapeHtml(entityName(state, deal.counterpartyId))}</button></div>` : ""}
    ${(deal.requiredCompanyVoteIds || []).map(companyId => voteControls(deal.voteSnapshots[companyId], deal.votes[companyId], "deal-vote", deal.id, companyId)).join("")}
    <div class="callout">${deal.settlementRound ? `Final deal accepted in round ${deal.readyRound}; settlement is permitted in round <strong>${deal.settlementRound}</strong>.` : "The two-round settlement clock begins only after approval, final signatures, accepted conditions, and any required shareholder vote."}</div>
    <div class="button-row right">
      ${!deal.approval.rolledAt && deal.status !== "rejected" ? `<button class="secondary" data-action="roll-approval" data-deal="${deal.id}">Run 10/40/50 approval</button>` : ""}
      <button class="primary" data-action="execute-deal" data-deal="${deal.id}" ${!executable ? "disabled" : ""}>Settle deal</button>
    </div>
  </article>`;
}

function renderLegal() {
  const statusClass = judgeHealth.available ? "success" : "warning";
  const openCases = state.disputes.filter(dispute => dispute.status === "open").length;
  return `<section class="page legal-page">
    <div class="section-head"><div><p class="eyebrow">Contract & Legal Desk</p><h1>Document, review, and arbitrate in one place</h1><p>Create the agreement once, then attach every question, ruling, and table decision to that same record.</p></div></div>
    <div class="legal-status-bar">
      <div><span class="chip ${statusClass}">${judgeHealth.available ? "DeepSeek legal review ready" : "Local review available"}</span><strong>${escapeHtml(judgeHealth.available ? judgeHealth.model || "DeepSeek" : "DeepSeek not configured")}</strong><small>${escapeHtml(judgeHealth.message)}</small></div>
      <div><span>Contracts</span><strong>${state.contracts.length}</strong></div>
      <div><span>Open cases</span><strong>${openCases}</strong></div>
      <button class="secondary" data-action="check-judge">Check connection</button>
    </div>

    <div class="legal-workbench">
      <form id="contractForm" class="panel featured">
        <div><p class="eyebrow">Step 1</p><h2>Document a contract</h2><p class="muted">The saved wording becomes the official text used in later review.</p></div>
        <div class="two-col"><label>Title<input name="title" required placeholder="Orange Group Development Agreement" /></label><label>Type<select name="type"><option value="custom">Custom</option><option value="loan">Loan</option><option value="alliance">Alliance</option><option value="rent_immunity">Rent immunity</option><option value="joint_venture">Joint venture</option><option value="merger">Merger support</option></select></label></div>
        <fieldset><legend>Parties</legend><div class="checkbox-grid">${state.players.filter(p => !p.bankrupt && !p.mergedInto).map(player => `<label><input type="checkbox" name="partyIds" value="${player.id}" /> ${escapeHtml(player.name)}</label>`).join("")}</div></fieldset>
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

    <div class="section-head"><div><p class="eyebrow">Official records</p><h2>Contracts and attached legal history</h2></div></div>
    <div class="stack">${state.contracts.map(legalContractCard).join("") || '<div class="empty-panel">No contracts yet. Document the agreement above before relying on it.</div>'}</div>

    ${state.disputes.some(dispute => !dispute.linkedContractId) ? `<div class="section-head"><h2>General rule cases</h2></div><div class="stack">${state.disputes.filter(dispute => !dispute.linkedContractId).map(disputeCard).join("")}</div>` : ""}
    ${state.judgements.length ? `<div class="section-head"><h2>All rulings</h2></div><div class="stack">${state.judgements.map(judgementCard).join("")}</div>` : ""}
  </section>`;
}

function legalContractCard(contract) {
  const cases = state.disputes.filter(dispute => dispute.linkedContractId === contract.id);
  const judgementIds = new Set(cases.map(item => item.id));
  const rulings = state.judgements.filter(item => judgementIds.has(item.disputeId));
  const latest = rulings[0];
  return `<article class="panel contract-card legal-contract-card">
    <div class="row between"><div><span class="chip">${titleCase(contract.type)}</span><h2>${escapeHtml(contract.title)}</h2></div><span class="status-pill status-${contract.status}">${titleCase(contract.status)}</span></div>
    <p class="muted">${contract.partyIds.map(id => entityName(state, id)).map(escapeHtml).join(" · ")} · Created round ${contract.createdRound}${contract.expiresRound ? ` · Expires round ${contract.expiresRound}` : ""}</p>
    <div class="contract-terms">${escapeHtml(contract.terms)}</div>
    <div class="contract-control-row"><label>Status<select data-contract-status="${contract.id}"><option value="draft" ${contract.status === "draft" ? "selected" : ""}>Draft</option><option value="active" ${contract.status === "active" ? "selected" : ""}>Active</option><option value="fulfilled" ${contract.status === "fulfilled" ? "selected" : ""}>Fulfilled</option><option value="breached" ${contract.status === "breached" ? "selected" : ""}>Breached</option><option value="disputed" ${contract.status === "disputed" ? "selected" : ""}>Disputed</option><option value="voided" ${contract.status === "voided" ? "selected" : ""}>Voided</option><option value="expired" ${contract.status === "expired" ? "selected" : ""}>Expired</option></select></label><div class="legal-counts"><span>Cases<strong>${cases.length}</strong></span><span>Rulings<strong>${rulings.length}</strong></span></div><button class="secondary" data-review-contract="${contract.id}">Review this contract</button></div>
    ${latest ? `<div class="approval-result"><strong>Latest ruling: ${escapeHtml(titleCase(latest.verdict))}</strong><span>${Math.round(latest.confidence * 100)}% confidence · ${escapeHtml(latest.model)}</span></div>` : ""}
    ${cases.length ? `<div class="attached-cases">${cases.map(disputeCard).join("")}</div>` : ""}
  </article>`;
}

function disputeCard(dispute) {
  const latest = state.judgements.find(j => j.disputeId === dispute.id);
  return `<article class="dispute-card embedded-case">
    <div class="row between"><div><span class="chip">${titleCase(dispute.status)}</span><h3>${escapeHtml(dispute.title)}</h3></div><span class="muted">Round ${dispute.createdRound}</span></div>
    <p><strong>Question:</strong> ${escapeHtml(dispute.issue)}</p>
    ${dispute.evidence ? `<p><strong>Evidence:</strong> ${escapeHtml(dispute.evidence)}</p>` : ""}
    ${dispute.requestedRemedy ? `<p><strong>Requested remedy:</strong> ${escapeHtml(dispute.requestedRemedy)}</p>` : ""}
    ${latest ? `<div class="approval-result"><strong>Latest ruling: ${escapeHtml(titleCase(latest.verdict))}</strong><span>${Math.round(latest.confidence * 100)}% confidence · ${escapeHtml(latest.model)}</span></div>` : ""}
    <div class="button-row right"><button class="secondary" data-action="local-judge" data-dispute="${dispute.id}">Local rule test</button><button class="primary" data-action="ai-judge" data-dispute="${dispute.id}" ${!judgeHealth.available ? "disabled" : ""}>DeepSeek legal review</button></div>
  </article>`;
}

function judgementCard(judgement) {
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

function renderAssets() {
  const groups = [...new Set(state.properties.map(p => p.group))];
  return `<section class="page">
    <div class="section-head"><div><p class="eyebrow">Property register</p><h1>Assets and improvements</h1><p>Ownership percentages must total 100%. Houses use 0–4; 5 represents a hotel.</p></div></div>
    <div class="group-summary">${groups.map(group => {
      const props = state.properties.filter(p => p.group === group);
      const owned = props.filter(p => p.ownerShares.length).length;
      return `<div><span>${escapeHtml(group)}</span><strong>${owned}/${props.length}</strong></div>`;
    }).join("")}</div>
    <div class="property-grid">${state.properties.map(propertyCard).join("")}</div>
  </section>`;
}

function eventRow(event) {
  return `<article class="event-row"><div class="event-dot"></div><div><strong>${escapeHtml(event.description)}</strong><span>Round ${event.round} · ${dateTime(event.at)} · ${titleCase(event.type)}</span></div></article>`;
}

function renderLedger() {
  return `<section class="page">
    <div class="section-head"><div><p class="eyebrow">Audit trail</p><h1>Ledger</h1><p>Newest entries first. Undo is for clerical mistakes, not strategic regret.</p></div><button class="secondary" data-action="export-ledger">Export game</button></div>
    <div class="timeline ledger-full">${state.ledger.map(eventRow).join("")}</div>
  </section>`;
}

function renderRules() {
  const categories = [...new Set(RULES.map(rule => rule.category))];
  return `<section class="page rules-page">
    <div class="section-head"><div><p class="eyebrow">Version ${RULEBOOK_VERSION}</p><h1>Corporate Chaos House Rules</h1><p>Conventional Monopoly remains the baseline. These rules govern the extra nonsense.</p></div></div>
    <div class="rule-index">${categories.map(category => `<a href="#rule-${category.toLowerCase().replaceAll(" ", "-")}">${escapeHtml(category)}</a>`).join("")}</div>
    ${categories.map(category => `<section class="rule-category" id="rule-${category.toLowerCase().replaceAll(" ", "-")}"><h2>${escapeHtml(category)}</h2>${RULES.filter(rule => rule.category === category).map(rule => `<article class="rule"><span>${rule.id}</span><div><h3>${escapeHtml(rule.title)}</h3><p>${escapeHtml(rule.text)}</p></div></article>`).join("")}</section>`).join("")}
    <div class="callout silly"><strong>Supreme administrative principle:</strong> Personal grudges should expire when the game ends. Corporate grudges may survive one snack break.</div>
  </section>`;
}

function syncSettingsControls() {
  if (!state) return;
  const judge = document.querySelector("#judgeModeSetting");
  const parking = document.querySelector("#freeParkingSetting");
  const voiceReadback = document.querySelector("#voiceReadbackSetting");
  if (judge) judge.value = state.settings.judgeMode;
  if (parking) parking.checked = state.settings.freeParkingJackpot;
  if (voiceReadback) voiceReadback.checked = state.settings.voiceReadback !== false;
}

async function checkJudgeHealth() {
  judgeHealth.checked = true;
  judgeHealth.message = "Checking the included local server…";
  if (["legal", "voice"].includes(activeTab)) render();
  try {
    const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Judge server unavailable");
    const data = await response.json();
    judgeHealth = { checked: true, available: Boolean(data.deepseekConfigured), model: data.model, voiceModel: data.voiceInterpreter?.model || data.model, transcriptionConfigured: Boolean(data.transcription?.configured), transcriptionModel: data.transcription?.model || null, message: `${data.deepseekConfigured ? `DeepSeek ${data.model} is configured for detailed interpretation and judging.` : "DEEPSEEK_API_KEY is not configured."} ${data.transcription?.configured ? `OpenAI ${data.transcription.model} is configured for audio transcription.` : "OPENAI_API_KEY is not configured, so live audio transcription is unavailable."}` };
  } catch {
    judgeHealth = { checked: true, available: false, model: null, voiceModel: null, transcriptionConfigured: false, transcriptionModel: null, message: "Open the app through the included Node server to enable OpenAI transcription and DeepSeek interpretation. Typed commands and the local rule test still work." };
  }
  if (["legal", "voice"].includes(activeTab)) render();
}

async function askAiJudge(disputeId) {
  showToast("Preparing the evidence packet…");
  const packet = buildJudgePacket(state, disputeId);
  const response = await fetch("/api/judge", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packet })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "DeepSeek judge request failed.");
  const judgement = { ...data.judgement, model: data.model, mode: "ai", evidenceSnapshot: data.evidenceSnapshot };
  setState(recordJudgement(state, disputeId, judgement), "DeepSeek ruling recorded");
}


function approvalRecord(kind, id) {
  if (kind === "deal") return state.deals.find(item => item.id === id);
  if (kind === "policy") return state.policies.find(item => item.id === id);
  if (kind === "merger") return state.mergers.find(item => item.id === id);
  return null;
}

function fallbackConditionData() {
  const choices = [
    { condition: "Add one extra round to the settlement or effective-date delay.", mechanic: "extra_settlement_round", value: 1 },
    { condition: "The applicable shareholder vote must exceed 60% of outstanding voting shares.", mechanic: "supermajority_vote", value: 60 },
    { condition: "The benefiting company must grant the other party one rent-free landing within three rounds after settlement.", mechanic: "rent_relief", value: null },
    { condition: "The final terms and all later amendments must remain publicly visible in the ledger.", mechanic: "public_disclosure", value: null },
    { condition: "No stock or property named in the filing may be resold before settlement completes.", mechanic: "asset_lock", value: null }
  ];
  return choices[Math.floor(Math.random() * choices.length)];
}

async function defineApprovalCondition(kind, id) {
  const record = approvalRecord(kind, id);
  if (!record) throw new Error("Approval record not found.");
  let conditionData;
  try {
    const response = await fetch("/api/approval-condition", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        record,
        context: {
          round: state.round,
          legalFee: state.settings.legalFee,
          mergerFee: state.settings.mergerFee,
          settlementLagRounds: state.settings.dealSettlementLagRounds,
          players: state.players.map(player => ({ id: player.id, name: player.name, cash: player.cash, mergedInto: player.mergedInto })),
          stocks: state.market.stocks.map(stock => ({ companyId: stock.companyId, ticker: stock.ticker, price: stock.price, outstandingShares: stock.outstandingShares, holdings: stock.holdings }))
        }
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "AI condition request failed.");
    conditionData = { condition: data.condition, mechanic: data.mechanic, value: data.value };
  } catch (error) {
    console.warn(error);
    conditionData = fallbackConditionData();
    showToast("DeepSeek condition unavailable; a transparent local condition was used.", "error");
  }
  if (kind === "deal") setState(setDealApprovalCondition(state, id, conditionData.condition, conditionData.mechanic === "none" ? "deepseek" : "deepseek_structured", conditionData), "Approval condition defined");
  if (kind === "policy") setState(setPolicyApprovalCondition(state, id, conditionData.condition, conditionData.mechanic === "none" ? "deepseek" : "deepseek_structured", conditionData), "Policy condition defined");
  if (kind === "merger") setState(setMergerApprovalCondition(state, id, conditionData.condition, conditionData.mechanic === "none" ? "deepseek" : "deepseek_structured", conditionData), "Merger condition defined");
}

async function runFixedApproval(kind, id) {
  let next;
  if (kind === "deal") next = rollDealApproval(state, id);
  if (kind === "policy") next = rollPolicyApproval(state, id);
  if (kind === "merger") next = rollMergerApproval(state, id);
  if (!next) throw new Error("Unknown approval type.");
  setState(next, "10/40/50 approval result recorded");
  const record = approvalRecord(kind, id);
  if (record?.approval?.outcome === "approved_with_conditions") await defineApprovalCondition(kind, id);
}

function openConfirm(title, text, action) {
  document.querySelector("#confirmTitle").textContent = title;
  document.querySelector("#confirmText").textContent = text;
  pendingConfirm = action;
  openDialog(confirmDialog);
}

function downloadFile(filename, content, type = "application/json") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function addSetupPlayer(value = "") {
  const container = document.querySelector("#playerInputs");
  const count = container.children.length;
  if (count >= 4) return;
  const label = document.createElement("label");
  label.innerHTML = `Player-company ${count + 1}<input name="playerName" value="${escapeHtml(value)}" maxlength="24" placeholder="Executive ${count + 1}" required />`;
  container.append(label);
}

function resetSetupInputs() {
  const container = document.querySelector("#playerInputs");
  container.innerHTML = "";
  ["Alex", "Sam", "Jordan", "Priya"].forEach(addSetupPlayer);
}

app.addEventListener("click", async event => {
  const button = event.target.closest("button, [data-go], [data-go-action], [data-quick-player], [data-review-contract]");
  if (!button) return;
  try {
    if (button.id === "openSetup") return openDialog(setupDialog);
    if (button.dataset.voiceExample) { voiceState.transcript = button.dataset.voiceExample; voiceState.plan = null; activeTab = "voice"; return render(); }
    if (button.dataset.goAction) {
      activeTab = "actions";
      render();
      return queueMicrotask(() => {
        const target = document.querySelector(`#${button.dataset.goAction}`);
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
        target?.querySelector("select, input, textarea")?.focus();
      });
    }
    if (button.dataset.go) { activeTab = button.dataset.go; return render(); }
    if (button.dataset.quickPlayer) { activeTab = "actions"; render(); queueMicrotask(() => { const to = document.querySelector('#cashTransferForm select[name="toId"]'); if (to) to.value = button.dataset.quickPlayer; }); return; }
    if (button.dataset.reviewContract) {
      const contract = state.contracts.find(item => item.id === button.dataset.reviewContract);
      activeTab = "legal";
      render();
      return queueMicrotask(() => {
        const linked = document.querySelector("#legalLinkedContract");
        const title = document.querySelector("#legalCaseTitle");
        const issue = document.querySelector("#legalCaseIssue");
        if (linked) linked.value = contract?.id || "";
        if (title && contract) title.value = `Review of ${contract.title}`;
        if (issue && contract) issue.value = "Review this documented contract for clarity, enforceability under the house rules, missing terms, conflicting obligations, and the correct remedy for any stated dispute.";
        document.querySelector("[data-legal-review-form]")?.scrollIntoView({ behavior: "smooth", block: "start" });
        issue?.focus();
      });
    }
    const action = button.dataset.action;
    if (action === "toggle-voice") return await toggleVoiceCapture();
    if (action === "interpret-voice") return await interpretVoiceTranscript();
    if (action === "save-voice-note") return saveTranscriptAsVoiceNote();
    if (action === "clear-voice") { voiceTranscriber.abort(); voiceState = { ...voiceState, transcript: "", interim: "", plan: null, listening: false, interpreting: false, status: "Tap the microphone and speak one or more game actions.", error: null }; return render(); }
    if (action === "discard-voice-plan") { voiceState.plan = null; voiceState.status = "Interpretation discarded. Edit or speak again."; return render(); }
    if (action === "apply-voice-plan") return openConfirm("Log the selected voice actions?", "The game engine will validate every action. The entire confirmed voice batch can be undone as one clerical correction.", () => applySelectedVoicePlan());
    if (action === "advance-turn") return setState(advanceTurn(state), "Turn advanced");
    if (action === "pass-go") {
      const active = state.players[state.activePlayerIndex];
      return openConfirm("Collect $200 for passing GO?", `${active.name} will receive $200 from the bank.`, () => setState(passGo(state, active.id), `${active.name} collected $200`));
    }
    if (action === "sign-deal") return setState(signDeal(state, button.dataset.deal, button.dataset.player), "Deal accepted");
    if (action === "roll-approval") return await runFixedApproval("deal", button.dataset.deal);
    if (action === "accept-condition") return setState(acceptDealCondition(state, button.dataset.deal, button.dataset.player), "Condition accepted");
    if (action === "deal-vote") return setState(castDealVote(state, button.dataset.subject, button.dataset.company, button.dataset.voter, button.dataset.vote), "Shareholder vote recorded");
    if (action === "policy-approval") return await runFixedApproval("policy", button.dataset.policy);
    if (action === "policy-vote") return setState(castPolicyVote(state, button.dataset.subject, button.dataset.voter, button.dataset.vote), "Policy vote recorded");
    if (action === "activate-policy") return setState(activatePolicy(state, button.dataset.policy), "Policy activated");
    if (action === "merger-approval") return await runFixedApproval("merger", button.dataset.merger);
    if (action === "accept-merger-condition") return setState(acceptMergerCondition(state, button.dataset.merger, button.dataset.player), "Merger condition accepted");
    if (action === "sign-merger") return setState(signMerger(state, button.dataset.merger, button.dataset.player), "Merger consent recorded");
    if (action === "merger-vote") return setState(castMergerVote(state, button.dataset.subject, button.dataset.company, button.dataset.voter, button.dataset.vote), "Merger vote recorded");
    if (action === "execute-merger") return openConfirm("Complete this merger?", "The target company will lose its separate turn, its assets will combine with the acquirer, and its shares will convert at the locked ratio.", () => setState(executeMerger(state, button.dataset.merger), "Merger completed"));
    if (action === "pay-tax") return setState(payTaxBill(state, button.dataset.tax), "Tax bill paid into Free Parking");
    if (action === "repay-bank-loan") return openConfirm("Repay this bank loan in full?", "The borrower’s cash will decrease and the bank’s liquidity will increase immediately.", () => setState(repayBankLoan(state, button.dataset.loan), "Bank loan repaid"));
    if (action === "run-antitrust") return openConfirm("Run this company’s one antitrust review?", "The result is final and selected electronically from the five written penalties.", () => setState(runAntitrustReview(state, button.dataset.player), "Antitrust review completed"));
    if (action === "pay-antitrust-fine") return setState(payAntitrustFine(state, button.dataset.review), "Antitrust fine paid");
    if (action === "collect-free-parking") return openConfirm("Collect the Free Parking jackpot?", `${entityName(state, button.dataset.player)} must have landed directly on Free Parking.`, () => setState(collectFreeParking(state, button.dataset.player), "Free Parking jackpot collected"));
    if (action === "execute-deal") return openConfirm("Settle this deal?", "The locked assets and cash will move now because the two-round settlement date has arrived.", () => setState(executeDeal(state, button.dataset.deal), "Deal settled"));
    if (action === "local-judge") return setState(recordJudgement(state, button.dataset.dispute, { ...localRuleTest(state, button.dataset.dispute), evidenceSnapshot: buildJudgePacket(state, button.dataset.dispute) }), "Local rule test recorded");
    if (action === "ai-judge") { button.disabled = true; button.textContent = "Judging…"; await askAiJudge(button.dataset.dispute); return; }
    if (action === "check-judge") return checkJudgeHealth();
    if (action === "toggle-mortgage") { const property = state.properties.find(p => p.id === button.dataset.property); return openConfirm(property.mortgaged ? "Unmortgage property?" : "Mortgage property?", property.mortgaged ? "Owners will pay the conventional mortgage plus 10%, divided by ownership share." : "Mortgage proceeds will be divided among owners by ownership share.", () => setState(setMortgage(state, property.id, !property.mortgaged), "Mortgage status updated")); }
    if (action === "building-up" || action === "building-down") { const property = state.properties.find(p => p.id === button.dataset.property); const target = property.buildings + (action === "building-up" ? 1 : -1); return setState(setBuildings(state, property.id, target), "Buildings updated"); }
    if (action === "export-ledger") return downloadFile(`${state.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`, exportGame(state));
  } catch (error) { fail(error); render(); }
});

app.addEventListener("change", async event => {
  if (event.target?.id !== "voiceAudioFile") return;
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  await transcribeVoiceFile(file);
});

app.addEventListener("submit", event => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  try {
    if (form.id === "cashTransferForm") return setState(transferCash(state, data.get("fromId"), data.get("toId"), data.get("amount"), data.get("memo") || "Payment"), "Money transferred");
    if (form.id === "buyPropertyForm") return setState(acquirePropertyFromBank(state, data.get("playerId"), data.get("propertyId"), data.get("price") ? Number(data.get("price")) : null), "Property purchased");
    if (form.id === "rentForm") return setState(payRent(state, data.get("visitorId"), data.get("propertyId"), Number(data.get("diceTotal") || 0), Number(data.get("discount") || 0)), "Rent paid");
    if (form.id === "bankLoanForm") return setState(takeBankLoan(state, data.get("borrowerId"), Number(data.get("principal"))), "Bank loan issued");
    if (form.id === "dealForm") {
      const proposerGives = [], counterpartyGives = [];
      if (Number(data.get("proposerCash")) > 0) proposerGives.push({ type: "cash", amount: Number(data.get("proposerCash")) });
      if (data.get("proposerProperty")) proposerGives.push({ type: "property_share", propertyId: data.get("proposerProperty"), percent: Number(data.get("proposerPercent") || 100) });
      if (Number(data.get("counterpartyCash")) > 0) counterpartyGives.push({ type: "cash", amount: Number(data.get("counterpartyCash")) });
      if (data.get("counterpartyProperty")) counterpartyGives.push({ type: "property_share", propertyId: data.get("counterpartyProperty"), percent: Number(data.get("counterpartyPercent") || 100) });
      return setState(createDeal(state, { title: data.get("title"), proposerId: data.get("proposerId"), counterpartyId: data.get("counterpartyId"), proposerGives, counterpartyGives, terms: data.get("terms") }), "Deal filed");
    }
    if (form.id === "primaryStockForm") return setState(createPrimaryStockOffering(state, { companyId: data.get("companyId"), buyerId: data.get("buyerId"), shares: Number(data.get("shares")) }), "Capital raise filed");
    if (form.id === "secondaryStockForm") return setState(createSecondaryStockTrade(state, { companyId: data.get("companyId"), sellerId: data.get("sellerId"), buyerId: data.get("buyerId"), shares: Number(data.get("shares")) }), "Stock trade filed");
    if (form.id === "policyForm") return setState(createPolicy(state, { companyId: data.get("companyId"), type: data.get("type"), title: data.get("title"), terms: data.get("terms") }), "Policy filed");
    if (form.id === "mergerForm") return setState(createMerger(state, { acquirerId: data.get("acquirerId"), targetId: data.get("targetId"), title: data.get("title") }), "Merger filed");
    if (form.matches("[data-antitrust-sale]")) return setState(completeAntitrustDivestiture(state, form.dataset.antitrustSale, data.get("propertyId"), data.get("buyerId"), Number(data.get("price"))), "Antitrust property sale recorded");
    if (form.id === "contractForm") return setState(createContract(state, { title: data.get("title"), type: data.get("type"), partyIds: data.getAll("partyIds"), sponsorId: data.get("sponsorId") || data.getAll("partyIds")[0], terms: data.get("terms"), status: data.get("status"), expiresRound: data.get("expiresRound") }), "Contract registered");
    if (form.id === "disputeForm") return setState(createDispute(state, { title: data.get("title"), linkedContractId: data.get("linkedContractId"), claimantId: data.get("claimantId"), respondentId: data.get("respondentId"), issue: data.get("issue"), evidence: data.get("evidence"), requestedRemedy: data.get("requestedRemedy") }), "Case opened");
    if (form.classList.contains("override-form")) return setState(overrideJudgement(state, form.dataset.judgement, data.get("outcome"), data.get("notes")), "Table decision recorded");
  } catch (error) { fail(error); }
});

app.addEventListener("change", event => {
  const select = event.target.closest("[data-contract-status]");
  if (select) {
    try { setState(updateContractStatus(state, select.dataset.contractStatus, select.value), "Contract status updated"); } catch (error) { fail(error); }
  }
  if (["dealProposer", "dealCounterparty"].includes(event.target.id)) {
    const prefix = event.target.id === "dealProposer" ? "proposer" : "counterparty";
    const propertySelect = document.querySelector(`select[name="${prefix}Property"]`);
    if (propertySelect) {
      const owned = state.properties.filter(property => property.ownerShares.some(share => share.entityId === event.target.value));
      propertySelect.innerHTML = `<option value="">None</option>${owned.map(property => `<option value="${property.id}">${escapeHtml(property.name)} — owns ${property.ownerShares.find(share => share.entityId === event.target.value).percent}%</option>`).join("")}`;
    }
  }
});

app.addEventListener("input", event => {
  if (event.target.id === "voiceTranscript") { voiceState.transcript = event.target.value; voiceState.plan = null; }
});

document.querySelector(".bottom-nav").addEventListener("click", event => {
  const button = event.target.closest("button[data-tab]");
  if (!button) return;
  activeTab = button.dataset.tab;
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

document.querySelector("#setupForm").addEventListener("submit", event => {
  event.preventDefault();
  try {
    const names = [...event.currentTarget.querySelectorAll('input[name="playerName"]')].map(input => input.value);
    state = createGame(names, { name: document.querySelector("#gameName").value });
    saveState();
    setupDialog.close();
    activeTab = "dashboard";
    render();
    showToast("Game created");
  } catch (error) { fail(error); }
});

document.querySelector("#menuBtn").addEventListener("click", () => { syncSettingsControls(); openDialog(gameDialog); });
gameDialog.addEventListener("click", event => {
  const button = event.target.closest("[data-dialog-go]");
  if (!button) return;
  activeTab = button.dataset.dialogGo;
  gameDialog.close();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
});
document.querySelector("#voiceBtn").addEventListener("click", () => { activeTab = "voice"; render(); window.scrollTo({ top: 0, behavior: "smooth" }); });
document.querySelector("#undoBtn").addEventListener("click", () => openConfirm("Undo the last action?", "Use this only for a clerical mistake. The reversal will be recorded in the ledger.", () => setState(undoLast(state), "Last action reversed")));
document.querySelector("#confirmActionBtn").addEventListener("click", event => {
  event.preventDefault();
  try { pendingConfirm?.(); confirmDialog.close(); } catch (error) { fail(error); }
  pendingConfirm = null;
});

document.querySelector("#exportBtn").addEventListener("click", () => { if (state) downloadFile(`${state.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.json`, exportGame(state)); });
document.querySelector("#importInput").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try { setState(importGame(await file.text()), "Game imported"); gameDialog.close(); } catch (error) { fail(error); }
  event.target.value = "";
});
document.querySelector("#newGameBtn").addEventListener("click", () => openConfirm("Start a new game?", "Export the current game first if you want to keep it. This browser’s active game will be replaced.", () => { state = null; localStorage.removeItem(STORAGE_KEY); gameDialog.close(); resetSetupInputs(); render(); openDialog(setupDialog); }));

document.querySelector("#judgeModeSetting").addEventListener("change", event => { state.settings.judgeMode = event.target.value; saveState(); render(); showToast("Judge authority updated"); });
document.querySelector("#freeParkingSetting").addEventListener("change", event => { state.settings.freeParkingJackpot = event.target.checked; saveState(); render(); showToast("Free Parking setting updated"); });
document.querySelector("#voiceReadbackSetting").addEventListener("change", event => { state.settings.voiceReadback = event.target.checked; saveState(); render(); showToast("Voice read-back setting updated"); });

window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault();
  pendingInstallPrompt = event;
  document.querySelector("#installBtn").classList.remove("hidden");
});
document.querySelector("#installBtn").addEventListener("click", async () => {
  if (!pendingInstallPrompt) return;
  await pendingInstallPrompt.prompt();
  pendingInstallPrompt = null;
  document.querySelector("#installBtn").classList.add("hidden");
});

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(console.warn);
resetSetupInputs();
render();
