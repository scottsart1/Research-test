import test from "node:test";
import assert from "node:assert/strict";
import { AI_PROVIDERS, normalizeAiConfig, isAiConfigured, buildChatRequest, parseChatResponse, extractJson } from "../public/ai-providers.js";
import { normalizeVoicePlan, normalizeCondition, normalizeJudgement } from "../public/ai-prompts.js";

test("every provider has a default model and base URL, and configs normalize to them", () => {
  for (const id of ["claude", "openai", "kimi", "deepseek"]) {
    const config = normalizeAiConfig({ provider: id, apiKey: "k" });
    assert.equal(config.provider, id);
    assert.equal(config.model, AI_PROVIDERS[id].defaultModel);
    assert.equal(config.baseUrl, AI_PROVIDERS[id].defaultBaseUrl);
    assert.equal(isAiConfigured(config), true);
  }
  assert.equal(normalizeAiConfig({ provider: "gemini", apiKey: "k" }), null);
  assert.equal(isAiConfigured(normalizeAiConfig({ provider: "claude", apiKey: "" })), false);
  assert.equal(normalizeAiConfig({ provider: "kimi", apiKey: "k", baseUrl: "https://example.test/v1///" }).baseUrl, "https://example.test/v1");
});

test("Claude requests use the Messages API shape and the browser opt-in header only in direct mode", () => {
  const config = { provider: "claude", apiKey: "sk-ant-x", model: "claude-opus-5" };
  const direct = buildChatRequest(config, { system: "S", user: "U", maxTokens: 500, browser: true });
  assert.equal(direct.url, "https://api.anthropic.com/v1/messages");
  assert.equal(direct.headers["x-api-key"], "sk-ant-x");
  assert.equal(direct.headers["anthropic-version"], "2023-06-01");
  assert.equal(direct.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(direct.body.model, "claude-opus-5");
  assert.equal(direct.body.max_tokens, 500);
  assert.deepEqual(direct.body.messages, [{ role: "user", content: "U" }]);
  assert.match(direct.body.system, /^S/);
  assert.equal("thinking" in direct.body, false, "thinking is left at the model's adaptive default");
  const proxied = buildChatRequest(config, { system: "S", user: "U", maxTokens: 500, browser: false });
  assert.equal("anthropic-dangerous-direct-browser-access" in proxied.headers, false);
});

test("OpenAI-compatible providers share the chat/completions shape with provider-specific fields", () => {
  const openai = buildChatRequest({ provider: "openai", apiKey: "sk-o" }, { system: "S", user: "U", maxTokens: 300 });
  assert.equal(openai.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(openai.headers.Authorization, "Bearer sk-o");
  assert.equal(openai.body.max_completion_tokens, 300);
  assert.deepEqual(openai.body.response_format, { type: "json_object" });
  assert.equal("thinking" in openai.body, false);
  const kimi = buildChatRequest({ provider: "kimi", apiKey: "sk-k" }, { system: "S", user: "U", maxTokens: 300 });
  assert.equal(kimi.url, "https://api.moonshot.ai/v1/chat/completions");
  assert.equal(kimi.body.max_tokens, 300);
  const deepseek = buildChatRequest({ provider: "deepseek", apiKey: "sk-d", reasoningEffort: "high" }, { system: "S", user: "U", maxTokens: 300 });
  assert.equal(deepseek.url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(deepseek.body.thinking, { type: "enabled" });
  assert.equal(deepseek.body.reasoning_effort, "high");
});

test("responses are parsed per provider style with readable errors", () => {
  const claude = { provider: "claude", apiKey: "k" };
  assert.equal(parseChatResponse(claude, { content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"ok":true}' }] }), '{"ok":true}');
  assert.throws(() => parseChatResponse(claude, { stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] }), /declined/i);
  assert.throws(() => parseChatResponse(claude, { error: { message: "invalid x-api-key" } }, 401), /rejected the API key/i);
  const gpt = { provider: "openai", apiKey: "k" };
  assert.equal(parseChatResponse(gpt, { choices: [{ message: { content: "{}" } }] }), "{}");
  assert.throws(() => parseChatResponse(gpt, { choices: [{ message: { content: "" } }] }), /empty response/i);
  assert.throws(() => parseChatResponse(gpt, {}, 500), /HTTP 500/);
});

test("extractJson tolerates code fences and surrounding prose", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here is the plan: {"status":"ready","actions":[]} Hope that helps.'), { status: "ready", actions: [] });
  assert.throws(() => extractJson("no json here"), /not valid JSON/);
});

test("normalizers whitelist model output identically for the browser and the server", () => {
  const plan = normalizeVoicePlan({ status: "bogus", actions: [{ type: "transfer_cash", fields: { fromId: "P1", toId: "P2", amount: "20", secret: 1 } }, { type: "delete_everything" }] });
  assert.equal(plan.status, "ready");
  assert.equal(plan.actions.length, 1);
  assert.deepEqual(plan.actions[0].fields, { fromId: "P1", toId: "P2", amount: 20, memo: "" });
  assert.deepEqual(normalizeCondition({ condition: "Wait one more round.", mechanic: "extra_settlement_round", value: "1" }), { condition: "Wait one more round.", mechanic: "extra_settlement_round", value: 1 });
  assert.equal(normalizeCondition({ condition: "x", mechanic: "seize_assets" }).mechanic, "none");
  assert.throws(() => normalizeCondition({}), /usable approval condition/);
  assert.equal(normalizeJudgement({ verdict: "breach", confidence: 2 }).confidence, 1);
});
