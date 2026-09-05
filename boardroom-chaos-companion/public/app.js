/**
 * Entry point: wires DOM events to the engine and the UI modules under public/js/.
 * Rendering is a pure function of store state plus a few page-local view states.
 */
import {
  createGame, transferCash, passGo, acquirePropertyFromBank, payRent, advanceTurn, createDeal, createPrimaryStockOffering, createSecondaryStockTrade,
  signDeal, rollDealApproval, setDealApprovalCondition, acceptDealCondition, castDealVote, executeDeal, createContract, updateContractStatus,
  createPolicy, rollPolicyApproval, setPolicyApprovalCondition, castPolicyVote, activatePolicy, createMerger, rollMergerApproval,
  setMergerApprovalCondition, acceptMergerCondition, signMerger, castMergerVote, executeMerger, takeBankLoan, repayBankLoan, payTaxBill,
  collectFreeParking, runAntitrustReview, payAntitrustFine, completeAntitrustDivestiture, createDispute, localRuleTest, recordJudgement,
  overrideJudgement, setMortgage, setBuildings, entityName, undoLast, exportGame, importGame, buildJudgePacket
} from "./engine.js";
import { getState, setState, replaceState, loadState, registerRenderer, getTab, setTab, setSection } from "./js/store.js";
import { escapeHtml, showToast, fail, openDialog, downloadFile, slug } from "./js/helpers.js";
import { getServerHealth, defineCondition, aiStatus } from "./js/ai.js";
import { renderDashboard } from "./js/ui/dashboard.js";
import { renderActions } from "./js/ui/actions.js";
import { renderMarket } from "./js/ui/market.js";
import { renderDeals, ownedPropertyOptions } from "./js/ui/deals.js";
import { renderLegal, askAiJudge } from "./js/ui/legal.js";
import { renderAssets } from "./js/ui/assets.js";
import { renderLedger } from "./js/ui/ledger.js";
import { renderRules } from "./js/ui/rules.js";
import { renderVoice, voiceState, toggleVoiceCapture, interpretVoiceTranscript, saveTranscriptAsVoiceNote, applySelectedVoicePlan, transcribeVoiceFile, clearVoice } from "./js/ui/voice.js";
import { renderSettings, saveAiForm, saveVoiceForm, saveGameForm, forgetKeys, runConnectionTest, toggleKeyVisibility } from "./js/ui/settings.js";

const app = document.querySelector("#app");
const setupDialog = document.querySelector("#setupDialog");
const gameDialog = document.querySelector("#gameDialog");
const confirmDialog = document.querySelector("#confirmDialog");
let pendingInstallPrompt = null;
let pendingConfirm = null;

const renderers = {
  dashboard: renderDashboard, voice: renderVoice, actions: renderActions, market: renderMarket, deals: renderDeals,
  legal: renderLegal, contracts: renderLegal, judge: renderLegal, assets: renderAssets, ledger: renderLedger, rules: renderRules, settings: renderSettings
};

function renderTopbar() {
  const state = getState();
  const status = aiStatus();
  document.querySelectorAll(".bottom-nav button").forEach(button => button.classList.toggle("active", button.dataset.tab === getTab()));
  document.querySelector("#undoBtn").disabled = !state?.undoStack?.length;
  document.querySelector("#gameSubtitle").textContent = state ? `${state.name} · Round ${state.round}` : "Local-first game companion";
  const aiButton = document.querySelector("#settingsBtn");
  aiButton.classList.toggle("ai-ready", status.configured);
  aiButton.title = status.configured ? `AI: ${status.label} · ${status.model}` : "Settings (no AI provider configured)";
}

function render() {
  renderTopbar();
  const state = getState();
  if (!state && getTab() !== "settings") {
    app.innerHTML = `<section class="empty-state"><div class="hero-icon">⚖</div><h1>Deals without the bookkeeping headache</h1><p>Track money, property, contracts, mergers, randomized approvals, and rule judgements from one shared screen.</p><div class="button-row"><button id="openSetup" class="primary large">Create a game</button><button class="secondary large" data-go="settings">Add an AI key</button></div></section>`;
    queueMicrotask(() => openDialog(setupDialog));
    return;
  }
  app.innerHTML = (renderers[getTab()] || renderDashboard)();
  if (["legal", "voice", "settings"].includes(getTab())) getServerHealth().then(() => { if (["legal", "voice", "settings"].includes(getTab())) refreshPageOnly(); });
}

/** Re-render the page body without re-running the health check (avoids a loop). */
function refreshPageOnly() {
  renderTopbar();
  const state = getState();
  if (!state && getTab() !== "settings") return;
  const scrollY = window.scrollY;
  app.innerHTML = (renderers[getTab()] || renderDashboard)();
  window.scrollTo({ top: scrollY });
}

registerRenderer(render);

function go(tab, section) {
  setTab(tab);
  if (section) setSection(tab, section);
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function openConfirm(title, text, action) {
  document.querySelector("#confirmTitle").textContent = title;
  document.querySelector("#confirmText").textContent = text;
  pendingConfirm = action;
  openDialog(confirmDialog);
}

function approvalRecord(kind, id) {
  const state = getState();
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
  const state = getState();
  const record = approvalRecord(kind, id);
  if (!record) throw new Error("Approval record not found.");
  let conditionData;
  let source = "ai";
  try {
    const data = await defineCondition(kind, record, {
      round: state.round,
      legalFee: state.settings.legalFee,
      mergerFee: state.settings.mergerFee,
      settlementLagRounds: state.settings.dealSettlementLagRounds,
      players: state.players.map(player => ({ id: player.id, name: player.name, cash: player.cash, mergedInto: player.mergedInto })),
      stocks: state.market.stocks.map(stock => ({ companyId: stock.companyId, ticker: stock.ticker, price: stock.price, outstandingShares: stock.outstandingShares, holdings: stock.holdings }))
    });
    conditionData = { condition: data.condition, mechanic: data.mechanic, value: data.value };
    source = data.mechanic === "none" ? `${data.provider || "ai"}` : `${data.provider || "ai"}_structured`;
  } catch (error) {
    console.warn(error);
    conditionData = fallbackConditionData();
    source = "local_fallback";
    showToast("AI condition unavailable; a transparent local condition was used.", "error");
  }
  const setters = { deal: setDealApprovalCondition, policy: setPolicyApprovalCondition, merger: setMergerApprovalCondition };
  setState(setters[kind](getState(), id, conditionData.condition, source, conditionData), `${kind === "deal" ? "Approval" : kind === "policy" ? "Policy" : "Merger"} condition defined`);
}

async function runFixedApproval(kind, id) {
  const rollers = { deal: rollDealApproval, policy: rollPolicyApproval, merger: rollMergerApproval };
  if (!rollers[kind]) throw new Error("Unknown approval type.");
  setState(rollers[kind](getState(), id), "10/40/50 approval result recorded");
  const record = approvalRecord(kind, id);
  if (record?.approval?.outcome === "approved_with_conditions") await defineApprovalCondition(kind, id);
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

function startNewGame() {
  replaceState(null);
  gameDialog.close();
  resetSetupInputs();
  setTab("dashboard");
  render();
  openDialog(setupDialog);
}

async function importFromFile(file) {
  if (!file) return;
  setState(importGame(await file.text()), "Game imported");
  gameDialog.close();
}

/* ------------------------------------------------------------------ click handling ------------------------------------------------------------------ */
app.addEventListener("click", async event => {
  const button = event.target.closest("button, [data-go], [data-go-action], [data-quick-player], [data-review-contract], [data-segment]");
  if (!button) return;
  const state = getState();
  try {
    if (button.id === "openSetup") return openDialog(setupDialog);
    if (button.dataset.segment) { setSection(button.dataset.segment, button.dataset.section); return refreshPageOnly(); }
    if (button.dataset.voiceExample) { voiceState.transcript = button.dataset.voiceExample; voiceState.plan = null; return go("voice"); }
    if (button.dataset.goAction) {
      go("actions");
      return queueMicrotask(() => {
        const target = document.querySelector(`#${button.dataset.goAction}`);
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
        target?.querySelector("select, input, textarea")?.focus();
      });
    }
    if (button.dataset.go) return go(button.dataset.go, button.dataset.goSection);
    if (button.dataset.quickPlayer) { go("actions"); queueMicrotask(() => { const to = document.querySelector('#cashTransferForm select[name="toId"]'); if (to) to.value = button.dataset.quickPlayer; }); return; }
    if (button.dataset.reviewContract) {
      const contract = state.contracts.find(item => item.id === button.dataset.reviewContract);
      go("legal");
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
    if (!action) return;
    // Settings
    if (action === "toggle-key-visibility") return toggleKeyVisibility(button);
    if (action === "forget-keys") { forgetKeys(); showToast("API keys removed from this device"); return render(); }
    if (action === "test-ai") { button.disabled = true; button.textContent = "Testing…"; await runConnectionTest(); return render(); }
    if (action === "check-judge") { await getServerHealth(true); return render(); }
    if (action === "new-game") return openConfirm("Start a new game?", "Export the current game first if you want to keep it. This device’s active game will be replaced.", startNewGame);
    if (action === "export-ledger") { if (!state) throw new Error("There is no game to export."); return downloadFile(`${slug(state.name)}.json`, exportGame(state)); }
    // Voice
    if (action === "toggle-voice") return await toggleVoiceCapture();
    if (action === "interpret-voice") return await interpretVoiceTranscript();
    if (action === "save-voice-note") return saveTranscriptAsVoiceNote();
    if (action === "clear-voice") { clearVoice(); return render(); }
    if (action === "discard-voice-plan") { voiceState.plan = null; voiceState.status = "Interpretation discarded. Edit or speak again."; return render(); }
    if (action === "apply-voice-plan") return openConfirm("Log the selected voice actions?", "The game engine will validate every action. The entire confirmed voice batch can be undone as one clerical correction.", () => applySelectedVoicePlan());
    // Play
    if (action === "advance-turn") return setState(advanceTurn(state), "Turn advanced");
    if (action === "pass-go") {
      const active = state.players[state.activePlayerIndex];
      return openConfirm("Collect $200 for passing GO?", `${active.name} will receive $200 from the bank.`, () => setState(passGo(getState(), active.id), `${active.name} collected $200`));
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
    if (action === "execute-merger") return openConfirm("Complete this merger?", "The target company will lose its separate turn, its assets will combine with the acquirer, and its shares will convert at the locked ratio.", () => setState(executeMerger(getState(), button.dataset.merger), "Merger completed"));
    if (action === "pay-tax") return setState(payTaxBill(state, button.dataset.tax), "Tax bill paid into Free Parking");
    if (action === "repay-bank-loan") return openConfirm("Repay this bank loan in full?", "The borrower’s cash will decrease and the bank’s liquidity will increase immediately.", () => setState(repayBankLoan(getState(), button.dataset.loan), "Bank loan repaid"));
    if (action === "run-antitrust") return openConfirm("Run this company’s one antitrust review?", "The result is final and selected electronically from the five written penalties.", () => setState(runAntitrustReview(getState(), button.dataset.player), "Antitrust review completed"));
    if (action === "pay-antitrust-fine") return setState(payAntitrustFine(state, button.dataset.review), "Antitrust fine paid");
    if (action === "collect-free-parking") return openConfirm("Collect the Free Parking jackpot?", `${entityName(state, button.dataset.player)} must have landed directly on Free Parking.`, () => setState(collectFreeParking(getState(), button.dataset.player), "Free Parking jackpot collected"));
    if (action === "execute-deal") return openConfirm("Settle this deal?", "The locked assets and cash will move now because the two-round settlement date has arrived.", () => setState(executeDeal(getState(), button.dataset.deal), "Deal settled"));
    if (action === "local-judge") return setState(recordJudgement(state, button.dataset.dispute, { ...localRuleTest(state, button.dataset.dispute), evidenceSnapshot: buildJudgePacket(state, button.dataset.dispute) }), "Local rule test recorded");
    if (action === "ai-judge") { button.disabled = true; button.textContent = "Judging…"; await askAiJudge(button.dataset.dispute); return; }
    if (action === "toggle-mortgage") { const property = state.properties.find(p => p.id === button.dataset.property); return openConfirm(property.mortgaged ? "Unmortgage property?" : "Mortgage property?", property.mortgaged ? "Owners will pay the conventional mortgage plus 10%, divided by ownership share." : "Mortgage proceeds will be divided among owners by ownership share.", () => setState(setMortgage(getState(), property.id, !property.mortgaged), "Mortgage status updated")); }
    if (action === "building-up" || action === "building-down") { const property = state.properties.find(p => p.id === button.dataset.property); const target = property.buildings + (action === "building-up" ? 1 : -1); return setState(setBuildings(state, property.id, target), "Buildings updated"); }
  } catch (error) { fail(error); render(); }
});

/* ------------------------------------------------------------------ form handling ------------------------------------------------------------------ */
app.addEventListener("submit", event => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const state = getState();
  try {
    if (form.id === "aiSettingsForm") { saveAiForm(form); showToast("AI provider saved"); return render(); }
    if (form.id === "voiceSettingsForm") { saveVoiceForm(form); showToast("Voice settings saved"); return render(); }
    if (form.id === "gameSettingsForm") { saveGameForm(form); showToast("Game options saved"); return render(); }
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

app.addEventListener("change", async event => {
  const target = event.target;
  try {
    if (target.id === "voiceAudioFile") { const file = target.files?.[0]; target.value = ""; return await transcribeVoiceFile(file); }
    if (target.id === "importInputSettings") { const file = target.files?.[0]; target.value = ""; return await importFromFile(file); }
    if (target.name === "provider" && target.closest("#aiSettingsForm")) { saveAiForm(target.closest("#aiSettingsForm")); return render(); }
    const select = target.closest("[data-contract-status]");
    if (select) return setState(updateContractStatus(getState(), select.dataset.contractStatus, select.value), "Contract status updated");
    if (["dealProposer", "dealCounterparty"].includes(target.id)) {
      const prefix = target.id === "dealProposer" ? "proposer" : "counterparty";
      const propertySelect = document.querySelector(`select[name="${prefix}Property"]`);
      if (propertySelect) propertySelect.innerHTML = ownedPropertyOptions(target.value);
    }
  } catch (error) { fail(error); }
});

app.addEventListener("input", event => {
  if (event.target.id === "voiceTranscript") { voiceState.transcript = event.target.value; voiceState.plan = null; }
});

/* ------------------------------------------------------------------ chrome ------------------------------------------------------------------ */
document.querySelector(".bottom-nav").addEventListener("click", event => {
  const button = event.target.closest("button[data-tab]");
  if (button) go(button.dataset.tab);
});

document.querySelector("#setupForm").addEventListener("submit", event => {
  event.preventDefault();
  try {
    const names = [...event.currentTarget.querySelectorAll('input[name="playerName"]')].map(input => input.value);
    replaceState(createGame(names, { name: document.querySelector("#gameName").value }));
    setupDialog.close();
    go("dashboard");
    showToast("Game created");
  } catch (error) { fail(error); }
});

document.querySelector("#menuBtn").addEventListener("click", () => openDialog(gameDialog));
gameDialog.addEventListener("click", event => {
  const button = event.target.closest("[data-dialog-go]");
  if (!button) return;
  gameDialog.close();
  go(button.dataset.dialogGo);
});
document.querySelector("#voiceBtn").addEventListener("click", () => go("voice"));
document.querySelector("#settingsBtn").addEventListener("click", () => go("settings"));
document.querySelector("#undoBtn").addEventListener("click", () => openConfirm("Undo the last action?", "Use this only for a clerical mistake. The reversal will be recorded in the ledger.", () => setState(undoLast(getState()), "Last action reversed")));
document.querySelector("#confirmActionBtn").addEventListener("click", event => {
  event.preventDefault();
  try { pendingConfirm?.(); confirmDialog.close(); } catch (error) { fail(error); }
  pendingConfirm = null;
});

document.querySelector("#exportBtn").addEventListener("click", () => { const state = getState(); if (state) downloadFile(`${slug(state.name)}.json`, exportGame(state)); });
document.querySelector("#importInput").addEventListener("change", async event => {
  const file = event.target.files?.[0];
  event.target.value = "";
  try { await importFromFile(file); } catch (error) { fail(error); }
});
document.querySelector("#newGameBtn").addEventListener("click", () => openConfirm("Start a new game?", "Export the current game first if you want to keep it. This device’s active game will be replaced.", startNewGame));

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

if ("serviceWorker" in navigator && !globalThis.Capacitor?.isNativePlatform?.()) navigator.serviceWorker.register("./sw.js").catch(console.warn);
loadState();
resetSetupInputs();
render();
