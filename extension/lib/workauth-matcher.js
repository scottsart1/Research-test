/**
 * workauth-matcher.js — Preset-driven work-authorization answer engine (spec §4.3).
 *
 * LOCKED DESIGN: work-auth answers are never taken from free-form bank values.
 * They are deterministically derived from a single `immigration_status` preset
 * ("f1_opt" | "permanent_resident" | "citizen") selected by the candidate on
 * the options page. This module owns:
 *   1. Pattern recognition for the eight §4.3 question shapes (with explicit
 *      negation / tense / compound handling).
 *   2. The preset -> answer lookup table.
 *   3. NEEDS_REVIEW fallback for anything ambiguous, multi-category, or free-text.
 *
 * Countermeasure citations (spec §11):
 *   - #1 wrong-dropdown: status dropdown never falls back to "Other" (rule 4 below).
 *   - #6 EEO/legal visibility: every result here is flagged `lockIcon: true` so
 *     review-panel.js always surfaces it, confident or not (builder rule 5).
 *
 * Exposed as self.WorkAuthMatcher (content-script) / module.exports (tests/node).
 */
(function (root) {
  'use strict';

  const PATTERNS = [
    // Compound forms MUST be checked before the single-category forms they
    // could otherwise be swallowed by (citizen-or-PR before bare citizen/PR).
    {
      key: 'citizen_or_pr',
      test: /citizen.{0,15}(or|\/).{0,15}(permanent resident|green card)/,
    },
    {
      key: 'without_sponsorship',
      test: /(authoriz|able|eligib).{0,40}work.{0,30}(in|within)?\s*(the\s*)?(u\.?s\.?|united states).{0,30}without.{0,20}sponsor/,
    },
    {
      key: 'without_sponsorship',
      // "authorized to work without sponsorship" (US omitted) or reordered
      test: /without.{0,20}sponsor.{0,60}(authoriz|eligib|able).{0,20}work/,
    },
    {
      // Order-independent: "now or in the future" can precede OR follow
      // "require sponsorship" in real phrasing ("Will you now or in the
      // future require sponsorship?" vs "Do you require sponsorship now or
      // in the future?"). Lookaheads make the future/require/sponsor tokens
      // match regardless of order, so this must be checked BEFORE the
      // present-tense-only rule below.
      key: 'sponsorship_future',
      test: /(?=.*sponsor)(?=.*(require|need|will you))(?=.*(future|later|at any time))/,
    },
    {
      key: 'sponsorship_now',
      // present-tense-only: "require sponsorship to work" / "need sponsorship now" with no future/later tense anywhere in the question.
      test: /(?=.*sponsor)(?=.*(require|need))(?!.*(future|later|at any time))/,
    },
    {
      key: 'permanent_resident',
      test: /(permanent resident|green card holder|lawful permanent resident|\bLPR\b)/,
    },
    {
      key: 'citizen',
      test: /(u\.?s\.?|united states)?\s*citizen/,
    },
    {
      key: 'legally_authorized',
      test: /(legally )?authoriz(ed|ation).{0,40}work.{0,30}(in|within)?\s*(the\s*)?(u\.?s\.?|united states)/,
    },
    {
      key: 'status_dropdown',
      test: /(work authorization status|visa status|immigration status|current (work )?status)/,
    },
  ];

  // Answers keyed by [pattern-key][preset] => "Yes" | "No" | dropdown label | null(=> not this pattern)
  const ANSWER_TABLE = {
    legally_authorized: { f1_opt: 'Yes', permanent_resident: 'Yes', citizen: 'Yes' },
    sponsorship_future: { f1_opt: 'Yes', permanent_resident: 'No', citizen: 'No' },
    sponsorship_now: { f1_opt: 'No', permanent_resident: 'No', citizen: 'No' },
    without_sponsorship: { f1_opt: 'No', permanent_resident: 'Yes', citizen: 'Yes' },
    citizen: { f1_opt: 'No', permanent_resident: 'No', citizen: 'Yes' },
    permanent_resident: { f1_opt: 'No', permanent_resident: 'Yes', citizen: 'No' },
    citizen_or_pr: { f1_opt: 'No', permanent_resident: 'Yes', citizen: 'Yes' },
    status_dropdown: {
      f1_opt: ['F-1 OPT', 'F-1', 'F1 OPT', 'F1', 'Student Visa (F-1)'],
      permanent_resident: ['Permanent Resident', 'Permanent Resident / Green Card', 'Green Card Holder', 'Lawful Permanent Resident'],
      citizen: ['US Citizen', 'U.S. Citizen', 'Citizen'],
    },
  };

  const VALID_PRESETS = ['f1_opt', 'permanent_resident', 'citizen'];

  function classify(labelText, contextText) {
    const hay = `${labelText || ''} ${contextText || ''}`.toLowerCase();

    // Reject free-text "work authorization" prompts with no recognizable
    // yes/no/dropdown shape (spec Phase 2 test 3) — e.g. a bare textbox
    // labeled "Work authorization" with no options and no yes/no phrasing.
    for (const p of PATTERNS) {
      if (p.test.test(hay)) return p.key;
    }
    return null;
  }

  /**
   * @param {object} field - { label_text, context_text, input_type, options }
   * @param {string} preset - 'f1_opt' | 'permanent_resident' | 'citizen' | ''
   * @returns {{ status: 'FILL'|'NEEDS_REVIEW', value?: any, patternKey?: string, lockIcon: true }}
   */
  function match(field, preset) {
    const result = { lockIcon: true };

    if (!VALID_PRESETS.includes(preset)) {
      return Object.assign(result, { status: 'NEEDS_REVIEW', reason: 'no_preset_selected' });
    }

    const patternKey = classify(field.label_text, field.context_text);
    if (!patternKey) {
      return Object.assign(result, { status: 'NEEDS_REVIEW', reason: 'unrecognized_work_auth_question' });
    }

    // Free-text inputs with no options are inherently ambiguous for a
    // preset-only lookup ("Work authorization" text box) — never fill (rule 2).
    if (
      (field.input_type === 'text' || field.input_type === 'textarea') &&
      patternKey === 'status_dropdown'
    ) {
      return Object.assign(result, { status: 'NEEDS_REVIEW', reason: 'free_text_status_field', patternKey });
    }

    if (patternKey === 'status_dropdown') {
      const candidates = ANSWER_TABLE.status_dropdown[preset];
      const options = field.options || [];
      const OptionMatcher = root.OptionMatcher || (typeof require === 'function' ? require('./option-matcher.js') : null);
      let chosen = null;
      if (OptionMatcher) {
        for (const cand of candidates) {
          chosen = OptionMatcher.matchOption(cand, options);
          if (chosen) break;
        }
      }
      if (!chosen) {
        // Rule 4: never fall back to "Other" silently.
        return Object.assign(result, { status: 'NEEDS_REVIEW', reason: 'no_matching_status_option', patternKey });
      }
      return Object.assign(result, { status: 'FILL', value: chosen, patternKey });
    }

    const value = ANSWER_TABLE[patternKey][preset];
    if (value == null) {
      return Object.assign(result, { status: 'NEEDS_REVIEW', reason: 'ambiguous_pattern', patternKey });
    }
    return Object.assign(result, { status: 'FILL', value, patternKey });
  }

  const WorkAuthMatcher = { match, classify, PATTERNS, ANSWER_TABLE, VALID_PRESETS };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WorkAuthMatcher;
  }
  root.WorkAuthMatcher = WorkAuthMatcher;
})(typeof self !== 'undefined' ? self : this);
