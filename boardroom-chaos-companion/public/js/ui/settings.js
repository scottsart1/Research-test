/** Settings page: AI provider keys, transcription, routing, game options, data, and about. */
import { RULEBOOK_VERSION } from "../../rules.js";
import { getState, saveState, getSection } from "../store.js";
import { escapeHtml, segmented } from "../helpers.js";
import { AI_PROVIDERS, getAiSettings, saveAiSettings, forgetAiKeys, aiStatus, transcriptionStatus, activeTransport, cachedHealth, isNativeApp, testConnection } from "../ai.js";

export const APP_VERSION = "1.5.0";
export const SETTINGS_SECTIONS = [["ai", "AI provider"], ["voice", "Voice"], ["game", "Game"], ["data", "Data & about"]];

let testResult = null;

function aiSection() {
  const s = getAiSettings();
  const status = aiStatus();
  const health = cachedHealth();
  const meta = AI_PROVIDERS[s.provider] || null;
  const providerCards = Object.values(AI_PROVIDERS).map(provider => `<label class="provider-card ${s.provider === provider.id ? "selected" : ""}"><input type="radio" name="provider" value="${provider.id}" ${s.provider === provider.id ? "checked" : ""} /><strong>${escapeHtml(provider.label)}</strong><small>${escapeHtml(provider.defaultModel)}</small></label>`).join("");
  return `<form id="aiSettingsForm" class="panel featured settings-panel">
      <div><p class="eyebrow">Reasoning provider</p><h2>Which AI runs the clerk and the judge?</h2><p class="muted">Pick one provider and paste its API key. The key is stored only in this browser or app and is never written into exported game files.</p></div>
      <div class="provider-grid">${providerCards}</div>
      ${meta ? `
      <label>API key<span class="key-field"><input name="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(meta.keyHint)}" value="${escapeHtml(s.apiKey)}" /><button type="button" class="secondary small" data-action="toggle-key-visibility">Show</button></span><small class="fine-print">Create one at <a href="${meta.keysUrl}" target="_blank" rel="noopener">${escapeHtml(meta.keysUrl.replace("https://", ""))}</a>.</small></label>
      <div class="two-col">
        <label>Model<input name="model" list="modelSuggestions" placeholder="${escapeHtml(meta.defaultModel)}" value="${escapeHtml(s.model)}" /><datalist id="modelSuggestions">${meta.models.map(model => `<option value="${escapeHtml(model)}"></option>`).join("")}</datalist></label>
        ${meta.reasoningEffort ? `<label>Reasoning effort<select name="reasoningEffort"><option value="low" ${s.reasoningEffort === "low" ? "selected" : ""}>Low</option><option value="medium" ${s.reasoningEffort === "medium" ? "selected" : ""}>Medium</option><option value="high" ${s.reasoningEffort !== "low" && s.reasoningEffort !== "medium" ? "selected" : ""}>High</option></select></label>` : `<label>Base URL (advanced)<input name="baseUrl" placeholder="${escapeHtml(meta.defaultBaseUrl)}" value="${escapeHtml(s.baseUrl)}" /></label>`}
      </div>
      ${meta.reasoningEffort ? `<label>Base URL (advanced)<input name="baseUrl" placeholder="${escapeHtml(meta.defaultBaseUrl)}" value="${escapeHtml(s.baseUrl)}" /></label>` : ""}
      ` : `<div class="callout">Choose a provider above to enter its key. Without one, the app still runs the whole game; only AI interpretation, conditions, and rulings are unavailable.</div>`}
      <label class="toggle-row"><input type="checkbox" name="rememberKeys" ${s.rememberKeys ? "checked" : ""} /> Remember keys on this device (uncheck to keep them for this session only)</label>
      <div class="button-row"><button class="primary" type="submit">Save provider</button><button class="secondary" type="button" data-action="test-ai" ${status.configured ? "" : "disabled"}>Test connection</button><button class="ghost" type="button" data-action="forget-keys">Forget keys</button></div>
      <div class="ai-status-line ${status.configured ? "ok" : "off"}"><span class="status-dot"></span><div><strong>${escapeHtml(status.configured ? `${status.label} · ${status.model}` : "No AI provider configured")}</strong><small>${escapeHtml(status.configured ? (status.source === "device" ? `Using the key saved on this device, ${status.transport === "server" ? "routed through the local server" : "sent directly from this device"}.` : "Using the key configured on the local server's environment.") : (health.reachable ? "The local server has no key either. Add one here or set AI_API_KEY on the server." : "Add a key above."))}</small>${testResult ? `<small class="${testResult.ok ? "test-ok" : "test-fail"}">${escapeHtml(testResult.message)}</small>` : ""}</div></div>
    </form>`;
}

function voiceSection() {
  const s = getAiSettings();
  const transcription = transcriptionStatus();
  const state = getState();
  const browserSpeech = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const usesOpenaiProvider = s.provider === "openai" && s.apiKey;
  return `<form id="voiceSettingsForm" class="panel settings-panel">
      <div><p class="eyebrow">Speech to text</p><h2>How should spoken commands become text?</h2><p class="muted">Only OpenAI offers audio transcription among the supported providers. Chrome (including Android) can also recognize speech on the device with no key.</p></div>
      <label>Transcription mode<select name="transcription">
        <option value="auto" ${s.transcription === "auto" ? "selected" : ""}>Automatic — OpenAI when a key exists, otherwise browser recognition</option>
        <option value="openai" ${s.transcription === "openai" ? "selected" : ""}>OpenAI transcription (needs an OpenAI key)</option>
        <option value="browser" ${s.transcription === "browser" ? "selected" : ""}>Browser speech recognition (no key)${browserSpeech ? "" : " — not available in this browser"}</option>
        <option value="off" ${s.transcription === "off" ? "selected" : ""}>Off — type commands only</option>
      </select></label>
      <label>OpenAI key for transcription${usesOpenaiProvider ? " (optional — the GPT key above is used when this is blank)" : ""}<span class="key-field"><input name="openaiApiKey" type="password" autocomplete="off" spellcheck="false" placeholder="sk-…" value="${escapeHtml(s.openaiApiKey)}" /><button type="button" class="secondary small" data-action="toggle-key-visibility">Show</button></span></label>
      <div class="two-col">
        <label>Spoken language<input name="voiceLanguage" value="${escapeHtml(state?.settings?.voiceLanguage || "en-US")}" placeholder="en-US" /></label>
        <label class="toggle-row"><input type="checkbox" name="voiceReadback" ${state?.settings?.voiceReadback !== false ? "checked" : ""} /> Speak confirmations aloud</label>
      </div>
      <div class="button-row"><button class="primary" type="submit">Save voice settings</button></div>
      <div class="ai-status-line ${transcription.available ? "ok" : "off"}"><span class="status-dot"></span><div><strong>${escapeHtml(transcription.available ? (transcription.mode === "browser" ? "Browser speech recognition" : `OpenAI transcription${transcription.source === "server" ? " via the local server" : ""}`) : "Live transcription unavailable")}</strong><small>${escapeHtml(transcription.available ? "Tap Speak on the Voice page." : transcription.reason || "")}</small></div></div>
    </form>`;
}

function gameSection() {
  const state = getState();
  const s = getAiSettings();
  const health = cachedHealth();
  return `<form id="gameSettingsForm" class="panel settings-panel">
      <div><p class="eyebrow">Table rules</p><h2>Game options</h2></div>
      <label>Judge authority<select name="judgeMode"><option value="advisory" ${state?.settings?.judgeMode === "advisory" ? "selected" : ""}>Advisory — table decides</option><option value="binding" ${state?.settings?.judgeMode === "binding" ? "selected" : ""}>Binding — one appeal allowed</option></select></label>
      <label class="toggle-row"><input type="checkbox" name="freeParkingJackpot" ${state?.settings?.freeParkingJackpot ? "checked" : ""} /> Free Parking jackpot collects taxes, fees, and fines</label>
      <div><p class="eyebrow">Routing</p><h2>Where do AI requests go?</h2><p class="muted">${isNativeApp() ? "This is the installed app, so requests always go directly from the device to the provider." : health.reachable ? "The local Node server is reachable and can proxy requests (recommended on the laptop)." : "No local server was detected, so requests go directly from this browser to the provider."}</p></div>
      <label>Transport<select name="transport" ${isNativeApp() ? "disabled" : ""}>
        <option value="auto" ${s.transport === "auto" ? "selected" : ""}>Automatic — local server when available, otherwise direct</option>
        <option value="server" ${s.transport === "server" ? "selected" : ""}>Always through the local server</option>
        <option value="direct" ${s.transport === "direct" ? "selected" : ""}>Always direct from this device</option>
      </select></label>
      <div class="button-row"><button class="primary" type="submit">Save game options</button><button class="secondary" type="button" data-action="check-judge">Re-check local server</button></div>
      <p class="fine-print">Active transport right now: <strong>${activeTransport()}</strong>. Direct browser calls can be blocked by a provider's CORS policy; the installed Android app and the local-server route are not affected.</p>
    </form>`;
}

function dataSection() {
  const state = getState();
  return `<div class="panel settings-panel">
      <div><p class="eyebrow">Your data</p><h2>Export, import, restart</h2><p class="muted">The game lives in this browser or app. Export a JSON file to move it to another device or keep a backup. Exported files never contain API keys.</p></div>
      <div class="button-row"><button class="secondary" type="button" data-action="export-ledger" ${state ? "" : "disabled"}>Export game file</button><label class="file-button secondary">Import game file<input id="importInputSettings" type="file" accept="application/json" hidden /></label><button class="danger" type="button" data-action="new-game">Start a new game</button></div>
    </div>
    <div class="panel settings-panel">
      <div><p class="eyebrow">About</p><h2>Boardroom Chaos Companion ${APP_VERSION}</h2></div>
      <div class="mini-grid"><span>Rulebook<strong>v${escapeHtml(RULEBOOK_VERSION)}</strong></span><span>Runtime<strong>${isNativeApp() ? "Installed app" : window.isSecureContext ? "Browser (secure)" : "Browser (HTTP)"}</strong></span><span>Storage<strong>Local device</strong></span><span>Providers<strong>Claude · GPT · Kimi · DeepSeek</strong></span></div>
      <div class="button-row"><button class="secondary" type="button" data-go="rules">Open house rules</button></div>
      <p class="fine-print">Unofficial personal companion with original branding. Monopoly and its property names belong to their respective rights holders.</p>
    </div>`;
}

export function renderSettings() {
  const section = getSection("settings", "ai");
  const body = { ai: aiSection, voice: voiceSection, game: gameSection, data: dataSection }[section] || aiSection;
  return `<section class="page settings-page">
    <div class="section-head"><div><p class="eyebrow">Settings</p><h1>Providers, voice, and table options</h1><p>Bring your own API key for Claude, GPT, Kimi, or DeepSeek. Everything stays on this device.</p></div></div>
    ${segmented("settings", SETTINGS_SECTIONS, section)}
    ${body()}
  </section>`;
}

/** Controllers ------------------------------------------------------------------------------- */

export function saveAiForm(form) {
  const data = new FormData(form);
  saveAiSettings({
    provider: String(data.get("provider") || ""),
    apiKey: String(data.get("apiKey") || "").trim(),
    model: String(data.get("model") || "").trim(),
    baseUrl: String(data.get("baseUrl") || "").trim(),
    reasoningEffort: String(data.get("reasoningEffort") || "high"),
    rememberKeys: data.get("rememberKeys") === "on"
  });
  testResult = null;
}

export function saveVoiceForm(form) {
  const data = new FormData(form);
  saveAiSettings({ transcription: String(data.get("transcription") || "auto"), openaiApiKey: String(data.get("openaiApiKey") || "").trim() });
  const state = getState();
  if (state) {
    state.settings.voiceLanguage = String(data.get("voiceLanguage") || "en-US").trim() || "en-US";
    state.settings.voiceReadback = data.get("voiceReadback") === "on";
    saveState();
  }
}

export function saveGameForm(form) {
  const data = new FormData(form);
  saveAiSettings({ transport: String(data.get("transport") || "auto") });
  const state = getState();
  if (state) {
    state.settings.judgeMode = String(data.get("judgeMode") || "advisory");
    state.settings.freeParkingJackpot = data.get("freeParkingJackpot") === "on";
    saveState();
  }
}

export function forgetKeys() {
  forgetAiKeys();
  testResult = null;
}

export async function runConnectionTest() {
  testResult = { ok: false, message: "Testing…" };
  try {
    const result = await testConnection();
    testResult = { ok: true, message: `Connected to ${result.label || result.provider} (${result.model})${result.greeting ? `: “${result.greeting}”` : "."}` };
  } catch (error) {
    testResult = { ok: false, message: error.message };
  }
}

export function toggleKeyVisibility(button) {
  const input = button.closest(".key-field")?.querySelector("input");
  if (!input) return;
  input.type = input.type === "password" ? "text" : "password";
  button.textContent = input.type === "password" ? "Show" : "Hide";
}
