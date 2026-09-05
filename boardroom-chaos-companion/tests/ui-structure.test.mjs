import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const index = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

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
