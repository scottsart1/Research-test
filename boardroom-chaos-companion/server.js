import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 4173);
const model = process.env.DEEPSEEK_MODEL || "deepseek-v4-pro";
const reasoningEffort = process.env.DEEPSEEK_REASONING_EFFORT || "high";
const apiKey = process.env.DEEPSEEK_API_KEY || "";
const deepseekBaseUrl = String(process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const voiceModel = process.env.DEEPSEEK_VOICE_MODEL || model;
const voiceReasoningEffort = process.env.DEEPSEEK_VOICE_REASONING_EFFORT || reasoningEffort;
const openaiApiKey = process.env.OPENAI_API_KEY || "";
const openaiBaseUrl = String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const transcriptionModel = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-transcribe";

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

function audioExtension(contentType = "") {
  const type = String(contentType).split(";")[0].trim().toLowerCase();
  return ({ "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav" })[type] || "webm";
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

async function requestOpenAITranscription(audio, contentType, language = "en") {
  if (!openaiApiKey) throw new HttpError(503, "OPENAI_API_KEY is not configured on the local server.");
  if (!audio?.length) throw new HttpError(400, "The audio recording was empty.");
  const form = new FormData();
  form.append("file", new Blob([audio], { type: contentType || "audio/webm" }), `boardroom-command.${audioExtension(contentType)}`);
  form.append("model", transcriptionModel);
  form.append("response_format", "json");
  if (language) form.append("language", String(language).slice(0, 16));
  form.append("prompt", "Boardroom Chaos Monopoly game. Player names, property names, money amounts, stock trades, mergers, houses, hotels, mortgages, rent, taxes, contracts, and Free Parking.");
  const response = await fetchWithTimeout(`${openaiBaseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiApiKey}` },
    body: form
  }, 60_000);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(502, payload?.error?.message || `OpenAI transcription failed with HTTP ${response.status}.`);
  const text = String(payload.text || "").trim();
  if (!text) throw new HttpError(502, "OpenAI returned an empty transcript.");
  return text;
}

/**
 * One JSON-mode chat completion against DeepSeek. Every DeepSeek feature (voice interpretation,
 * approval conditions, and rule judging) goes through here so timeouts, error mapping, and
 * JSON parsing behave identically.
 */
async function deepseekChat({ system, user, chatModel = model, effort = reasoningEffort, maxTokens, timeoutMs, emptyMessage }) {
  if (!apiKey) throw new HttpError(503, "DEEPSEEK_API_KEY is not configured on the local server.");
  const response = await fetchWithTimeout(`${deepseekBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: chatModel,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      thinking: { type: "enabled" },
      reasoning_effort: effort,
      response_format: { type: "json_object" },
      max_tokens: maxTokens
    })
  }, timeoutMs);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(502, payload?.error?.message || `DeepSeek returned HTTP ${response.status}.`);
  const content = String(payload?.choices?.[0]?.message?.content || "").trim();
  if (!content) throw new HttpError(502, emptyMessage);
  try {
    return JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    throw new HttpError(502, "DeepSeek returned a response that was not valid JSON.");
  }
}

const VOICE_ACTION_TYPES = new Set([
  "transfer_cash",
  "buy_property",
  "pay_rent",
  "create_deal",
  "sign_deal",
  "roll_deal_approval",
  "accept_deal_condition",
  "execute_deal",
  "create_contract",
  "update_contract_status",
  "create_dispute",
  "pass_go",
  "advance_turn",
  "set_mortgage",
  "set_buildings",
  "voice_note"
]);

const clipped = (value, max = 500) => String(value ?? "").trim().slice(0, max);
const finiteOrNull = value => Number.isFinite(Number(value)) ? Number(value) : null;
const boolOrNull = value => typeof value === "boolean" ? value : null;
const stringList = (value, max = 12) => Array.isArray(value) ? value.map(item => clipped(item, 180)).filter(Boolean).slice(0, max) : [];

function normalizeVoiceAsset(raw = {}) {
  const type = clipped(raw.type, 40);
  if (type === "cash") return { type, amount: finiteOrNull(raw.amount) };
  if (type === "property_share") return { type, propertyId: clipped(raw.propertyId, 100), percent: finiteOrNull(raw.percent) ?? 100 };
  if (type === "jail_card") return { type, quantity: finiteOrNull(raw.quantity) ?? 1 };
  return null;
}

function normalizeVoiceFields(type, raw = {}) {
  const assets = value => Array.isArray(value) ? value.map(normalizeVoiceAsset).filter(Boolean).slice(0, 8) : [];
  switch (type) {
    case "transfer_cash": return { fromId: clipped(raw.fromId, 100), toId: clipped(raw.toId, 100), amount: finiteOrNull(raw.amount), memo: clipped(raw.memo, 180) };
    case "buy_property": return { playerId: clipped(raw.playerId, 100), propertyId: clipped(raw.propertyId, 100), price: finiteOrNull(raw.price) };
    case "pay_rent": return { visitorId: clipped(raw.visitorId, 100), propertyId: clipped(raw.propertyId, 100), diceTotal: finiteOrNull(raw.diceTotal), discountPercent: finiteOrNull(raw.discountPercent) ?? 0 };
    case "create_deal": return {
      title: clipped(raw.title, 100), proposerId: clipped(raw.proposerId, 100), counterpartyId: clipped(raw.counterpartyId, 100),
      proposerGives: assets(raw.proposerGives), counterpartyGives: assets(raw.counterpartyGives), terms: clipped(raw.terms, 3000)
    };
    case "sign_deal": return { dealId: clipped(raw.dealId, 100), playerId: clipped(raw.playerId, 100) };
    case "roll_deal_approval": return { dealId: clipped(raw.dealId, 100) };
    case "accept_deal_condition": return { dealId: clipped(raw.dealId, 100), playerId: clipped(raw.playerId, 100) };
    case "execute_deal": return { dealId: clipped(raw.dealId, 100) };
    case "create_contract": return {
      title: clipped(raw.title, 120), type: clipped(raw.type || "custom", 40), partyIds: stringList(raw.partyIds, 8),
      terms: clipped(raw.terms, 4000), status: clipped(raw.status || "draft", 30), expiresRound: finiteOrNull(raw.expiresRound)
    };
    case "update_contract_status": return { contractId: clipped(raw.contractId, 100), status: clipped(raw.status, 30) };
    case "create_dispute": return {
      title: clipped(raw.title, 120), linkedContractId: clipped(raw.linkedContractId, 100), claimantId: clipped(raw.claimantId, 100), respondentId: clipped(raw.respondentId, 100),
      issue: clipped(raw.issue, 3000), evidence: clipped(raw.evidence, 3000), requestedRemedy: clipped(raw.requestedRemedy, 1000)
    };
    case "pass_go": return { playerId: clipped(raw.playerId, 100) };
    case "advance_turn": return {};
    case "set_mortgage": return { propertyId: clipped(raw.propertyId, 100), mortgaged: boolOrNull(raw.mortgaged) };
    case "set_buildings": return { propertyId: clipped(raw.propertyId, 100), buildings: finiteOrNull(raw.buildings) };
    case "voice_note": return { category: clipped(raw.category || "note", 40), summary: clipped(raw.summary, 500), actorIds: stringList(raw.actorIds, 8) };
    default: return {};
  }
}

function normalizeVoicePlan(raw = {}) {
  const actions = Array.isArray(raw.actions) ? raw.actions : [];
  const normalizedActions = actions.slice(0, 8).map(action => {
    const type = clipped(action?.type, 60);
    if (!VOICE_ACTION_TYPES.has(type)) return null;
    return {
      type,
      description: clipped(action.description || type.replaceAll("_", " "), 300),
      confidence: Math.max(0, Math.min(1, Number(action.confidence ?? raw.confidence ?? 0))),
      requiresConfirmation: action.requires_confirmation !== false || type !== "voice_note",
      fields: normalizeVoiceFields(type, action.fields || {}),
      ambiguities: stringList(action.ambiguities, 8),
      sourceQuote: clipped(action.source_quote, 500)
    };
  }).filter(Boolean);
  const allowedStatuses = new Set(["ready", "needs_review", "not_understood"]);
  const unresolved = stringList(raw.unresolved, 12);
  const status = allowedStatuses.has(raw.status) ? raw.status : (normalizedActions.length && !unresolved.length ? "ready" : "needs_review");
  return {
    status,
    summary: clipped(raw.summary || (normalizedActions.length ? `${normalizedActions.length} action(s) interpreted` : "No action interpreted"), 500),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? 0))),
    actions: normalizedActions,
    unresolved,
    suggestedClarification: clipped(raw.suggested_clarification, 500)
  };
}

const VOICE_SYSTEM_PROMPT = `You are the Voice Game Clerk for Boardroom Chaos Companion, a private conventional Monopoly game with documented house rules.

Convert a spoken transcript into a conservative JSON action plan. You categorize and propose; the local deterministic game engine executes and validates. Never invent a player, property, amount, percentage, dice total, contract, deal, or intention. Use only exact IDs supplied in context. When a material field is missing or two entities could match, put the issue in unresolved and set status to needs_review. Spoken background chatter is not an instruction unless it clearly describes a game event or starts with phrases such as "log", "record", "create", "pay", "buy", "transfer", "sign", "approve", "execute", "mortgage", "build", "end turn", or "open a case".

Distinguish:
- "Sam pays Alex 200" => transfer_cash.
- "Sam landed on Boardwalk, pay rent" => pay_rent; do not guess a utility dice total.
- "Alex buys Boardwalk for 400" => buy_property.
- A player-to-player property transfer is always a create_deal filing, never an immediate action.
- "Create/propose a deal" => create_deal, not an immediate transfer.
- "We agree/promise" => create_contract unless explicitly described as a deal proposal.
- "Open a case/dispute" => create_dispute.
- "Alex passed GO" => pass_go for Alex.
- "Log/note" without enforceable terms => voice_note.

Allowed action types and fields:
transfer_cash {fromId,toId,amount,memo}
buy_property {playerId,propertyId,price|null}
pay_rent {visitorId,propertyId,diceTotal|null,discountPercent}
create_deal {title,proposerId,counterpartyId,proposerGives:[cash or property_share],counterpartyGives:[...],terms}
sign_deal {dealId,playerId}
roll_deal_approval {dealId}
accept_deal_condition {dealId,playerId}
execute_deal {dealId}
create_contract {title,type,partyIds,terms,status:draft|active,expiresRound|null}
update_contract_status {contractId,status}
create_dispute {title,linkedContractId|null,claimantId|null,respondentId|null,issue,evidence,requestedRemedy}
pass_go {playerId}
advance_turn {}
set_mortgage {propertyId,mortgaged:true|false}
set_buildings {propertyId,buildings:0..5}
voice_note {category,summary,actorIds}

Return JSON only using exactly this top-level shape:
{
  "status":"ready|needs_review|not_understood",
  "summary":"plain-language batch summary",
  "confidence":0.0,
  "actions":[{
    "type":"transfer_cash",
    "description":"plain-language action",
    "confidence":0.0,
    "requires_confirmation":true,
    "fields":{},
    "ambiguities":[],
    "source_quote":"exact relevant words"
  }],
  "unresolved":[],
  "suggested_clarification":""
}`;

async function requestDeepSeekVoice(transcript, context) {
  const raw = await deepseekChat({
    system: VOICE_SYSTEM_PROMPT,
    user: `Interpret this transcript as JSON.\nTRANSCRIPT:\n${transcript}\n\nCURRENT GAME CONTEXT:\n${JSON.stringify(context)}`,
    chatModel: voiceModel,
    effort: voiceReasoningEffort,
    maxTokens: 3500,
    timeoutMs: 90_000,
    emptyMessage: "DeepSeek returned an empty voice interpretation."
  });
  return normalizeVoicePlan(raw);
}

const APPROVAL_SYSTEM_PROMPT = `You are the regulatory approval clerk for a private four-player Monopoly house-rule game.
The proposal has already landed in the 40% "approved with conditions" band. Write exactly one concise, measurable in-game condition.
The condition must be understandable to a lay player, possible to track in the ledger, and must not secretly replace the whole bargain. Choose one of these mechanics only: extra_settlement_round, supermajority_vote, rent_relief, public_disclosure, asset_lock, or none. Do not invent real-world law. Do not add more than one condition.
Return JSON only: {"condition":"one enforceable sentence","mechanic":"one allowed mechanic","value":1}. Use value 1 for an extra round, 60 for a supermajority, and null for other mechanics.`;

const ALLOWED_CONDITION_MECHANICS = new Set(["extra_settlement_round", "supermajority_vote", "rent_relief", "public_disclosure", "asset_lock", "none"]);

async function requestApprovalCondition(kind, record, context = {}) {
  const parsed = await deepseekChat({
    system: APPROVAL_SYSTEM_PROMPT,
    user: `KIND: ${clipped(kind, 40)}\nPROPOSAL: ${JSON.stringify(record)}\nCOMPACT GAME CONTEXT: ${JSON.stringify(context)}`,
    maxTokens: 700,
    timeoutMs: 45_000,
    emptyMessage: "DeepSeek returned an empty approval condition."
  });
  const condition = clipped(parsed.condition, 600);
  if (!condition) throw new HttpError(502, "DeepSeek did not provide a usable approval condition.");
  const mechanic = ALLOWED_CONDITION_MECHANICS.has(parsed.mechanic) ? parsed.mechanic : "none";
  const value = Number.isFinite(Number(parsed.value)) ? Number(parsed.value) : null;
  return { condition, mechanic, value };
}

function normalizeJudgement(raw) {
  const confidence = Math.max(0, Math.min(1, Number(raw.confidence ?? 0)));
  return {
    verdict: String(raw.verdict || "insufficient_evidence").slice(0, 120),
    confidence,
    citedRuleIds: Array.isArray(raw.cited_rule_ids) ? raw.cited_rule_ids.map(String).slice(0, 12) : [],
    findings: Array.isArray(raw.findings) ? raw.findings.map(String).slice(0, 12) : [],
    orders: Array.isArray(raw.orders) ? raw.orders.map(String).slice(0, 10) : [],
    explanation: String(raw.reasoning_summary || raw.explanation || "").slice(0, 5000),
    ambiguities: Array.isArray(raw.ambiguities) ? raw.ambiguities.map(String).slice(0, 10) : [],
    suggestedVote: String(raw.suggested_vote || "").slice(0, 500)
  };
}

const JUDGE_SYSTEM_PROMPT = `You are the Rule Test Judge for a private tabletop game called Boardroom Chaos Companion.

Your authority is limited to the supplied rulebook, signed contracts, current game state, and ledger evidence. Apply this hierarchy: (1) explicit house rule, (2) exact signed contract term, (3) conventional Monopoly baseline, (4) narrow interpretation that changes the fewest recorded rights. Never invent a new rule. Never enforce a secret or unrecorded promise. Never transfer assets when material facts are missing. If confidence is below 0.70 or the evidence does not establish a required fact, use verdict "insufficient_evidence" and recommend a neutral vote or fact-finding step.

Return JSON only. Do not reveal hidden chain-of-thought. Provide a concise reasoning summary suitable for an audit record. Use exactly this schema:
{
  "verdict": "snake_case_result",
  "confidence": 0.0,
  "cited_rule_ids": ["R-03"],
  "findings": ["Short factual finding"],
  "orders": ["Concrete in-game remedy or next step"],
  "reasoning_summary": "Concise explanation, not private chain-of-thought",
  "ambiguities": ["Missing or disputed fact"],
  "suggested_vote": "How neutral players should resolve any remaining issue"
}`;

async function requestDeepSeekJudgement(packet) {
  const raw = await deepseekChat({
    system: JUDGE_SYSTEM_PROMPT,
    user: `Decide this case from the following JSON evidence packet:\n${JSON.stringify(packet)}`,
    maxTokens: 4000,
    timeoutMs: 90_000,
    emptyMessage: "DeepSeek returned an empty ruling."
  });
  return normalizeJudgement(raw);
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
    deepseekConfigured: Boolean(apiKey),
    model,
    reasoningEffort,
    voiceInterpreter: { configured: Boolean(apiKey), model: voiceModel, reasoningEffort: voiceReasoningEffort },
    transcription: { configured: Boolean(openaiApiKey), provider: "OpenAI", model: transcriptionModel },
    privacy: "API keys remain on this local server; audio is sent to OpenAI for transcription and the resulting text is sent to DeepSeek for interpretation."
  }),

  "POST /api/voice/transcribe": async (req, res) => {
    if (!openaiApiKey) return sendJson(res, 503, { error: "OPENAI_API_KEY is not configured on the local server." });
    const contentType = String(req.headers["content-type"] || "audio/webm");
    if (!contentType.startsWith("audio/")) return sendJson(res, 415, { error: "Send an audio recording with an audio Content-Type." });
    const audio = await readRawBody(req);
    const language = String(req.headers["x-transcription-language"] || "en").trim();
    const transcript = await requestOpenAITranscription(audio, contentType, language);
    return sendJson(res, 200, { transcript, provider: "OpenAI", model: transcriptionModel, transcribedAt: new Date().toISOString() });
  },

  "POST /api/voice/interpret": async (req, res) => {
    if (!apiKey) return sendJson(res, 503, { error: "DEEPSEEK_API_KEY is not configured on the local server." });
    const { transcript, context } = await readBody(req);
    const cleanTranscript = clipped(transcript, 8000);
    if (!cleanTranscript) return sendJson(res, 400, { error: "A transcript is required." });
    if (!context?.game || !Array.isArray(context?.players) || !Array.isArray(context?.properties)) return sendJson(res, 400, { error: "Valid compact game context is required." });
    const plan = await requestDeepSeekVoice(cleanTranscript, context);
    return sendJson(res, 200, { plan, model: voiceModel, reasoningEffort: voiceReasoningEffort, interpretedAt: new Date().toISOString() });
  },

  "POST /api/approval-condition": async (req, res) => {
    if (!apiKey) return sendJson(res, 503, { error: "DEEPSEEK_API_KEY is not configured on the local server." });
    const { kind, record, context } = await readBody(req);
    if (!record || !kind) return sendJson(res, 400, { error: "A proposal kind and record are required." });
    const conditionData = await requestApprovalCondition(kind, record, context || {});
    return sendJson(res, 200, { ...conditionData, model, reasoningEffort, generatedAt: new Date().toISOString() });
  },

  "POST /api/judge": async (req, res) => {
    if (!apiKey) return sendJson(res, 503, { error: "DEEPSEEK_API_KEY is not configured on the local server." });
    const { packet } = await readBody(req);
    if (!packet?.dispute || !Array.isArray(packet?.rules)) return sendJson(res, 400, { error: "A valid evidence packet is required." });
    const packetHash = createHash("sha256").update(JSON.stringify(packet)).digest("hex");
    const judgement = await requestDeepSeekJudgement(packet);
    return sendJson(res, 200, {
      judgement,
      model,
      reasoningEffort,
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
  console.log(`DeepSeek judge: ${apiKey ? `${model} (${reasoningEffort})` : "not configured"}`);
  console.log(`Voice interpreter: ${apiKey ? `${voiceModel} (${voiceReasoningEffort})` : "not configured"}`);
  console.log(`OpenAI transcription: ${openaiApiKey ? transcriptionModel : "not configured"}`);
});
