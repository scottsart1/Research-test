# Boardroom Chaos Companion v1.5.0 — Verification Report

Date: September 5, 2026

## Automated result (v1.5.0)

```text
npm run check
npm test
```

- Syntax checks passed for the server and every client module (`public/*.js`, `public/js/*.js`, `public/js/ui/*.js`).
- **58 tests passed** (48 from v1.4.1 plus 10 new).
- 0 failed, skipped, cancelled, or marked todo.

## New v1.5.0 coverage

- Provider configs normalize to per-provider defaults; unknown providers are rejected.
- Claude requests use the Messages API with the browser opt-in header only in direct mode; OpenAI, Kimi, and DeepSeek share the chat-completions shape with provider-specific token and reasoning fields.
- Responses are parsed per provider with readable key, refusal, and empty-response errors; JSON is extracted through code fences and prose.
- Voice-plan, condition, and judgement normalizers whitelist model output identically for browser and server.
- A key entered in the app is proxied to Claude by the server; the server's environment key remains the fallback; `/api/health` reports the active provider and all four options.
- With no key anywhere, AI endpoints return 503 with instructions pointing to Settings.
- The client is organised into `store`, `ai`, `recorder`, `helpers`, and per-page `ui` modules; the Settings page names all four providers and keeps keys out of game state.

## Browser render check

Playwright (Chromium) rendered every tab, every Market and Settings section, the Voice and Legal pages before and after saving a provider key, and the Game dialog at 1280×860 and 390×844 with **no page errors or console errors**.

## Android build check

`npx cap sync android && ./gradlew assembleDebug` succeeded on Linux with JDK 21 and Android SDK 35, producing `mobile/releases/boardroom-chaos-companion-v1.5.0-debug.apk`. The APK was not run on a physical device in this environment.

## Not verified here

- Live calls to Claude, OpenAI, Kimi, or DeepSeek with real keys (all provider tests use local mock endpoints).
- Whether each provider's public API permits direct browser (CORS) calls; the desktop server route and the Android app are unaffected by CORS.
- Physical microphone permission prompts on Android or iOS.

## GitHub Actions run on the pushed commit

Workflow run 33981565385 on commit d44a70b: **Web app checks and tests** passed, **Android APK** built and uploaded (artifact `boardroom-chaos-companion-android-apk`), and the **iOS unsigned archive** succeeded on the macOS runner with Xcode 26.6 and uploaded `boardroom-chaos-companion-ios-unsigned-ipa`. Neither package was installed on a physical device.

## Previous report (v1.4.1)

Date: September 5, 2026

## Automated result (v1.4.1)

```text
npm run check
npm test
```

- JavaScript syntax checks passed for the server, app, voice client, and game engine.
- **48 tests passed** (38 retained from v1.4 plus 10 new regression tests).
- 0 failed, skipped, cancelled, or marked todo.

## New v1.4.1 coverage

- Malformed, truncated, and legacy game files import with readable errors or clean migration.
- `validateState` leaves a valid state untouched.
- Undo snapshots are shared by reference and are never mutated by a later undo.
- Deals cannot be filed with unowned property shares; no legal fee is charged on a rejected filing.
- Rejected and executed deals refuse signatures, votes, and condition changes; deal votes wait for approval.
- Redefining an approval condition cancels consent, votes, and the settlement clock.
- A merger executed on the target's turn hands play to the next company and cancels the target's pending policies.
- Contracts and disputes must reference real players and existing contracts.
- The server returns 404 for unknown API routes, 405 for wrong methods, 400 for malformed JSON or paths, 413 for oversized bodies, serves static assets, falls back to the app shell for client routes, and does not serve files outside `public/`.

## Previous report (v1.4)

Date: July 31, 2026

## Automated result

```text
npm.cmd run check
npm.cmd test
```

- JavaScript syntax checks passed for the server, app, voice client, and game engine.
- **38 tests passed.**
- 0 failed, skipped, cancelled, or marked todo.

## New v1.4 coverage

- Passed GO transfers exactly $200 from the bank to the selected active company and records the event.
- A net-worth breakdown is produced for all four player records.
- Net worth includes cash, property equity, outside-company stock investments, enforceable receivables, and every active or delinquent debt.
- Net-worth components and totals remain whole Monopoly dollars.
- The primary navigation contains seven destinations rather than ten.
- Contracts and legal review share one Legal workspace.
- The Home screen contains Passed GO and the four-player net-worth board.
- Immediate player-to-player property transfer is absent from Actions; Deals remains the formal route.

## Regression coverage retained

- Exactly four player-companies.
- Atomic cash and property operations.
- Conventional rent, building, mortgage, and title restrictions.
- Whole-dollar settlement and exact remainder allocation.
- Dynamic bank rate direction, random spread limits, loan terms, delinquency, repayment, and emergency liquidity.
- Legal fees, 10/40/50 approval, conditions, signatures, votes, and two-round settlement.
- Stock issuance, dilution, voting, dividends, and random price movement.
- Policies, Tax Day, Free Parking, mergers, and antitrust.
- Local rule judgement, DeepSeek response normalization, and table overrides.
- OpenAI multipart audio transcription forwarding.
- Voice-note auditing, undo, export, and import.

## Server smoke test

The local Node server was started and checked with HTTP requests. The application shell, JavaScript modules, stylesheet, rulebook, manifest, service worker, and `/api/health` endpoint loaded successfully. Missing OpenAI or DeepSeek credentials continue to return provider-specific status rather than a generic recognition error.

## Hardware-dependent flags still open

- Samsung tablet access through the laptop’s local IP address has not been proven reliable.
- Samsung microphone permission has not been physically tested in this environment.
- Live OpenAI and DeepSeek calls were not made with the user’s private production keys.
- The interface was structurally and server-tested, but this environment’s Chromium administrator policy blocked local page navigation, so no claim of physical tablet rendering is made.
