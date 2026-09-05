import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { readdir } from "node:fs/promises";

const index = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const jsDir = new URL("../public/js/", import.meta.url);
const uiDir = new URL("../public/js/ui/", import.meta.url);
const moduleFiles = [
  new URL("../public/app.js", import.meta.url),
  new URL("../public/ai-providers.js", import.meta.url),
  new URL("../public/ai-prompts.js", import.meta.url),
  ...(await readdir(jsDir)).filter(name => name.endsWith(".js")).map(name => new URL(name, jsDir)),
  ...(await readdir(uiDir)).filter(name => name.endsWith(".js")).map(name => new URL(name, uiDir))
];
// The client is split into modules; structural checks run over all of them together.
const app = (await Promise.all(moduleFiles.map(file => readFile(file, "utf8")))).join("\n");

test("primary navigation is streamlined to seven destinations", () => {
  const primaryNav = index.match(/<nav class="bottom-nav"[\s\S]*?<\/nav>/)?.[0] || "";
  assert.equal((primaryNav.match(/data-tab=/g) || []).length, 7);
  assert.match(primaryNav, /data-tab="legal"/);
  assert.doesNotMatch(primaryNav, /data-tab="contracts"/);
  assert.doesNotMatch(primaryNav, /data-tab="judge"/);
  assert.doesNotMatch(primaryNav, /data-tab="voice"/);
});

test("home exposes passed GO and a four-player net-worth board", () => {
  assert.match(app, /data-action="pass-go"/);
  assert.match(app, /class="net-worth-board"/);
  assert.match(app, /state\.players/);
  assert.match(app, /playerNetWorthBreakdown/);
});

test("contract documentation and legal review share one workspace", () => {
  assert.match(app, /function renderLegal\(/);
  assert.match(app, /id="contractForm"/);
  assert.match(app, /id="disputeForm"/);
  assert.match(app, /data-review-contract/);
});

test("player-to-player property transfers are not duplicated as an immediate action", () => {
  assert.doesNotMatch(app, /id="propertyTransferForm"/);
  assert.match(app, /id="dealForm"/);
});

test("settings page offers all four AI providers and keeps keys out of the game state", () => {
  assert.match(app, /function renderSettings\(/);
  for (const provider of ["claude", "openai", "kimi", "deepseek"]) assert.match(app, new RegExp(`${provider}:`));
  assert.match(app, /AI_SETTINGS_KEY = "boardroom-chaos-ai-settings-v1"/);
  assert.doesNotMatch(app, /state\.settings\.apiKey/);
  assert.match(index, /id="settingsBtn"/);
});

test("the client is organised into store, ai, recorder, and per-page ui modules", async () => {
  const uiFiles = (await readdir(uiDir)).filter(name => name.endsWith(".js"));
  for (const expected of ["dashboard.js", "actions.js", "market.js", "deals.js", "legal.js", "assets.js", "ledger.js", "rules.js", "voice.js", "settings.js", "shared.js"]) assert.ok(uiFiles.includes(expected), `missing ui/${expected}`);
  const jsFiles = (await readdir(jsDir)).filter(name => name.endsWith(".js"));
  for (const expected of ["store.js", "ai.js", "recorder.js", "helpers.js"]) assert.ok(jsFiles.includes(expected), `missing js/${expected}`);
});
