import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(__dirname, "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(url, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

test("voice interpretation endpoint returns a normalized conservative action plan", { timeout: 12_000 }, async t => {
  const mockPort = await freePort();
  const appPort = await freePort();

  const mock = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const content = JSON.stringify({
      status: "ready",
      summary: "Alex pays Sam twenty dollars",
      confidence: 0.94,
      actions: [
        {
          type: "transfer_cash",
          description: "Alex pays Sam $20",
          confidence: 0.96,
          requires_confirmation: true,
          fields: { fromId: "P1", toId: "P2", amount: 20, memo: "Voice test", ignored: "drop me" },
          ambiguities: [],
          source_quote: "Alex pays Sam twenty dollars"
        },
        { type: "invent_rule", description: "This must be dropped", confidence: 1, fields: {} }
      ],
      unresolved: [],
      suggested_clarification: ""
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve, reject) => mock.listen(mockPort, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise(resolve => mock.close(resolve)));

  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectDir,
    env: {
      ...process.env,
      PORT: String(appPort),
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}`,
      DEEPSEEK_MODEL: "deepseek-v4-pro",
      DEEPSEEK_REASONING_EFFORT: "high"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(() => { if (!child.killed) child.kill("SIGTERM"); });

  await waitFor(`http://127.0.0.1:${appPort}/api/health`);
  const response = await fetch(`http://127.0.0.1:${appPort}/api/voice/interpret`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript: "Alex pays Sam twenty dollars",
      context: {
        game: { id: "g1", round: 1, activePlayerId: "P1" },
        players: [{ id: "P1", name: "Alex" }, { id: "P2", name: "Sam" }],
        properties: []
      }
    })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, stderr);
  assert.equal(payload.model, "deepseek-v4-pro");
  assert.equal(payload.plan.status, "ready");
  assert.equal(payload.plan.actions.length, 1);
  assert.deepEqual(payload.plan.actions[0].fields, { fromId: "P1", toId: "P2", amount: 20, memo: "Voice test" });
  assert.equal(payload.plan.actions[0].requiresConfirmation, true);
});


test("approval condition endpoint returns one whitelisted structured condition", { timeout: 12_000 }, async t => {
  const mockPort = await freePort();
  const appPort = await freePort();
  const mock = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const content = JSON.stringify({ condition: "Require more than 60% of record-date shares to vote YES.", mechanic: "supermajority_vote", value: 60 });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve, reject) => mock.listen(mockPort, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise(resolve => mock.close(resolve)));

  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(appPort), DEEPSEEK_API_KEY: "test-key", DEEPSEEK_BASE_URL: `http://127.0.0.1:${mockPort}`, DEEPSEEK_MODEL: "deepseek-v4-pro", DEEPSEEK_REASONING_EFFORT: "high" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(() => { if (!child.killed) child.kill("SIGTERM"); });
  await waitFor(`http://127.0.0.1:${appPort}/api/health`);

  const response = await fetch(`http://127.0.0.1:${appPort}/api/approval-condition`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "deal", record: { title: "Test filing" }, context: { round: 2 } })
  });
  const payload = await response.json();
  assert.equal(response.status, 200, stderr);
  assert.equal(payload.mechanic, "supermajority_vote");
  assert.equal(payload.value, 60);
  assert.match(payload.condition, /60%/);
});


test("OpenAI transcription endpoint forwards audio and returns text", { timeout: 12_000 }, async t => {
  const mockPort = await freePort();
  const appPort = await freePort();
  let sawMultipart = false;
  const mock = http.createServer(async (req, res) => {
    sawMultipart = String(req.headers["content-type"] || "").startsWith("multipart/form-data;");
    let bytes = 0;
    for await (const chunk of req) bytes += chunk.length;
    assert.ok(bytes > 20);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "Alex pays Sam twenty dollars." }));
  });
  await new Promise((resolve, reject) => mock.listen(mockPort, "127.0.0.1", resolve).once("error", reject));
  t.after(() => new Promise(resolve => mock.close(resolve)));

  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(appPort), OPENAI_API_KEY: "test-openai-key", OPENAI_BASE_URL: `http://127.0.0.1:${mockPort}`, OPENAI_TRANSCRIPTION_MODEL: "gpt-4o-transcribe" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(() => { if (!child.killed) child.kill("SIGTERM"); });
  await waitFor(`http://127.0.0.1:${appPort}/api/health`);

  const response = await fetch(`http://127.0.0.1:${appPort}/api/voice/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm", "X-Transcription-Language": "en" },
    body: Buffer.from("fake-webm-audio-payload")
  });
  const payload = await response.json();
  assert.equal(response.status, 200, stderr);
  assert.equal(sawMultipart, true);
  assert.equal(payload.transcript, "Alex pays Sam twenty dollars.");
  assert.equal(payload.model, "gpt-4o-transcribe");
});


async function startServer(t, env) {
  const appPort = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectDir,
    env: { ...process.env, PORT: String(appPort), ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  t.after(() => { if (!child.killed) child.kill("SIGTERM"); });
  await waitFor(`http://127.0.0.1:${appPort}/api/health`);
  return { base: `http://127.0.0.1:${appPort}`, stderr: () => stderr };
}

test("server routes exactly, maps client mistakes to 4xx, and keeps static files inside public/", { timeout: 15_000 }, async t => {
  const { base } = await startServer(t, { DEEPSEEK_API_KEY: "test-key", DEEPSEEK_BASE_URL: "http://127.0.0.1:9" });

  const unknown = await fetch(`${base}/api/does-not-exist`);
  assert.equal(unknown.status, 404);
  assert.match(String((await unknown.headers.get("content-type"))), /application\/json/);

  const wrongMethod = await fetch(`${base}/api/judge`);
  assert.equal(wrongMethod.status, 405);

  const prefixed = await fetch(`${base}/api/healthcheck`);
  assert.equal(prefixed.status, 404, "prefix matches are not routes");

  const badJson = await fetch(`${base}/api/judge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
  assert.equal(badJson.status, 400);
  assert.match((await badJson.json()).error, /valid JSON/i);

  const tooLarge = await fetch(`${base}/api/voice/interpret`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ transcript: "x".repeat(1_100_000) }) });
  assert.equal(tooLarge.status, 413);

  const upstreamDown = await fetch(`${base}/api/approval-condition`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "deal", record: { title: "x" } }) });
  assert.equal(upstreamDown.status, 500, "an unreachable AI provider is reported as a server-side failure, not a client error");

  const traversal = await fetch(`${base}/..%2F..%2Fserver.js`);
  assert.equal(traversal.status, 404);
  assert.doesNotMatch(await traversal.text(), /createServer/);

  const malformedPath = await fetch(`${base}/%zz`);
  assert.equal(malformedPath.status, 400);

  const asset = await fetch(`${base}/engine.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /text\/javascript/);

  const spa = await fetch(`${base}/legal`);
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /<title>Boardroom Chaos Companion<\/title>/);

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.deepseekConfigured, true);
  assert.equal(health.transcription.configured, false);
});
