/**
 * The app's AI client. Players enter a provider key in Settings; it is stored on this device only
 * (never inside exported game files). Requests go either straight to the provider from the browser
 * ("direct", used by the Android/iOS app) or through the local Node server ("server", which can also
 * fall back to keys set in the server's environment).
 */
import { AI_PROVIDERS, normalizeAiConfig, isAiConfigured, buildChatRequest, parseChatResponse, extractJson, transcriptionEndpoint, buildTranscriptionForm } from "../ai-providers.js";
import {
  normalizeVoicePlan, normalizeCondition, normalizeJudgement,
  VOICE_SYSTEM_PROMPT, voiceUserPrompt, APPROVAL_SYSTEM_PROMPT, approvalUserPrompt, JUDGE_SYSTEM_PROMPT, judgeUserPrompt,
  CONNECTION_TEST_SYSTEM_PROMPT, CONNECTION_TEST_USER_PROMPT, clipped
} from "../ai-prompts.js";

export const AI_SETTINGS_KEY = "boardroom-chaos-ai-settings-v1";
export { AI_PROVIDERS };

const DEFAULT_SETTINGS = Object.freeze({
  provider: "",
  apiKey: "",
  model: "",
  baseUrl: "",
  reasoningEffort: "high",
  openaiApiKey: "",
  transcription: "auto",   // auto | openai | browser | off
  transport: "auto",       // auto | server | direct
  rememberKeys: true
});

let settings = { ...DEFAULT_SETTINGS };
let health = { checked: false, reachable: false, at: 0, data: null };
let healthPromise = null;

try {
  const raw = JSON.parse(localStorage.getItem(AI_SETTINGS_KEY) || "null");
  if (raw && typeof raw === "object") settings = { ...DEFAULT_SETTINGS, ...raw };
} catch { /* ignore */ }

export function getAiSettings() { return { ...settings }; }

export function saveAiSettings(patch) {
  settings = { ...settings, ...patch };
  if (!AI_PROVIDERS[settings.provider]) settings.provider = "";
  try {
    const persisted = settings.rememberKeys ? settings : { ...settings, apiKey: "", openaiApiKey: "" };
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(persisted));
  } catch { /* ignore */ }
  return getAiSettings();
}

export function forgetAiKeys() {
  return saveAiSettings({ apiKey: "", openaiApiKey: "" });
}

export function isNativeApp() {
  return Boolean(globalThis.Capacitor?.isNativePlatform?.());
}

/** The device-entered provider config, or null when no key has been typed in. */
export function deviceAiConfig() {
  const config = normalizeAiConfig(settings);
  return isAiConfigured(config) ? config : null;
}

/** Ask the local server what it can do. Cached for 30 seconds; never attempted inside the native app. */
export async function getServerHealth(force = false) {
  if (isNativeApp()) return { checked: true, reachable: false, at: Date.now(), data: null };
  if (!force && health.checked && Date.now() - health.at < 30_000) return health;
  if (healthPromise && !force) return healthPromise;
  healthPromise = (async () => {
    try {
      const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Server unavailable");
      const data = await response.json();
      health = { checked: true, reachable: Boolean(data?.ok), at: Date.now(), data };
    } catch {
      health = { checked: true, reachable: false, at: Date.now(), data: null };
    } finally {
      healthPromise = null;
    }
    return health;
  })();
  return healthPromise;
}

export function cachedHealth() { return health; }

/** Which transport a request will use right now, given settings and the last health check. */
export function activeTransport() {
  if (settings.transport === "direct" || isNativeApp()) return "direct";
  if (settings.transport === "server") return "server";
  return health.reachable ? "server" : "direct";
}

/** Human-readable summary of where reasoning requests will go. */
export function aiStatus() {
  const device = deviceAiConfig();
  const transport = activeTransport();
  const serverAi = health.data?.ai;
  if (device) return { configured: true, source: "device", transport, provider: device.provider, label: AI_PROVIDERS[device.provider].label, model: device.model };
  if (transport === "server" && serverAi?.configured) return { configured: true, source: "server", transport, provider: serverAi.provider, label: serverAi.label || serverAi.provider, model: serverAi.model };
  return { configured: false, source: "none", transport, provider: null, label: "No AI provider", model: null };
}

/** Where audio transcription will go: openai (with a key), browser (on-device speech recognition), or off. */
export function transcriptionStatus() {
  const mode = settings.transcription || "auto";
  const browserAvailable = Boolean(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition);
  const openaiKey = openaiKeyForTranscription();
  const serverHasKey = activeTransport() === "server" && Boolean(health.data?.transcription?.configured);
  if (mode === "off") return { mode: "off", available: false, reason: "Transcription is switched off in Settings." };
  if (mode === "browser") return browserAvailable ? { mode: "browser", available: true } : { mode: "off", available: false, reason: "This browser has no built-in speech recognition. Chrome on Android and desktop Chrome support it." };
  if (mode === "openai" || mode === "auto") {
    if (openaiKey || serverHasKey) return { mode: "openai", available: true, source: openaiKey ? "device" : "server" };
    if (mode === "auto" && browserAvailable) return { mode: "browser", available: true };
    return { mode: "off", available: false, reason: "Add an OpenAI key in Settings for transcription, or choose browser speech recognition." };
  }
  return { mode: "off", available: false, reason: "Transcription is not configured." };
}

function openaiKeyForTranscription() {
  if (settings.openaiApiKey) return settings.openaiApiKey;
  if (settings.provider === "openai" && settings.apiKey) return settings.apiKey;
  return "";
}

function friendlyNetworkError(error, label) {
  if (error?.name === "AbortError") return new Error(`${label} took too long to respond.`);
  if (error instanceof TypeError) return new Error(`The browser could not reach ${label}. In a web browser this is usually a CORS block: run the desktop server and route requests through it, or check the base URL in Settings.`);
  return error;
}

async function fetchJsonWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    return { response, payload };
  } finally {
    clearTimeout(timer);
  }
}

/** One JSON chat completion, direct from the browser. */
async function directChatJson(config, { system, user, maxTokens, timeoutMs }) {
  const label = AI_PROVIDERS[config.provider].label;
  const request = buildChatRequest(config, { system, user, maxTokens, browser: true });
  let result;
  try {
    result = await fetchJsonWithTimeout(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(request.body) }, timeoutMs);
  } catch (error) {
    throw friendlyNetworkError(error, label);
  }
  return extractJson(parseChatResponse(config, result.payload, result.response.status));
}

/** POST to a local-server endpoint, attaching the device key so the server can proxy it. */
async function serverPost(path, body, timeoutMs) {
  const device = deviceAiConfig();
  let result;
  try {
    result = await fetchJsonWithTimeout(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, ai: device ? { ...device } : undefined })
    }, timeoutMs);
  } catch (error) {
    throw friendlyNetworkError(error, "the local server");
  }
  if (!result.response.ok) throw new Error(result.payload?.error || `The local server returned HTTP ${result.response.status}.`);
  return result.payload;
}

function requireDeviceConfig() {
  const device = deviceAiConfig();
  if (!device) throw new Error("No AI provider is configured on this device. Open Settings and add an API key for Claude, GPT, Kimi, or DeepSeek.");
  return device;
}

async function runJob({ path, body, system, user, maxTokens, timeoutMs }) {
  await getServerHealth();
  if (activeTransport() === "server") return serverPost(path, body, timeoutMs);
  const device = requireDeviceConfig();
  return { direct: await directChatJson(device, { system, user, maxTokens, timeoutMs }), provider: device.provider, model: device.model };
}

export async function interpretVoice(transcript, context) {
  const result = await runJob({
    path: "/api/voice/interpret", body: { transcript, context },
    system: VOICE_SYSTEM_PROMPT, user: voiceUserPrompt(clipped(transcript, 8000), context), maxTokens: 3500, timeoutMs: 90_000
  });
  if (result.direct) return { plan: normalizeVoicePlan(result.direct), model: result.model, provider: result.provider };
  return result;
}

export async function defineCondition(kind, record, context) {
  const result = await runJob({
    path: "/api/approval-condition", body: { kind, record, context },
    system: APPROVAL_SYSTEM_PROMPT, user: approvalUserPrompt(kind, record, context), maxTokens: 700, timeoutMs: 45_000
  });
  if (result.direct) return { ...normalizeCondition(result.direct), model: result.model, provider: result.provider };
  return result;
}

export async function judgeDispute(packet) {
  const result = await runJob({
    path: "/api/judge", body: { packet },
    system: JUDGE_SYSTEM_PROMPT, user: judgeUserPrompt(packet), maxTokens: 4000, timeoutMs: 90_000
  });
  if (result.direct) {
    return {
      judgement: normalizeJudgement(result.direct), model: result.model, provider: result.provider,
      evidenceSnapshot: { packetHash: null, gameId: packet.game?.id || null, rulebookVersion: packet.game?.rulebookVersion || null, disputeId: packet.dispute?.id || null, linkedContractId: packet.linkedContract?.id || null, ledgerEventIds: (packet.relevantLedger || []).map(event => event.id), generatedAt: new Date().toISOString(), transport: "direct" }
    };
  }
  return result;
}

/** A tiny round-trip to prove the key, model, and route work. */
export async function testConnection() {
  await getServerHealth(true);
  if (activeTransport() === "server") return serverPost("/api/ai/test", {}, 30_000);
  const device = requireDeviceConfig();
  const result = await directChatJson(device, { system: CONNECTION_TEST_SYSTEM_PROMPT, user: CONNECTION_TEST_USER_PROMPT, maxTokens: 200, timeoutMs: 30_000 });
  return { ok: true, provider: device.provider, label: AI_PROVIDERS[device.provider].label, model: device.model, greeting: clipped(result?.greeting, 200), transport: "direct" };
}

/** Send recorded audio to OpenAI, via the server when available or straight from the device. */
export async function transcribeAudio(blob, { language = "en" } = {}) {
  if (!(blob instanceof Blob) || !blob.size) throw new Error("The audio recording was empty.");
  const status = transcriptionStatus();
  if (status.mode !== "openai") throw new Error(status.reason || "OpenAI transcription is not available. Use browser speech recognition or type the command.");
  const key = openaiKeyForTranscription();
  await getServerHealth();
  if (activeTransport() === "server") {
    const headers = { "Content-Type": blob.type || "audio/webm", "X-Transcription-Language": String(language).slice(0, 16) };
    if (key) headers["X-OpenAI-Key"] = key;
    let response;
    try { response = await fetch("/api/voice/transcribe", { method: "POST", headers, body: blob }); }
    catch (error) { throw friendlyNetworkError(error, "the local server"); }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "OpenAI transcription failed.");
    return { transcript: String(data.transcript || "").trim(), model: data.model || "OpenAI transcription", provider: "OpenAI" };
  }
  if (!key) throw new Error("Add an OpenAI key in Settings to transcribe audio from this device.");
  const form = buildTranscriptionForm(blob, { model: "gpt-4o-transcribe", language, contentType: blob.type });
  let response;
  try { response = await fetch(transcriptionEndpoint(AI_PROVIDERS.openai.defaultBaseUrl), { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form }); }
  catch (error) { throw friendlyNetworkError(error, "OpenAI"); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI transcription failed with HTTP ${response.status}.`);
  const transcript = String(data.text || "").trim();
  if (!transcript) throw new Error("No speech was recognized in the recording.");
  return { transcript, model: "gpt-4o-transcribe", provider: "OpenAI" };
}
