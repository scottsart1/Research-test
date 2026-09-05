/** The voice clerk page: recording or typing, AI interpretation, review, and confirmed execution. */
import {
  transferCash, passGo, acquirePropertyFromBank, payRent, advanceTurn, recordVoiceNote, createDeal, signDeal, rollDealApproval,
  acceptDealCondition, executeDeal, createContract, updateContractStatus, createDispute, setMortgage, setBuildings
} from "../../engine.js";
import { getState, setState, getTab, rerender } from "../store.js";
import { money, escapeHtml, titleCase, clone, showToast, fail } from "../helpers.js";
import { eventRow, aiStatusPill } from "./shared.js";
import { AudioRecorder, BrowserSpeechRecognizer, AudioRecorderConstructor, speakText } from "../recorder.js";
import { aiStatus, transcriptionStatus, transcribeAudio, interpretVoice } from "../ai.js";
import { VOICE_ACTION_TYPES } from "../../ai-prompts.js";

export const voiceState = {
  listening: false,
  status: "Tap Speak, upload a recording, or type a command.",
  transcript: "",
  interim: "",
  plan: null,
  interpreting: false,
  model: null,
  error: null
};

const handlers = {
  onStatus: message => { voiceState.status = message; renderVoiceIfActive(); },
  onStart: () => { voiceState.listening = true; voiceState.status = "Listening… tap Stop when finished."; voiceState.error = null; renderVoiceIfActive(); },
  onResult: ({ finalTranscript, interimTranscript, model }) => { voiceState.transcript = finalTranscript; voiceState.interim = interimTranscript; voiceState.model = model || voiceState.model; renderVoiceIfActive(true); },
  onError: error => { voiceState.error = error.message; voiceState.status = "Voice capture failed."; fail(error); renderVoiceIfActive(); },
  onEnd: ({ transcript, model }) => {
    voiceState.listening = false;
    voiceState.interim = "";
    voiceState.transcript = transcript || voiceState.transcript;
    voiceState.model = model || voiceState.model;
    voiceState.status = voiceState.transcript ? "Transcript ready. Interpret it when you are happy with the wording." : "No usable speech was captured.";
    renderVoiceIfActive();
  }
};

const audioRecorder = new AudioRecorder(handlers, transcribeAudio);
const speechRecognizer = new BrowserSpeechRecognizer(handlers);
let activeCapture = null;

export function renderVoiceIfActive(light = false) {
  if (getTab() !== "voice") return;
  if (!light) return rerender();
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
  const state = getState();
  const active = state.players[state.activePlayerIndex];
  return {
    game: { id: state.id, name: state.name, round: state.round, activePlayerId: active?.id || null, activePlayerName: active?.name || null },
    players: state.players.map(({ id, name, cash, bankrupt, mergedInto }) => ({ id, name, cash, bankrupt, mergedInto })),
    properties: state.properties.map(({ id, name, type, group, price, ownerShares, mortgaged, buildings }) => ({ id, name, type, group, price, ownerShares, mortgaged, buildings })),
    deals: state.deals.slice(0, 20).map(({ id, title, proposerId, counterpartyId, status, signatures, approval }) => ({ id, title, proposerId, counterpartyId, status, signatures, approval })),
    contracts: state.contracts.slice(0, 30).map(({ id, title, type, partyIds, status, terms, expiresRound }) => ({ id, title, type, partyIds, status, terms, expiresRound })),
    disputes: state.disputes.slice(0, 20).map(({ id, title, claimantId, respondentId, linkedContractId, status, issue }) => ({ id, title, claimantId, respondentId, linkedContractId, status, issue })),
    supportedActions: [...VOICE_ACTION_TYPES]
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

export function renderVoice() {
  const state = getState();
  const ai = aiStatus();
  const transcription = transcriptionStatus();
  const captureSupported = transcription.available && (transcription.mode === "browser" ? speechRecognizer.supported : Boolean(AudioRecorderConstructor));
  const captureLabel = transcription.mode === "browser" ? "Browser speech recognition (no key needed)" : transcription.mode === "openai" ? `OpenAI transcription${transcription.source === "server" ? " via the local server" : ""}` : "Live capture unavailable";
  const voiceEvents = state.ledger.filter(event => event.metadata?.voice || event.type === "voice_note").slice(0, 10);
  const secureWarning = !window.isSecureContext ? `<div class="voice-warning"><strong>Insecure connection:</strong> browsers block the microphone on a plain HTTP local-IP address. Use the installed app, localhost, HTTPS, or the “Record or upload audio” control below.</div>` : "";
  return `<section class="page voice-page">
    <div class="section-head"><div><p class="eyebrow">Hands-free game clerk</p><h1>Speak it. Review it. Log it.</h1><p>Speech becomes text, the AI proposes game actions, the deterministic engine validates, and you confirm before anything changes.</p></div>${aiStatusPill()}</div>
    ${secureWarning}
    <div class="pipeline-strip">
      <span class="${transcription.available ? "ok" : "off"}"><small>1 · Transcribe</small><strong>${escapeHtml(captureLabel)}</strong></span>
      <span class="${ai.configured ? "ok" : "off"}"><small>2 · Interpret</small><strong>${escapeHtml(ai.configured ? `${ai.label} · ${ai.model}` : "No AI provider (limited local fallback)")}</strong></span>
      <span class="ok"><small>3 · Confirm</small><strong>Engine validates, you approve</strong></span>
    </div>
    ${!transcription.available ? `<div class="voice-warning">${escapeHtml(transcription.reason || "Transcription is not configured.")} <button class="small secondary" data-go="settings">Open Settings</button></div>` : ""}
    <section class="voice-console">
      <button id="voiceMicBtn" class="voice-mic ${voiceState.listening ? "listening" : ""}" data-action="toggle-voice" aria-pressed="${voiceState.listening}" ${captureSupported ? "" : "disabled"}><b>🎙</b><span>${voiceState.listening ? "Stop" : "Speak"}</span></button>
      <div class="voice-console-copy"><span class="chip ${voiceState.listening ? "warning" : "success"}">${voiceState.listening ? "Recording" : captureSupported ? "Ready" : "Upload or type"}</span><h2 id="voiceStatus">${escapeHtml(voiceState.status)}</h2><p>${transcription.mode === "browser" ? "Speech is recognized on this device by the browser; nothing is uploaded until you interpret the transcript." : "Audio goes to OpenAI for transcription. Only the transcript and compact game context go to your chosen reasoning provider."}</p><div id="voiceInterim" class="voice-interim">${escapeHtml(voiceState.interim)}</div></div>
    </section>
    <section class="panel">
      <label>Transcript<textarea id="voiceTranscript" rows="4" placeholder="Example: Sam pays Alex 200 dollars for the railroad deal.">${escapeHtml(voiceState.transcript)}</textarea></label>
      <div class="button-row"><button class="primary" data-action="interpret-voice" ${voiceState.interpreting ? "disabled" : ""}>${voiceState.interpreting ? "Interpreting…" : "Interpret command"}</button><label class="file-button secondary">Record or upload audio<input id="voiceAudioFile" type="file" accept="audio/*" capture hidden /></label><button class="secondary" data-action="save-voice-note">Save as nonbinding note</button><button class="ghost" data-action="clear-voice">Clear</button></div>
      <p class="fine-print">Financial and ownership actions always require visual confirmation. A voice note records testimony or table chatter but does not create a binding contract.</p>
    </section>
    ${renderVoicePlan(voiceState.plan)}
    <section class="panel voice-examples"><div><p class="eyebrow">Try saying</p><h2>Natural commands</h2></div><div class="example-grid"><button data-voice-example="Sam pays Alex 200 dollars for a consulting fee.">“Sam pays Alex $200…”</button><button data-voice-example="Jordan landed on Boardwalk. Pay the calculated rent.">“Jordan landed on Boardwalk…”</button><button data-voice-example="Create a deal where Priya gives Alex 300 dollars for Reading Railroad.">“Create a deal…”</button><button data-voice-example="Log an active contract between Alex and Sam: no orange property rent for three rounds.">“Log a contract…”</button><button data-voice-example="Open a case asking whether the rent immunity was still active.">“Open a case…”</button><button data-voice-example="End the current turn.">“End the current turn.”</button></div></section>
    <div class="section-head"><div><p class="eyebrow">Voice audit</p><h2>Recently spoken or typed</h2></div></div>
    <div class="timeline">${voiceEvents.map(eventRow).join("") || '<div class="empty-panel">Confirmed voice actions and notes will appear here.</div>'}</div>
  </section>`;
}

export async function transcribeVoiceFile(file) {
  if (!file) return;
  const state = getState();
  voiceState.plan = null;
  voiceState.error = null;
  voiceState.interpreting = true;
  voiceState.status = "Transcribing the selected recording…";
  renderVoiceIfActive();
  try {
    const result = await transcribeAudio(file, { language: state.settings.voiceLanguage || "en" });
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

export async function toggleVoiceCapture() {
  if (voiceState.listening) return activeCapture?.stop();
  const state = getState();
  const transcription = transcriptionStatus();
  if (!transcription.available) throw new Error(transcription.reason || "Transcription is not configured.");
  activeCapture = transcription.mode === "browser" ? speechRecognizer : audioRecorder;
  voiceState.plan = null;
  voiceState.error = null;
  voiceState.transcript = "";
  voiceState.interim = "";
  voiceState.status = "Preparing microphone…";
  renderVoiceIfActive();
  await activeCapture.start({ language: state.settings.voiceLanguage || "en-US" });
}

export function abortVoiceCapture() {
  activeCapture?.abort();
}

function resolvePlayerLocally(fragment) {
  const lower = String(fragment || "").trim().toLowerCase();
  return getState().players.find(player => player.name.toLowerCase() === lower) || null;
}

/** Deterministic fallback for the two commonest commands when no AI provider is reachable. */
function localVoiceFallback(transcript) {
  const text = String(transcript || "").trim();
  if (/^(please )?(end|finish|advance)( the)?( current)? turn\.?$/i.test(text)) return { status: "ready", summary: "Advance to the next turn", confidence: .9, actions: [{ type: "advance_turn", description: "End the current turn", confidence: .9, fields: {}, ambiguities: [], sourceQuote: text }], unresolved: [], suggestedClarification: "" };
  const payment = text.match(/^(.+?)\s+(?:pays?|paid|gives?)\s+(.+?)\s+\$?([0-9]+(?:\.[0-9]{1,2})?)(?:\s+dollars?)?(?:\s+(?:for|as)\s+(.+))?\.?$/i);
  if (payment) {
    const from = resolvePlayerLocally(payment[1]);
    const to = resolvePlayerLocally(payment[2]);
    if (from && to) return { status: "ready", summary: `${from.name} pays ${to.name} ${money(payment[3])}`, confidence: .75, actions: [{ type: "transfer_cash", description: `${from.name} pays ${to.name} ${money(payment[3])}`, confidence: .75, fields: { fromId: from.id, toId: to.id, amount: Number(payment[3]), memo: payment[4] || "Voice payment" }, ambiguities: [], sourceQuote: text }], unresolved: [], suggestedClarification: "" };
  }
  return { status: "needs_review", summary: "No AI provider was available; transcript preserved as a note candidate", confidence: .2, actions: [{ type: "voice_note", description: "Save the transcript as a nonbinding note", confidence: .6, fields: { category: "unclassified", summary: text, actorIds: [] }, ambiguities: [], sourceQuote: text }], unresolved: ["The local fallback only understands simple payments and ending a turn."], suggestedClarification: "Edit the transcript or add an AI provider key in Settings." };
}

export async function interpretVoiceTranscript() {
  const input = document.querySelector("#voiceTranscript");
  const transcript = String(input?.value || voiceState.transcript || "").trim();
  if (!transcript) throw new Error("Speak or type a command first.");
  voiceState.transcript = transcript;
  voiceState.interpreting = true;
  voiceState.plan = null;
  voiceState.status = "The AI is categorizing the transcript…";
  renderVoiceIfActive();
  try {
    const data = await interpretVoice(transcript, voiceContext());
    voiceState.plan = data.plan;
    voiceState.model = data.model;
    voiceState.status = `Interpreted with ${data.model}. Review before logging.`;
  } catch (error) {
    console.warn(error);
    voiceState.plan = localVoiceFallback(transcript);
    voiceState.model = "local-fallback";
    voiceState.status = "The AI was unavailable; a limited local interpretation is shown.";
    showToast(error.message, "error");
  } finally {
    voiceState.interpreting = false;
    renderVoiceIfActive();
  }
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

export function applySelectedVoicePlan() {
  const state = getState();
  const selected = [...document.querySelectorAll(".voice-action-select:checked")].map(input => voiceState.plan.actions[Number(input.dataset.index)]).filter(Boolean);
  if (!selected.length) throw new Error("Select at least one interpreted action.");
  const originalSnapshot = clone(state);
  originalSnapshot.undoStack = [];
  const oldIds = new Set(state.ledger.map(event => event.id));
  let next = state;
  for (const action of selected) next = applyVoiceAction(next, action);
  const voiceMeta = { transcript: voiceState.transcript, model: voiceState.model || "local", actionTypes: selected.map(action => action.type), interpretedConfidence: voiceState.plan.confidence, voice: true };
  for (const event of next.ledger) if (!oldIds.has(event.id)) event.metadata = { ...(event.metadata || {}), voice: voiceMeta };
  next.undoStack = [...(state.undoStack || []), originalSnapshot].slice(-30);
  const count = selected.length;
  Object.assign(voiceState, { transcript: "", interim: "", plan: null, listening: false, interpreting: false, status: `${count} voice action${count === 1 ? "" : "s"} recorded.`, error: null });
  setState(next, `${count} voice action${count === 1 ? "" : "s"} recorded`);
  if (getState().settings.voiceReadback !== false) speakText(`${count} action${count === 1 ? "" : "s"} recorded.`, { language: getState().settings.voiceLanguage || "en-US" });
}

export function saveTranscriptAsVoiceNote() {
  const input = document.querySelector("#voiceTranscript");
  const transcript = String(input?.value || voiceState.transcript || "").trim();
  if (!transcript) throw new Error("There is no transcript to save.");
  voiceState.transcript = "";
  voiceState.plan = null;
  setState(recordVoiceNote(getState(), transcript, "table_note", transcript, { source: "voice_or_typed", model: "none", confidence: 1 }), "Voice note saved");
  if (getState().settings.voiceReadback !== false) speakText("Note recorded.", { language: getState().settings.voiceLanguage || "en-US" });
}

export function clearVoice() {
  abortVoiceCapture();
  Object.assign(voiceState, { transcript: "", interim: "", plan: null, listening: false, interpreting: false, status: "Tap Speak, upload a recording, or type a command.", error: null });
}
