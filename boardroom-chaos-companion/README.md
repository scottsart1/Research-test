# Boardroom Chaos Companion v1.5

A local-first companion for a **four-player conventional Monopoly game** with quick game-day controls, four listed player-companies, random stock prices, capital raises, voting shares, rent dividends, formal approvals, two-round settlement, mergers, taxes, Free Parking, antitrust, dynamic bank credit, voice commands, and an auditable AI clerk and judge powered by **your own Claude, GPT, Kimi, or DeepSeek key**.

The app runs as a website on one shared laptop, as an installable web app, and as an Android app (with an iOS project for Mac builds). See `mobile/README.md` for the phone and tablet builds.

## What changed in v1.5

### Bring your own AI provider, in the app

- A new **Settings** page (gear icon in the top bar, or Game → Settings) lets a player pick **Claude (Anthropic), GPT (OpenAI), Kimi (Moonshot AI), or DeepSeek**, paste the API key, choose a model, and press **Test connection**.
- Keys are stored only on that device (`localStorage`, or session-only if "Remember keys" is unchecked). They are never written into exported game files, and "Forget keys" wipes them.
- Requests are routed automatically: through the local Node server when it is reachable (the laptop setup), or **directly from the device to the provider** in the installed app or on any static host. The routing can be forced either way in Settings → Game.
- The server still honours environment variables as a fallback for tables that prefer not to type keys: generic `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`, `AI_BASE_URL`, `AI_REASONING_EFFORT`, plus the older `DEEPSEEK_*` names. A key entered in the app takes precedence.
- Prompts, JSON normalizers, and per-provider request shapes live in two shared modules (`public/ai-prompts.js`, `public/ai-providers.js`) used by both the browser and the server, so every path produces the same whitelisted results.
- Voice transcription can use OpenAI (with a key) or the browser's **built-in speech recognition** (Chrome, including Android) with no key at all. Mode is chosen in Settings → Voice.

### Reorganized, cleaner interface

- The client is split into modules under `public/js/`: `store.js` (state, persistence, current view), `ai.js` (provider client), `recorder.js` (microphone and speech recognition), `helpers.js`, and one file per page under `ui/`. `app.js` only wires events.
- The long Market page is now sectioned: **Exchange · Bank · File · Governance**, remembered per session.
- Settings has its own sections: **AI provider · Voice · Game · Data & about**. The Game dialog is reduced to export, import, settings, rules, and new game.
- The Voice page shows the three-stage pipeline (transcribe → interpret → confirm) with live status for each stage, and the Legal page shows which provider will rule. Both link to Settings when nothing is configured.
- Phone layout: icon-only top bar, styled party checkboxes, and pill-shaped section tabs that scroll horizontally.

### Android and iOS

- `mobile/` wraps the web app with Capacitor. A debug APK built from this source is in `mobile/releases/`, and `.github/workflows/boardroom-mobile.yml` rebuilds it on every push and attaches it to a GitHub Release on `bcc-v*` tags.
- The iOS project is generated as well; building and installing it needs a Mac or the macOS CI job plus an Apple ID or developer account. Details and the "Add to Home Screen" alternative are in `mobile/README.md`.

## What changed in v1.4.1

Correctness and code-organization fixes found in review. Behaviour visible at the table:

- Filing a deal now checks that each party actually owns the promised property share, shares, or jail card. A bad filing fails before the $25 legal fee is charged instead of failing at settlement two rounds later.
- A rejected or executed deal can no longer be signed, voted on, or given a new condition. Deal votes also wait for regulatory approval, matching policies and mergers.
- Defining a new approval condition is treated as a material change (R-03): earlier signatures, consents, votes, and the settlement clock are cancelled for deals, policies, and mergers.
- When a merger settles during the target's own turn, play now moves to the next active company, and the target's pending policies are cancelled.
- Contracts and disputes must reference real players and existing contracts.
- Importing a corrupt or truncated game file reports a readable error instead of a JavaScript TypeError, and older saves missing deal fields migrate cleanly.

Internal fixes:

- `validateState` is now a pure check. Migration runs only on import, not on every ledger commit.
- The undo stack shares immutable snapshots instead of deep-cloning all thirty of them on every action, and undo clones the snapshot it restores.
- Duplicated ticker, market, and bank builders in the engine were merged into single helpers.
- The server routes on exact paths, returns 404 for unknown `/api/` routes, 405 for wrong methods, 400 for malformed JSON or paths, 413 for oversized bodies, and 502/504 for provider failures. The three DeepSeek calls share one client. Static files are confined to `public/` even for sibling directories that share the prefix.
- The service worker only caches successful same-origin responses and uses a new cache name.
- Dialogs are no longer reopened while already open, and the voice module's recorder constant is named for what it is.

## What changed in v1.4

- Rebuilt the opening screen around the actions used during ordinary play.
- Added one-tap **Passed GO** for the current player, with a $200 bank payment and ledger record.
- Added quick access to rent, bank property purchases, From → To payments, Free Parking, voice, and end turn.
- Added a dedicated net-worth standings board that always displays all four players.
- Added an expandable breakdown of cash, property equity, outside stock investments, receivables, and debt.
- Fixed net worth so delinquent loans remain liabilities and receivables until resolved.
- Combined contract documentation, linked legal review, disputes, rulings, and table overrides into one **Legal** workspace.
- Reduced primary navigation from ten destinations to seven. Voice remains in the top bar; Rules moved into the Game menu.
- Removed immediate player-to-player property transfers from Actions. Those transfers now belong in Deals and follow legal fees, approval, and two-round settlement.

## Economic and AI systems retained from v1.3

## Dynamic bank lending

The bank begins with the cash remaining after the four $1,500 starting allocations. The app tracks that cash as a finite balance.

The displayed lending quote combines:

1. A liquidity base rate, which rises as bank cash falls.
2. A random spread that changes once per completed round.

Default parameters:

- Opening base rate: 8%
- Minimum quoted rate: 5%
- Maximum quoted rate: 30%
- Random spread: bounded to approximately ±3 percentage points
- Minimum loan: $50
- Maximum loan: $500, also limited by available bank liquidity
- Term: three rounds
- One active or delinquent bank loan per company
- Interest: flat, calculated once and rounded to the nearest whole dollar

The quoted rate is locked when the loan is issued. Bank loans are ordinary financing actions, so they do not pay a legal fee, enter the 10/40/50 approval process, or wait two rounds.

A loan remains active through its due round. It becomes delinquent only after that round has fully passed. The app currently records delinquency but does not automatically seize property; players may resolve default through a contract, bankruptcy process, or rule judgement.

### Emergency liquidity

If the bank owes a required payment that exceeds its available cash, the payment is still honored. The shortfall is recorded as emergency liquidity.

While emergency liquidity is outstanding:

- Bank cash is treated as unavailable for new loans.
- New bank lending is suspended.
- The lending quote remains at 30%.
- Future bank receipts repay emergency liquidity before rebuilding ordinary bank cash.

This prevents required Monopoly actions from failing merely because the finite bank ran out of physical cash.

## Whole-dollar money rule

Every amount in the game uses whole Monopoly dollars:

- Cash balances
- Stock prices and trade totals
- Legal and merger fees
- Taxes
- Loan principal, interest, and repayment
- Rent and dividends
- Building and mortgage allocations
- Merger settlements
- Free Parking

Inputs with decimals are rounded to the nearest dollar. Percentage ownership and voting percentages may retain decimals, but the money they generate does not.

When a shared payment does not divide evenly, the engine uses a largest-remainder allocation. The rounded pieces always add back to the exact rounded total.

## Four player-companies and stock market

- A new game requires exactly four players.
- Each player starts with $1,500 and controls one listed company.
- Each stock begins at $10 with 100 founder-owned voting shares and 150 authorized shares.
- Every active stock moves once after each completed four-player round.
- Price movement is random, bounded, and receives no news story or performance explanation.
- A filed trade locks its price while approval and the two-round settlement remain pending.
- New share issuance raises company cash and dilutes existing voting ownership.
- Each share carries one vote using a frozen record-date snapshot.
- Twenty percent of rent becomes shareholder dividends; eighty percent remains with the company.

Stock ownership is an economic and voting interest in a company. It does not place the shareholder directly on individual property deeds.

## Formal filings and settlement

Every formal deal, stock offering, stock trade, corporate policy, standalone contract, or merger pays a flat $25 legal fee. A merger also pays a $200 merger fee. These fees are nonrefundable and enter the Free Parking jackpot.

Formal approvals use one electronic result:

- 10% approved as written
- 40% approved with one DeepSeek-defined, mechanically limited condition
- 50% rejected

There are no dice, rerolls, lobbying tokens, fairness scores, or invented reasons for the random result.

After final approval, accepted conditions, signatures, and required shareholder votes, the filing waits **two complete rounds** before execution. Ordinary Monopoly actions—rent, property purchases, mortgages, construction, taxes, Free Parking, and bank loans—remain immediate.

## Mergers, taxes, Free Parking, and antitrust

Mergers are enabled. Both companies consent and vote separately; the acquirer pays the legal and merger fees. The locked exchange ratio converts target shares after the two-round settlement, the target is delisted, and its separate turn disappears. A completed merger triggers antitrust review.

Tax Day occurs every fifth round. Property Tax and Net-Worth Income Tax enter Free Parking, as do legal fees, merger fees, and designated antitrust fines. Landing directly on Free Parking collects the complete jackpot.

A company gets at most one antitrust review after a merger, all four railroads, or three complete color groups. The written outcomes are cleared, fine, half rent, construction freeze, or forced auction.

## Voice architecture

The voice pipeline separates recognition from reasoning:

1. The browser records audio, selects an audio file, or listens with its built-in speech recognition.
2. Recorded audio goes to OpenAI for transcription (through the local server, or directly from the device in the app).
3. The transcript is shown to the players.
4. The chosen reasoning provider (Claude, GPT, Kimi, or DeepSeek) interprets game intent and drafts contracts, conditions, or rulings.
5. The deterministic engine validates the proposed action.
6. Players visually confirm consequential changes.

Only OpenAI ever receives audio. The reasoning provider receives the transcript and compact game context, not the raw audio.

### Keys: in the app or on the server

The simplest setup is to open **Settings → AI provider** in the app and paste a key. Nothing else is required.

Optionally, the local server can hold keys in environment variables so every browser on the table shares them:

```text
AI_PROVIDER=claude            # claude | openai | kimi | deepseek
AI_API_KEY=your-real-key
AI_MODEL=claude-opus-5        # optional, provider default when blank
OPENAI_API_KEY=your-openai-key            # optional, enables audio transcription
OPENAI_TRANSCRIPTION_MODEL=gpt-4o-transcribe
```

The v1.3/v1.4 variables `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, and `DEEPSEEK_REASONING_EFFORT` still work when `AI_API_KEY` is not set.

Restart PowerShell and the server after changing Windows environment variables. Check configuration at:

```text
http://localhost:4173/api/health
```

`ai.configured: true` means the server has a reasoning key; `transcription.configured: true` means it has an OpenAI key for audio. Neither proves that a particular tablet browser granted microphone access; the Voice page shows the live status of each stage.

## Run on Windows

Node.js 20 or newer is required. In PowerShell:

```powershell
cd "C:\Users\Sarth\OneDrive\Documents\boardroom-chaos-companion"
npm.cmd start
```

Open:

```text
http://localhost:4173
```

No third-party npm packages are required, so `npm install` is unnecessary. Use `npm.cmd` when PowerShell blocks the `npm.ps1` wrapper.

## Samsung tablet flag

The earlier local-IP connection and browser speech recognition did not work reliably. v1.3 replaces browser speech recognition with audio recording plus OpenAI transcription, but live microphone access can still be blocked when the tablet opens an ordinary HTTP local-IP address.

The Voice page therefore also includes a native **Record or upload audio** control. Depending on Samsung Chrome and network settings, reliable tablet operation may still require HTTPS deployment, Windows Firewall changes, or packaging the app as Android software. This has not been physically hardware-tested in the development environment.

## Updating from v1.3 or earlier

1. Export the current game JSON from the old app.
2. Stop the server with `Ctrl+C`.
3. Replace the old project files with v1.4.
4. Run `npm.cmd start`.
5. Import the exported game if it is not retained automatically.

The importer migrates old saves to schema version 4 and rounds old decimal monetary values to whole dollars.

## Verification

Run:

```powershell
npm.cmd run check
npm.cmd test
```

The v1.5 suite contains **58 passing tests** covering:

- Exactly-four-player setup and all-four-player net-worth breakdowns
- Passed GO bank payment and ledger recording
- Seven-destination navigation and unified Legal workspace
- Atomic cash and property operations, with direct player property transfers restricted to Deals
- Whole-dollar settlement and legacy decimal migration
- Shared-cost and dividend rounding conservation
- Conventional building and mortgage restrictions
- Dynamic rate direction and bounded randomness
- Bank loan pricing, repayment, delinquency, and emergency liquidity
- Fixed 10/40/50 approval bands
- DeepSeek condition normalization
- Two-round settlement
- Stock issuance, dilution, voting, dividends, and random movement
- Policies, taxes, Free Parking, mergers, and antitrust
- Rule judgement and voice audit records
- OpenAI multipart audio transcription forwarding
- Export/import integrity
- Malformed and legacy import handling
- Immutable, shared undo snapshots
- Deal asset validation at filing and closed-deal guards
- Condition redefinition resetting consent and settlement
- Merger turn hand-off and policy cancellation
- Server routing, error statuses, body limits, and static-path containment
- Per-provider request shapes (Claude Messages API, OpenAI-compatible chat) and response parsing
- Device-entered keys proxied by the server, with server environment keys as the fallback
- Client module organisation and the Settings page

## Key files

- `public/engine.js` — deterministic game, market, bank, tax, merger, and antitrust engine
- `public/app.js` — entry point that wires DOM events to the engine and UI modules
- `public/js/store.js`, `public/js/ai.js`, `public/js/recorder.js`, `public/js/helpers.js` — state, AI client, microphone/speech, utilities
- `public/js/ui/*.js` — one module per page (dashboard, actions, market, deals, legal, assets, ledger, rules, voice, settings)
- `public/ai-providers.js`, `public/ai-prompts.js` — provider request builders, prompts, and normalizers shared with the server
- `public/rules.js` — canonical numbered rules
- `RULES.md` — readable house rulebook
- `server.js` — local server, static files, OpenAI transcription proxy, and multi-provider AI proxy
- `mobile/` — Capacitor wrapper, Android project, iOS project, prebuilt debug APK
- `tests/` — engine, provider, UI structure, and endpoint tests

## Private-use note

This is an unofficial personal companion with original branding. Monopoly and its property names belong to their respective rights holders.
