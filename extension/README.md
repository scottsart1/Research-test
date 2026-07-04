# Job Application Autofill — Chrome Extension

Manifest V3 extension that autofills job application forms for one candidate
profile (Emily Terry) from a locked, local answer bank. It never submits a
form — a human always reviews the panel and clicks submit.

Built from the handoff spec in this branch's task description (v2). See that
spec for the full architecture rationale; this file covers how to load,
configure, and test what was built.

## Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` directory.
4. Open the extension's **Options** page (right-click the toolbar icon →
   Options, or click "Options" in the popup) and:
   - Select Emily's **work-authorization preset** (F-1 OPT / Permanent
     Resident / US Citizen). This drives every work-authorization answer.
   - Check the **Resume** section — `Resume_Emily_Terry.pdf` is bundled and
     auto-loaded on install, so file-upload fields are already covered. Use
     "Upload a different resume" there if the resume changes.
   - Review any remaining `«placeholder»` values (EEO choices are the main
     ones left — see `data/default-answer-bank.json`). Everything else
     (address, salary, YoE for niche skills, etc.) already has a real value.
   - Optionally enable the Claude API fallback and paste an Anthropic API
     key (only used for question→key *mapping*, never for generating
     answers, and never for work-authorization questions).

## Use it

- Open a job application page, click the extension icon, then **Fill this
  page** — or press **Alt+Shift+F**.
- A review panel slides in on the right showing every filled/skipped field.
  Work-authorization fields always show a 🔒 lock icon, regardless of
  confidence. ⚠️/⛔ items are pinned to the top.
- The extension **never** submits the form. Review the panel, attach the
  resume if needed, and click submit yourself.

## Run the test suite

```
node test/run-tests.js
```

This is a dependency-free Node runner covering the Phase 2 required tests
from the spec (§10): all 24 work-authorization preset × pattern
combinations, the "without sponsorship" wording variants, free-text
work-authorization rejection, status-dropdown "never fall back to Other",
per-skill years-of-experience matching (including the "unknown skill →
NEEDS_REVIEW" rule and the range-bucket boundary rule), the
React-controlled-input `setNativeValue` technique, and the EEO
exact-string/decline-synonym matching — plus a CI-style grep asserting no
code path ever calls a form-submission method or clicks a submit control.

It exercises the pure decision-logic modules directly (`lib/*.js`,
`data/match-rules.js`, `content/matcher.js`), none of which touch the DOM.

For a manual, in-browser check of the DOM-writing side (detector + filler +
review panel), open `test/form.html` in Chrome with the extension loaded and
click "Fill this page". It covers every `FieldDescriptor` input type from
spec §3 (text, textarea, select, radio group, checkbox, checkbox group,
date, file, contenteditable, and a type-ahead combobox) plus a sample of the
§5 question corpus, including the work-authorization patterns, clearance/
federal questions, EEO fields, and the always-NEEDS_REVIEW cases (stock
"why this company" answers, unknown-skill YoE, public trust/suitability).
`test/test-cases.json` documents the expected outcome for each field in that
form.

## What's implemented vs. stubbed

- **Phases 1–3 (spec §10)**: fully implemented — detector, matcher (Tiers
  1–3), filler (including the native-setter/React technique, typeahead,
  date formats, radio/checkbox groups, verification pass), work-auth preset
  engine, options page, review panel, and adapters for every ATS listed in
  §7 (Workday, Greenhouse, iCIMS, Taleo/Oracle Recruiting, Lever, Ashby,
  SmartRecruiters, plus the thin Tier 3 hint-adapters and the generic
  fallback).
- **Phase 4**: Claude Haiku Tier-4 fallback is wired end-to-end
  (background/service-worker.js batches unmatched fields, enforces the
  work-authorization exclusion independently as defense in depth, and never
  lets the API return a value — only a key, which is then run back through
  the same option-matching/placeholder-guard pipeline as local tiers).
  Keyboard shortcut, snapshot/restore ("Clear all fills"), and the Tier 3
  hint-adapters are implemented. The resume-attachment `DataTransfer`
  injection (spec §6's Phase 4 "stretch" item) is implemented too, now that
  a real resume is available: `assets/Resume_Emily_Terry.pdf` is bundled
  with the extension, seeded into `chrome.storage.local` as base64 on
  install (`lib/resume-utils.js` handles the byte<->base64 conversion,
  round-trip-tested against the actual PDF in `test/run-tests.js`), and
  `content/filler.js`'s `file` strategy reconstructs a `File` from it and
  injects it into the matched upload field via `DataTransfer`. A Tier 2 rule
  (`resume_upload` in `data/match-rules.js`) routes labels like "Resume",
  "CV", or "upload your resume" to this path. If no resume is stored (or the
  page's upload field isn't recognized), it still falls back to flagging
  "attach manually" rather than guessing.
- Live-ATS end-to-end verification (spec §10 Phase 3 acceptance criterion:
  "one live posting per ATS with zero incorrect fills") requires a live
  browser session against real postings and hasn't been run here — the
  adapters are built to the documented DOM quirks (Workday's automation-id
  scheme and split date spinbuttons, iCIMS's iframe nesting, Taleo's
  generated-id avoidance, etc.) but should be spot-checked against a live
  posting per ATS before relying on them for a real application.

## File map

See the spec's §2 architecture diagram — this repo matches it exactly,
plus `test/` for the items described above.
