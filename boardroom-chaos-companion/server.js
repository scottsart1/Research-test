import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { AI_PROVIDERS, normalizeAiConfig, isAiConfigured, buildChatRequest, parseChatResponse, extractJson, transcriptionEndpoint, buildTranscriptionForm } from "./public/ai-providers.js";
import {
  clipped, normalizeVoicePlan, normalizeCondition, normalizeJudgement,
  VOICE_SYSTEM_PROMPT, voiceUserPrompt, APPROVAL_SYSTEM_PROMPT, approvalUserPrompt, JUDGE_SYSTEM_PROMPT, judgeUserPrompt,
  CONNECTION_TEST_SYSTEM_PROMPT, CONNECTION_TEST_USER_PROMPT
} from "./public/ai-prompts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 4173);

/**
 * Server-side AI configuration comes from environment variables. Generic AI_* variables
 * pick any supported provider; the older DEEPSEEK_* variables still work as a fallback.
 * A request may also carry its own provider config (entered in the app's Settings page),
 * which takes precedence so the desktop server can proxy a key the player typed in.
 */
function envAiConfig() {
  if (process.env.AI_API_KEY) {
    return normalizeAiConfig({
      provider: AI_PROVIDERS[process.env.AI_PROVIDER] ? process.env.AI_PROVIDER : "deepseek",
      apiKey: process.env.AI_API_KEY,
      model: process.env.AI_MODEL,
      baseUrl: process.env.AI_BASE_URL,
      reasoningEffort: process.env.AI_REASONING_EFFORT
    });
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return normalizeAiConfig({
      provider: "deepseek",
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL,
      baseUrl: process.env.DEEPSEEK_BASE_URL,
      reasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT
    });
  }
  return null;
}
const serverAi = envAiConfig();
const envOpenaiKey = process.env.OPENAI_API_KEY || "";
const openaiBaseUrl = String(process.env.OPENAI_BASE_URL || AI_PROVIDERS.openai.defaultBaseUrl).replace(/\/+$/, "");
const transcriptionModel = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-transcribe";

/** Per-request override (from the app's Settings page) or the server's own environment config. */
function resolveAiConfig(override) {
  const requested = override && typeof override === "object" ? normalizeAiConfig(override) : null;
  if (isAiConfigured(requested)) return requested;
  return serverAi;
}

function resolveTranscription(override) {
  const key = String(override?.openaiApiKey || "").trim() || envOpenaiKey;
  return { apiKey: key, baseUrl: String(override?.openaiBaseUrl || "").trim().replace(/\/+$/, "") || openaiBaseUrl, model: transcriptionModel };
}

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

/** An error that carries the HTTP status the client should receive. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

async function collectBody(req, limit, tooLargeMessage) {
  let size = 0;
  let tooLarge = false;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      // Keep draining so the 413 reply reaches the client instead of a reset connection.
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) throw new HttpError(413, tooLargeMessage);
  return Buffer.concat(chunks);
}

async function readBody(req, limit = 1_000_000) {
  const raw = (await collectBody(req, limit, "Request is too large.")).toString("utf8");
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw new HttpError(400, "Request body must be valid JSON.");
  }
}

function readRawBody(req, limit = 15_000_000) {
  return collectBody(req, limit, "Audio recording is too large. Keep each voice command under about one minute.");
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestOpenAITranscription(transcription, audio, contentType, language = "en") {
  if (!transcription.apiKey) throw new HttpError(503, "No OpenAI key is available for transcription. Add one in Settings or set OPENAI_API_KEY on the server.");
  if (!audio?.length) throw new HttpError(400, "The audio recording was empty.");
  const form = buildTranscriptionForm(new Blob([audio], { type: contentType || "audio/webm" }), { model: transcription.model, language, contentType });
  const response = await fetchWithTimeout(transcriptionEndpoint(transcription.baseUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${transcription.apiKey}` },
    body: form
  }, 60_000);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(502, payload?.error?.message || `OpenAI transcription failed with HTTP ${response.status}.`);
  const text = String(payload.text || "").trim();
  if (!text) throw new HttpError(502, "OpenAI returned an empty transcript.");
  return text;
}

/**
 * One JSON-only chat completion against whichever provider the config names.
 * Request shape and response parsing live in public/ai-providers.js so the browser's
 * direct mode and this proxy behave identically.
 */
async function aiChatJson(config, { system, user, maxTokens, timeoutMs }) {
  if (!isAiConfigured(config)) throw new HttpError(503, "No AI provider is configured. Add an API key in Settings or set AI_API_KEY on the server.");
  const request = buildChatRequest(config, { system, user, maxTokens, browser: false });
  const response = await fetchWithTimeout(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(request.body) }, timeoutMs);
  const payload = await response.json().catch(() => ({}));
  let text;
  try {
    text = parseChatResponse(config, payload, response.status);
  } catch (error) {
    throw new HttpError(502, error.message);
  }
  try {
    return extractJson(text);
  } catch {
    throw new HttpError(502, `${AI_PROVIDERS[config.provider].label} returned a response that was not valid JSON.`);
  }
}

function aiDescriptor(config) {
  return config ? { provider: config.provider, label: AI_PROVIDERS[config.provider].label, model: config.model, reasoningEffort: config.reasoningEffort } : null;
}

async function serveStatic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed." });
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(publicDir, `.${path.posix.normalize(requested)}`);
  // The resolved file must sit inside public/ (a sibling directory sharing the prefix does not count).
  if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) return sendJson(res, 403, { error: "Forbidden" });
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mime[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": path.basename(filePath) === "sw.js" ? "no-cache" : "public, max-age=300"
    });
    res.end(data);
  } catch {
    if (!path.extname(pathname)) {
      const data = await readFile(path.join(publicDir, "index.html"));
      res.writeHead(200, { "Content-Type": mime[".html"], "Cache-Control": "no-cache" });
      return res.end(data);
    }
    sendJson(res, 404, { error: "Not found" });
  }
}

const apiRoutes = {
  "GET /api/health": async (req, res) => sendJson(res, 200, {
    ok: true,
    version: "1.5.0",
    ai: { configured: isAiConfigured(serverAi), source: isAiConfigured(serverAi) ? "server" : "none", ...(aiDescriptor(serverAi) || {}) },
    transcription: { configured: Boolean(envOpenaiKey), provider: "OpenAI", model: transcriptionModel },
    providers: Object.values(AI_PROVIDERS).map(({ id, label, defaultModel }) => ({ id, label, defaultModel })),
    // Legacy fields kept for older clients: "deepseekConfigured" now means "a server-side reasoning provider is configured".
    deepseekConfigured: isAiConfigured(serverAi),
    model: serverAi?.model || null,
    reasoningEffort: serverAi?.reasoningEffort || null,
    privacy: "API keys entered in the app are sent only to this local server and the chosen provider. Audio goes to OpenAI for transcription; transcripts and compact game context go to the selected reasoning provider."
  }),

  "POST /api/ai/test": async (req, res) => {
    const { ai } = await readBody(req);
    const config = resolveAiConfig(ai);
    const result = await aiChatJson(config, { system: CONNECTION_TEST_SYSTEM_PROMPT, user: CONNECTION_TEST_USER_PROMPT, maxTokens: 200, timeoutMs: 30_000 });
    return sendJson(res, 200, { ok: true, ...aiDescriptor(config), greeting: clipped(result?.greeting, 200), testedAt: new Date().toISOString() });
  },

  "POST /api/voice/transcribe": async (req, res) => {
    const contentType = String(req.headers["content-type"] || "audio/webm");
    if (!contentType.startsWith("audio/")) return sendJson(res, 415, { error: "Send an audio recording with an audio Content-Type." });
    const transcription = resolveTranscription({ openaiApiKey: req.headers["x-openai-key"], openaiBaseUrl: req.headers["x-openai-base-url"] });
    if (!transcription.apiKey) return sendJson(res, 503, { error: "No OpenAI key is available for transcription. Add one in Settings or set OPENAI_API_KEY on the server." });
    const audio = await readRawBody(req);
    const language = String(req.headers["x-transcription-language"] || "en").trim();
    const transcript = await requestOpenAITranscription(transcription, audio, contentType, language);
    return sendJson(res, 200, { transcript, provider: "OpenAI", model: transcription.model, transcribedAt: new Date().toISOString() });
  },

  "POST /api/voice/interpret": async (req, res) => {
    const { transcript, context, ai } = await readBody(req);
    const config = resolveAiConfig(ai);
    if (!isAiConfigured(config)) return sendJson(res, 503, { error: "No AI provider is configured. Add an API key in Settings or set AI_API_KEY on the server." });
    const cleanTranscript = clipped(transcript, 8000);
    if (!cleanTranscript) return sendJson(res, 400, { error: "A transcript is required." });
    if (!context?.game || !Array.isArray(context?.players) || !Array.isArray(context?.properties)) return sendJson(res, 400, { error: "Valid compact game context is required." });
    const raw = await aiChatJson(config, { system: VOICE_SYSTEM_PROMPT, user: voiceUserPrompt(cleanTranscript, context), maxTokens: 3500, timeoutMs: 90_000 });
    return sendJson(res, 200, { plan: normalizeVoicePlan(raw), ...aiDescriptor(config), interpretedAt: new Date().toISOString() });
  },

  "POST /api/approval-condition": async (req, res) => {
    const { kind, record, context, ai } = await readBody(req);
    const config = resolveAiConfig(ai);
    if (!isAiConfigured(config)) return sendJson(res, 503, { error: "No AI provider is configured. Add an API key in Settings or set AI_API_KEY on the server." });
    if (!record || !kind) return sendJson(res, 400, { error: "A proposal kind and record are required." });
    const raw = await aiChatJson(config, { system: APPROVAL_SYSTEM_PROMPT, user: approvalUserPrompt(kind, record, context || {}), maxTokens: 700, timeoutMs: 45_000 });
    let conditionData;
    try { conditionData = normalizeCondition(raw); } catch (error) { throw new HttpError(502, error.message); }
    return sendJson(res, 200, { ...conditionData, ...aiDescriptor(config), generatedAt: new Date().toISOString() });
  },

  "POST /api/judge": async (req, res) => {
    const { packet, ai } = await readBody(req);
    const config = resolveAiConfig(ai);
    if (!isAiConfigured(config)) return sendJson(res, 503, { error: "No AI provider is configured. Add an API key in Settings or set AI_API_KEY on the server." });
    if (!packet?.dispute || !Array.isArray(packet?.rules)) return sendJson(res, 400, { error: "A valid evidence packet is required." });
    const packetHash = createHash("sha256").update(JSON.stringify(packet)).digest("hex");
    const raw = await aiChatJson(config, { system: JUDGE_SYSTEM_PROMPT, user: judgeUserPrompt(packet), maxTokens: 4000, timeoutMs: 90_000 });
    return sendJson(res, 200, {
      judgement: normalizeJudgement(raw),
      ...aiDescriptor(config),
      evidenceSnapshot: {
        packetHash,
        gameId: packet.game?.id || null,
        rulebookVersion: packet.game?.rulebookVersion || null,
        disputeId: packet.dispute?.id || null,
        linkedContractId: packet.linkedContract?.id || null,
        ledgerEventIds: (packet.relevantLedger || []).map(event => event.id),
        generatedAt: new Date().toISOString()
      }
    });
  }
};

const apiPaths = new Set(Object.keys(apiRoutes).map(key => key.split(" ")[1]));

const server = http.createServer(async (req, res) => {
  try {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || "/", "http://localhost").pathname);
    } catch {
      throw new HttpError(400, "Malformed request path.");
    }
    const handler = apiRoutes[`${req.method} ${pathname}`];
    if (handler) return await handler(req, res);
    if (apiPaths.has(pathname)) return sendJson(res, 405, { error: "Method not allowed." });
    if (pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Unknown API route." });
    return await serveStatic(req, res, pathname);
  } catch (error) {
    const timedOut = error?.name === "AbortError";
    const status = timedOut ? 504 : Number(error?.status) || 500;
    const message = timedOut ? "AI provider request timed out." : error?.message || "Server error.";
    if (status >= 500) console.error(error);
    if (res.headersSent) return res.end();
    sendJson(res, status, { error: message });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Boardroom Chaos running at http://localhost:${port}`);
  console.log(`Server-side AI provider: ${isAiConfigured(serverAi) ? `${AI_PROVIDERS[serverAi.provider].label} · ${serverAi.model}` : "not configured (players can add a key in Settings)"}`);
  console.log(`OpenAI transcription: ${envOpenaiKey ? transcriptionModel : "not configured (players can add a key in Settings)"}`);
});
