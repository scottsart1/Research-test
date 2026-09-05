/**
 * Provider-neutral request builders shared by the browser (direct mode) and the local
 * Node server (proxy mode). Nothing here touches the network; callers pass the
 * returned { url, headers, body } to fetch and hand the parsed JSON back to
 * parseChatResponse. Keeping this in one file means Claude, GPT, Kimi, and DeepSeek
 * behave identically whichever transport the app is using.
 */

export const AI_PROVIDERS = Object.freeze({
  claude: Object.freeze({
    id: "claude",
    label: "Claude (Anthropic)",
    style: "anthropic",
    defaultModel: "claude-opus-5",
    defaultBaseUrl: "https://api.anthropic.com",
    keyHint: "sk-ant-…",
    keysUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]
  }),
  openai: Object.freeze({
    id: "openai",
    label: "GPT (OpenAI)",
    style: "openai",
    defaultModel: "gpt-4o",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyHint: "sk-…",
    keysUrl: "https://platform.openai.com/api-keys",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4.1"],
    transcription: true
  }),
  kimi: Object.freeze({
    id: "kimi",
    label: "Kimi (Moonshot AI)",
    style: "openai",
    defaultModel: "kimi-k2-0905-preview",
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    keyHint: "sk-…",
    keysUrl: "https://platform.moonshot.ai/console/api-keys",
    models: ["kimi-k2-0905-preview", "kimi-k2-turbo-preview", "moonshot-v1-32k"]
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    label: "DeepSeek",
    style: "openai",
    defaultModel: "deepseek-v4-pro",
    defaultBaseUrl: "https://api.deepseek.com",
    keyHint: "sk-…",
    keysUrl: "https://platform.deepseek.com/api_keys",
    models: ["deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
    reasoningEffort: true
  })
});

export const AI_PROVIDER_IDS = Object.keys(AI_PROVIDERS);
export const ANTHROPIC_VERSION = "2023-06-01";

const trimSlash = value => String(value || "").trim().replace(/\/+$/, "");

/** Coerce any loosely shaped settings object into a complete, validated provider config. */
export function normalizeAiConfig(raw = {}) {
  const provider = AI_PROVIDERS[raw.provider] ? raw.provider : null;
  if (!provider) return null;
  const meta = AI_PROVIDERS[provider];
  return {
    provider,
    apiKey: String(raw.apiKey || "").trim(),
    model: String(raw.model || "").trim() || meta.defaultModel,
    baseUrl: trimSlash(raw.baseUrl) || meta.defaultBaseUrl,
    reasoningEffort: meta.reasoningEffort ? (String(raw.reasoningEffort || "").trim() || "high") : null
  };
}

export function isAiConfigured(config) {
  return Boolean(config && config.provider && config.apiKey);
}

/** Build the HTTP request for one JSON-only chat completion. */
export function buildChatRequest(config, { system, user, maxTokens = 2000, browser = false }) {
  const cfg = normalizeAiConfig(config);
  if (!isAiConfigured(cfg)) throw new Error("No AI provider is configured. Add an API key in Settings.");
  const meta = AI_PROVIDERS[cfg.provider];
  if (meta.style === "anthropic") {
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": ANTHROPIC_VERSION
    };
    if (browser) headers["anthropic-dangerous-direct-browser-access"] = "true";
    return {
      url: `${cfg.baseUrl}/v1/messages`,
      headers,
      body: {
        model: cfg.model,
        max_tokens: maxTokens,
        system: `${system}\n\nRespond with a single JSON object and nothing else.`,
        messages: [{ role: "user", content: user }]
      }
    };
  }
  const body = {
    model: cfg.model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    response_format: { type: "json_object" }
  };
  if (cfg.provider === "openai") body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;
  if (cfg.provider === "deepseek" && cfg.reasoningEffort) {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = cfg.reasoningEffort;
  }
  return {
    url: `${cfg.baseUrl}/chat/completions`,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
    body
  };
}

/** Pull the assistant text out of a provider's JSON payload, or throw a readable error. */
export function parseChatResponse(config, payload, httpStatus = 200) {
  const cfg = normalizeAiConfig(config);
  const label = cfg ? AI_PROVIDERS[cfg.provider].label : "The AI provider";
  if (httpStatus < 200 || httpStatus >= 300) {
    const message = payload?.error?.message || payload?.message || `${label} returned HTTP ${httpStatus}.`;
    throw new Error(httpStatus === 401 || httpStatus === 403 ? `${label} rejected the API key: ${message}` : `${label}: ${message}`);
  }
  if (payload?.error?.message) throw new Error(`${label}: ${payload.error.message}`);
  let text = "";
  if (cfg && AI_PROVIDERS[cfg.provider].style === "anthropic") {
    if (payload?.stop_reason === "refusal") throw new Error(`${label} declined this request (${payload?.stop_details?.category || "policy"}).`);
    text = (payload?.content || []).filter(block => block?.type === "text").map(block => block.text).join("");
  } else {
    text = payload?.choices?.[0]?.message?.content ?? "";
    if (Array.isArray(text)) text = text.map(part => part?.text || "").join("");
  }
  text = String(text || "").trim();
  if (!text) throw new Error(`${label} returned an empty response.`);
  return text;
}

/** Parse JSON out of model text, tolerating code fences and stray prose around the object. */
export function extractJson(text) {
  const clean = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(clean);
  } catch {
    const start = clean.indexOf("{");
    const end = clean.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(clean.slice(start, end + 1)); } catch { /* fall through */ }
    }
    throw new Error("The AI response was not valid JSON.");
  }
}

/** OpenAI is the only supported audio transcription provider. */
export function transcriptionEndpoint(baseUrl) {
  return `${trimSlash(baseUrl) || AI_PROVIDERS.openai.defaultBaseUrl}/audio/transcriptions`;
}

export function audioExtension(contentType = "") {
  const type = String(contentType).split(";")[0].trim().toLowerCase();
  return ({ "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/x-m4a": "m4a", "audio/aac": "aac" })[type] || "webm";
}

/** Multipart body for OpenAI transcription; works with the browser and Node FormData alike. */
export function buildTranscriptionForm(audioBlob, { model = "gpt-4o-transcribe", language = "en", contentType = "audio/webm" } = {}) {
  const form = new FormData();
  form.append("file", audioBlob, `boardroom-command.${audioExtension(contentType)}`);
  form.append("model", model);
  form.append("response_format", "json");
  if (language) form.append("language", String(language).slice(0, 16));
  form.append("prompt", "Boardroom Chaos Monopoly game. Player names, property names, money amounts, stock trades, mergers, houses, hotels, mortgages, rent, taxes, contracts, and Free Parking.");
  return form;
}
