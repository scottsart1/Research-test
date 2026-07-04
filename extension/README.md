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
   - Optionally enable **Claude AI answering** and paste an Anthropic API
     key. When on, every question local matching can't confidently answer
     is sent to Claude to understand what it's really asking; Claude can
     map it to an existing answer, pick the correct dropdown option, or —
     with the drafting toggle on — write a first-person answer to
     qualitative questions ("Why this role?", "Reason for leaving")
     grounded in Emily's profile and the job posting. Pick Haiku 4.5
     (fast/cheap) or Sonnet 5 (better drafting). AI never touches work
     authorization, EEO demographics, salary figures, clearance, criminal
     history, or logins/passwords, and every AI-drafted answer is pinned
     in the review panel with a 🤖 marker for reading before submit.

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
- **Phase 4 / AI answering** (extended beyond the original spec at the
  owner's direction): background/service-worker.js batches every field the
  local tiers left UNMATCHED or NEEDS_REVIEW (minus locked attestations)
  into one Claude call with the job page's title/excerpt and a whitelisted
  candidate profile. The model returns one action per field — `map` to a
  bank key, `option` (validated locally against the field's real options),
  `draft` (free-text only, forbidden-category-filtered, length-capped,
  flagged 🤖 in the panel), or `skip`. The work-authorization exclusion is
  enforced independently in the worker and again in the content-side
  resolver as defense in depth.
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
- **Cross-frame panel merging**: iframe-heavy ATSs (iCIMS, legacy Taleo,
  SuccessFactors) run the content script in every frame, but only the top
  frame renders the review panel. Child frames fill their own documents and
  relay serialized results through the background worker to the top-frame
  panel; click-to-scroll and "Clear all fills" route back down the same
  way. (This fixed a live iCIMS run where two overlapping panels appeared
  and the visible one read 0/0/0.)
- **Repeatable history blocks**: work-experience and education sections are
  filled per block — match rules emit index-0 keys and
  `Matcher.applyRepeatableBlockIndexing` re-points the Nth occurrence of
  the same field (second "Employer", second "School", …) at
  `experience[N]`/`education[N]`. A block with no bank entry goes to
  NEEDS_REVIEW rather than duplicating block 0 (spec §11#4). Context-gated
  rules distinguish "City" inside an experience block from the home-address
  "City", and experience/education start/end dates from the
  "when can you start?" availability question.
- **Credentials are off-limits**: `type=password` inputs are excluded at
  the detector level, and Login/Username/Password labels are always flagged
  NEEDS_REVIEW — account creation belongs to the human.
- **Ad-hoc questions**: common screening one-offs (may-we-contact-employer,
  willing to travel, employment type, languages, did-you-graduate) have
  dedicated rules; anything not covered locally can be key-mapped by the
  optional Claude Tier-4 fallback, and whatever remains lands in the panel
  as NEEDS_REVIEW with a "Copy skipped questions" button. Free-form essay
  prompts ("Why this company?") are deliberately never auto-answered.
- Live-ATS end-to-end verification (spec §10 Phase 3 acceptance criterion:
  "one live posting per ATS with zero incorrect fills") should be repeated
  after any rule change — the iCIMS defects above were only caught by a
  live run.

## File map

See the spec's §2 architecture diagram — this repo matches it exactly,
plus `test/` for the items described above.
