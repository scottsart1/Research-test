/**
 * matcher.js — local question -> answer matching engine (spec §5).
 *
 * Pure decision logic with no DOM access, so it is unit-testable from Node
 * (see test/run-tests.js) as well as loaded as a content script. All DOM
 * interaction lives in detector.js (read) and filler.js (write).
 *
 * Tiers:
 *   0  Work-authorization dedicated matcher (always runs first; §4.3/§11#1)
 *   1  Attribute exact map                         confidence 1.0
 *   2  Regex category rules (ordered, w/ conflict margin check)  0.9
 *   3  Fuzzy token-Jaccard against synonym bags     0.55-1.0
 *   4  Claude API fallback (async, batched separately by the orchestrator;
 *      this module only exposes resolveValue() so the orchestrator can turn
 *      an API-returned key into a validated fill, identically to Tiers 1-3)
 *
 * A field is NEVER filled with a placeholder bank value («...»). Doctrine:
 * "A wrong autofill is worse than no autofill" (spec §1).
 */
(function (root) {
  'use strict';

  function req(relPath) {
    if (root[relPath.globalName]) return root[relPath.globalName];
    if (typeof require === 'function') return require(relPath.nodePath);
    throw new Error('Cannot resolve dependency: ' + relPath.globalName);
  }

  const Fuzzy = req({ globalName: 'Fuzzy', nodePath: '../lib/fuzzy.js' });
  const WorkAuthMatcher = req({ globalName: 'WorkAuthMatcher', nodePath: '../lib/workauth-matcher.js' });
  const OptionMatcher = req({ globalName: 'OptionMatcher', nodePath: '../lib/option-matcher.js' });
  const EeoStrings = req({ globalName: 'EeoStrings', nodePath: '../lib/eeo-strings.js' });
  const MatchRules = req({ globalName: 'MatchRules', nodePath: '../data/match-rules.js' });

  const DEFAULT_THRESHOLDS = { fuzzyFill: 0.72, fuzzyWarn: 0.55, marginRequired: 0.15 };

  const WORK_AUTH_DETECT_RE =
    /work authoriz|authoriz.{0,25}work.{0,20}(u\.?s\.?|united states)|sponsor(ship)?|visa status|immigration status|citizenship status|\bcitizen\b|permanent resident|green card|\blpr\b/;

  // -----------------------------------------------------------------------
  // Bank path resolution
  // -----------------------------------------------------------------------

  function getByPath(bank, path) {
    if (!path) return undefined;
    const segments = path.split('.');
    let cur = bank;
    for (const seg of segments) {
      if (cur == null) return undefined;
      cur = cur[seg];
    }
    return cur;
  }

  function isPlaceholder(value) {
    return typeof value === 'string' && /^\s*«.*»\s*$/.test(value);
  }

  // -----------------------------------------------------------------------
  // Text-source assembly (label + context, normalized once)
  // -----------------------------------------------------------------------

  function fieldHaystack(field) {
    return Fuzzy.normalize(`${field.label_text || ''} ${field.context_text || ''}`);
  }

  // -----------------------------------------------------------------------
  // Value -> final option resolution (shared by all tiers, incl. Tier 4)
  // -----------------------------------------------------------------------

  /**
   * Resolves a bank key into a concrete value appropriate for `field`,
   * applying placeholder rejection and option/range-bucket matching.
   * @returns {{status, value, reason}}
   */
  function resolveValue(bankKey, bank, field) {
    if (!bankKey) return { status: 'NEEDS_REVIEW', value: null, reason: 'no_bank_key' };

    let raw = getByPath(bank, bankKey);

    // stock_answers.*.mode sentinel: always NEEDS_REVIEW regardless of value.
    if (bankKey.endsWith('.mode') && raw === 'NEEDS_REVIEW') {
      return { status: 'NEEDS_REVIEW', value: null, reason: 'stock_answer_freeform' };
    }

    if (raw == null || raw === '') {
      return { status: 'NEEDS_REVIEW', value: null, reason: 'bank_value_empty' };
    }
    if (isPlaceholder(raw)) {
      return { status: 'NEEDS_REVIEW', value: null, reason: 'bank_value_placeholder' };
    }

    const isOptionField = ['select', 'radio_group', 'checkbox_group'].includes(field.input_type);
    if (!isOptionField) {
      // YYYY-MM bank dates (experience/education start/end) going into a
      // plain text input: convert to the MM/YYYY form ATSs conventionally
      // expect there. Real date inputs are handled by filler.js's date
      // strategy; option fields (split M/D/Y selects) fall through to
      // option matching below, where a non-matching "2024-02" correctly
      // degrades to NEEDS_REVIEW instead of guessing a month.
      if (/\.(start|end)$/.test(bankKey) && typeof raw === 'string' && /^\d{4}-\d{2}$/.test(raw) && (field.input_type === 'text' || field.input_type === 'textarea')) {
        const [y, m] = raw.split('-');
        return { status: 'FILL', value: `${m}/${y}`, reason: 'date_as_month_year' };
      }
      return { status: 'FILL', value: raw, reason: 'direct' };
    }

    const options = field.options || [];
    if (options.length === 0) {
      return { status: 'NEEDS_REVIEW', value: null, reason: 'option_field_no_options' };
    }

    // Numeric-string bank values ("95000") get the same treatment as real
    // numbers so salary/YoE range buckets work regardless of storage type.
    const numeric = typeof raw === 'number' ? raw : (/^\d+(\.\d+)?$/.test(String(raw).trim()) ? parseFloat(raw) : null);
    if (numeric !== null) {
      const exact = OptionMatcher.matchNumericExact(numeric, options);
      if (exact) return { status: 'FILL', value: exact, reason: 'numeric_exact' };
      const bucket = OptionMatcher.matchRangeBucket(numeric, options);
      if (bucket) return { status: 'FILL', value: bucket, reason: 'range_bucket' };
      return { status: 'NEEDS_REVIEW', value: null, reason: 'no_matching_range_bucket' };
    }

    let matched = OptionMatcher.matchOption(String(raw), options);
    if (!matched && bankKey.startsWith('eeo.') && EeoStrings.isDeclineOption(raw)) {
      matched = options.find((o) => EeoStrings.isDeclineOption(o)) || null;
    }
    if (!matched) {
      return { status: 'NEEDS_REVIEW', value: null, reason: 'no_matching_option' };
    }
    return { status: 'FILL', value: matched, reason: 'option_match' };
  }

  // -----------------------------------------------------------------------
  // Tier 1 — attribute exact map
  // -----------------------------------------------------------------------

  function tier1(field) {
    const attrs = field.attributes || {};
    const candidates = [attrs.autocomplete, attrs.name, attrs.id, attrs['data-automation-id']];
    for (const c of candidates) {
      if (!c) continue;
      const norm = Fuzzy.normalize(c).replace(/\s+/g, '-');
      const key = MatchRules.TIER1_ATTRIBUTE_MAP[norm] || MatchRules.TIER1_ATTRIBUTE_MAP[Fuzzy.normalize(c)];
      if (key) return { bankKey: key, confidence: 1.0, tier: 1, category: key.split('.')[0] };
    }
    return null;
  }

  // -----------------------------------------------------------------------
  // Tier 2 — regex rules with specificity-based conflict resolution
  // -----------------------------------------------------------------------

  function tier2(field, bank, hayLabel, hayFull) {
    const hits = [];
    for (const rule of MatchRules.TIER2_RULES) {
      // Anchored rules like /^city$/ must see the bare label — appending a
      // section heading (iCIMS "Addresses (1)" etc.) would break them. Try
      // label-only first, then label+context for rules that need the wider
      // window; rules marked labelOnly never look at the context (their
      // trigger tokens appear in section headings too). resolve() always
      // receives the full haystack so context-gated rules (experience-block
      // fields) can inspect the heading.
      const m = rule.labelOnly
        ? hayLabel.match(rule.test)
        : hayLabel.match(rule.test) || hayFull.match(rule.test);
      if (!m) continue;
      const key = rule.resolve ? rule.resolve(hayFull, field, bank) : rule.key;
      hits.push({ rule, key, matchLen: m[0].length });
    }
    if (hits.length === 0) return null;

    // Special-cased rules short-circuit regardless of competing hits.
    const special = hits.find((h) => h.rule.special);
    if (special) {
      if (special.rule.special === 'always_review') {
        return { bankKey: null, confidence: 0.9, tier: 2, category: 'special', forceReview: true, reason: special.rule.name };
      }
      if (special.rule.special === 'skip_optional') {
        // Deliberately-blank fields (middle name, address line 2,
        // conditional "If yes..." follow-ups): not an error, not a fill —
        // shown neutrally in the panel so the human knows it was seen.
        return { bankKey: null, confidence: 0.9, tier: 2, category: 'optional', skipOptional: true, reason: special.rule.name };
      }
      if (special.rule.special === 'referral') {
        const isChoice = ['radio_group', 'select', 'checkbox_group', 'checkbox'].includes(field.input_type);
        return isChoice
          ? { bankKey: '__literal:No', confidence: 0.9, tier: 2, category: 'logistics' }
          : { bankKey: null, confidence: 0.9, tier: 2, category: 'logistics', forceReview: true, reason: 'referral_name_field' };
      }
      if (special.rule.special === 'enrolled_date_guard') {
        const gradEnd = new Date('2026-05-31T23:59:59');
        const now = new Date();
        const isChoice = ['radio_group', 'select', 'checkbox_group', 'checkbox'].includes(field.input_type);
        if (now > gradEnd && isChoice) {
          return { bankKey: '__literal:No', confidence: 0.9, tier: 2, category: 'education' };
        }
        return { bankKey: null, confidence: 0.9, tier: 2, category: 'education', forceReview: true, reason: 'enrollment_date_ambiguous' };
      }
    }

    const withKeys = hits.filter((h) => h.key);
    if (withKeys.length === 0) return null;

    const byKey = new Map();
    for (const h of withKeys) {
      const existing = byKey.get(h.key);
      if (!existing || h.matchLen > existing.matchLen) byKey.set(h.key, h);
    }
    const ranked = [...byKey.values()].sort((a, b) => b.matchLen - a.matchLen);
    const top = ranked[0];
    const second = ranked[1];
    if (second) {
      const margin = (top.matchLen - second.matchLen) / top.matchLen;
      if (margin < DEFAULT_THRESHOLDS.marginRequired) {
        return { bankKey: null, confidence: 0.9, tier: 2, category: 'ambiguous', forceReview: true, reason: 'conflicting_categories' };
      }
    }
    return { bankKey: top.key, confidence: 0.9, tier: 2, category: top.key.split('.')[0] };
  }

  // -----------------------------------------------------------------------
  // Tier 3 — fuzzy token overlap against synonym bags
  // -----------------------------------------------------------------------

  function tier3(field, hay, thresholds) {
    let best = null;
    for (const [bankKey, bag] of Object.entries(MatchRules.TIER3_SYNONYM_BAGS)) {
      const score = Fuzzy.bestJaccardAgainstBag(hay, bag);
      if (!best || score > best.score) best = { bankKey, score };
    }
    if (!best || best.score < thresholds.fuzzyWarn) return null;
    return {
      bankKey: best.bankKey,
      confidence: best.score,
      tier: 3,
      category: best.bankKey.split('.')[0],
      lowConfidence: best.score < thresholds.fuzzyFill,
    };
  }

  // -----------------------------------------------------------------------
  // Public entry point
  // -----------------------------------------------------------------------

  /**
   * @param {object} field - FieldDescriptor (spec §3)
   * @param {object} bank - answer bank
   * @param {object} [opts] - { immigrationStatus, thresholds }
   * @returns {object} match result, always including `status`.
   */
  function matchField(field, bank, opts) {
    opts = opts || {};
    const thresholds = Object.assign({}, DEFAULT_THRESHOLDS, opts.thresholds || {});
    const hay = fieldHaystack(field);
    const hayLabel = Fuzzy.normalize(field.label_text || '');

    // Tier 0 — work authorization is a closed subsystem: if the question
    // looks like a work-auth question at all, it is decided here and only
    // here. Tier 2-4 (including the API) never see it (spec §4.3 rule 3).
    if (WORK_AUTH_DETECT_RE.test(hay)) {
      const result = WorkAuthMatcher.match(field, opts.immigrationStatus);
      if (result.status === 'FILL') {
        // Status-dropdown branch already resolved to a real option label;
        // everything else is a plain Yes/No literal.
        return finalize({ status: 'FILL', value: result.value, bankKey: null, confidence: 1.0, tier: 0, category: 'work_auth', lockIcon: true, reason: result.patternKey });
      }
      return finalize({ status: 'NEEDS_REVIEW', value: null, bankKey: null, confidence: 0, tier: 0, category: 'work_auth', lockIcon: true, reason: result.reason });
    }

    const t1 = tier1(field);
    if (t1) return finalize(applyBankKey(t1, bank, field));

    const t2 = tier2(field, bank, hayLabel, hay);
    if (t2) {
      if (t2.forceReview) {
        return finalize({ status: 'NEEDS_REVIEW', value: null, bankKey: null, confidence: t2.confidence, tier: 2, category: t2.category, reason: t2.reason });
      }
      if (t2.skipOptional) {
        return finalize({ status: 'SKIPPED_OPTIONAL', value: null, bankKey: null, confidence: t2.confidence, tier: 2, category: t2.category, reason: t2.reason });
      }
      return finalize(attrConflictGuard(applyBankKey(t2, bank, field), field));
    }

    const t3 = tier3(field, hay, thresholds);
    if (t3) {
      const resolved = attrConflictGuard(applyBankKey(t3, bank, field), field);
      if (resolved.status === 'FILL' && t3.lowConfidence) {
        resolved.status = 'FILL_LOW_CONFIDENCE';
      }
      return finalize(resolved);
    }

    return finalize({ status: 'UNMATCHED', value: null, bankKey: null, confidence: 0, tier: null, category: 'unmatched', reason: 'no_local_match' });
  }

  // Strong semantic tokens that may appear in a field's name/id attributes.
  // When a label-derived match (Tier 2/3) contradicts what the machine
  // attributes say the field is, trust neither: flag for review. Live
  // failure this guards against (Pinpoint): label extraction misattributed
  // "First Name" to a City input, filling "Emily" into city and zip.
  const ATTR_HINT_TOKENS = ['email', 'phone', 'city', 'zip', 'postal', 'first', 'last', 'country', 'state', 'linkedin'];

  function attrConflictGuard(result, field) {
    if (!result || (result.status !== 'FILL' && result.status !== 'FILL_LOW_CONFIDENCE')) return result;
    if (!result.bankKey) return result;
    const attrs = field.attributes || {};
    const attrText = Fuzzy.normalize(`${attrs.name || ''} ${attrs.id || ''}`);
    if (!attrText) return result;
    const keyText = result.bankKey.toLowerCase();
    const present = ATTR_HINT_TOKENS.filter((t) => attrText.includes(t));
    if (present.length === 0) return result;
    // Consistent if ANY present token also appears in the matched key
    // (e.g. name="phone_country_code" matched to phone_formatted is fine
    // even though "country" alone would look contradictory).
    const consistent = present.some((t) => keyText.includes(t === 'postal' ? 'zip' : t));
    if (consistent) return result;
    return {
      status: 'NEEDS_REVIEW',
      value: null,
      bankKey: result.bankKey,
      confidence: result.confidence,
      tier: result.tier,
      category: result.category,
      reason: `attr_label_conflict:${present.join(',')}`,
    };
  }

  function applyBankKey(tierHit, bank, field) {
    if (tierHit.bankKey && tierHit.bankKey.startsWith('__literal:')) {
      return {
        status: 'FILL',
        value: tierHit.bankKey.slice('__literal:'.length),
        bankKey: null,
        confidence: tierHit.confidence,
        tier: tierHit.tier,
        category: tierHit.category,
      };
    }
    const resolved = resolveValue(tierHit.bankKey, bank, field);
    return {
      status: resolved.status,
      value: resolved.value,
      bankKey: tierHit.bankKey,
      confidence: tierHit.confidence,
      tier: tierHit.tier,
      category: tierHit.category,
      reason: resolved.reason,
    };
  }

  function finalize(result) {
    return Object.assign(
      { status: 'UNMATCHED', value: null, bankKey: null, confidence: 0, tier: null, category: 'unknown', lockIcon: false, reason: '' },
      result
    );
  }

  /**
   * Used by the Tier-4 orchestrator (background/service-worker.js) once the
   * Claude API has returned a {field_id, answer_key, confidence} mapping.
   * Re-runs the same resolution + option-matching pipeline as local tiers so
   * the API can only ever pick a *key*, never fabricate a value (spec §5 Tier 4).
   */
  function resolveApiKey(field, bank, answerKey, apiConfidence) {
    if (!answerKey || apiConfidence < 0.8) {
      return finalize({ status: 'UNMATCHED', category: 'unmatched', tier: 4, reason: 'api_low_confidence' });
    }
    if (answerKey.startsWith('work_auth') || answerKey.startsWith('immigration_status')) {
      return finalize({ status: 'NEEDS_REVIEW', category: 'work_auth', tier: 4, lockIcon: true, reason: 'api_fallback_disabled_for_work_auth' });
    }
    const resolved = resolveValue(answerKey, bank, field);
    return finalize({
      status: resolved.status,
      value: resolved.value,
      bankKey: answerKey,
      confidence: apiConfidence,
      tier: 4,
      category: answerKey.split('.')[0],
      reason: resolved.reason,
    });
  }

  // Questions the AI may map to existing answers but must never *draft*
  // prose for: attestations, demographics, figures, and credentials.
  const DRAFT_FORBIDDEN_RE =
    /salary|compensation|pay (rate|range)|clearance|citizen|visa|sponsor|immigration|gender|race|ethnicit|veteran|disabilit|criminal|social security|\bssn\b|date of birth|\bdob\b|password|log ?in|username/;

  /**
   * Applies one AI decision {action, answer_key, option, draft, confidence}
   * to a field, with every path locally validated — the model proposes, this
   * function disposes:
   *   - "map": same pipeline as resolveApiKey (option matching, placeholder
   *     guard, work-auth namespace rejection).
   *   - "option": only for option fields, and the returned string must match
   *     one of the field's actual options via OptionMatcher — never trusted
   *     verbatim.
   *   - "draft": only for free-text inputs, only for questions outside
   *     DRAFT_FORBIDDEN_RE, length-capped. Result is marked aiGenerated so
   *     the panel pins it for human reading before submit.
   * Returns null when the decision should be discarded (keeps the local
   * NEEDS_REVIEW/UNMATCHED record instead).
   */
  function resolveApiAction(field, bank, decision) {
    if (!decision || !decision.action || decision.action === 'skip') return null;
    const confidence = typeof decision.confidence === 'number' ? decision.confidence : 0;
    const hay = fieldHaystack(field);

    // Work authorization stays a closed subsystem no matter what the model
    // returns (spec §4.3 rule 3 — unchanged by the AI-drafting feature).
    if (WORK_AUTH_DETECT_RE.test(hay)) {
      return finalize({ status: 'NEEDS_REVIEW', category: 'work_auth', tier: 4, lockIcon: true, reason: 'api_disabled_for_work_auth' });
    }

    if (decision.action === 'map') {
      const mapped = resolveApiKey(field, bank, decision.answer_key, confidence);
      return mapped.status === 'UNMATCHED' ? null : mapped;
    }

    if (decision.action === 'option') {
      if (confidence < 0.75) return null;
      if (!['select', 'radio_group', 'checkbox_group'].includes(field.input_type)) return null;
      const matched = OptionMatcher.matchOption(String(decision.option || ''), field.options || []);
      if (!matched) return null;
      return finalize({
        status: 'FILL', value: matched, bankKey: null, confidence, tier: 4,
        category: 'ai_answer', reason: 'api_option', aiGenerated: true,
      });
    }

    if (decision.action === 'draft') {
      if (confidence < 0.6) return null;
      if (!['text', 'textarea', 'contenteditable'].includes(field.input_type)) return null;
      if (DRAFT_FORBIDDEN_RE.test(hay)) return null;
      const draft = String(decision.draft || '').trim();
      if (!draft || draft.length > 3000) return null;
      return finalize({
        status: 'FILL_AI_DRAFT', value: draft, bankKey: null, confidence, tier: 4,
        category: 'ai_answer', reason: 'api_draft', aiGenerated: true,
      });
    }

    return null;
  }

  /**
   * Repeatable-block indexing (spec §4.4 / §11#4). Match rules always emit
   * index-0 keys (experience.0.company, education.0.school, ...). Given the
   * full result list in DOM order, the Nth occurrence of the same
   * block-field signature is re-pointed at block N and re-resolved, so the
   * second "Employer" input gets experience[1].company and so on. If the
   * bank has no entry N, resolution returns NEEDS_REVIEW — never a guess
   * and never block 0's data duplicated into block 1 (the wrong-repeatable-
   * block failure in spec §11#4).
   *
   * Pure function over [{field, match}] — mutates each `match` in place and
   * returns the list, so it's unit-testable without a DOM.
   */
  function applyRepeatableBlockIndexing(results, bank) {
    const counters = Object.create(null);
    for (const r of results) {
      const key = r.match && r.match.bankKey;
      if (!key) continue;
      const m = key.match(/^(experience|education)\.0\.(.+)$/);
      if (!m) continue;
      const signature = `${m[1]}.${m[2]}`;
      const n = counters[signature] || 0;
      counters[signature] = n + 1;
      if (n === 0) continue;

      const newKey = `${m[1]}.${n}.${m[2]}`;
      const resolved = resolveValue(newKey, bank, r.field);
      r.match.bankKey = newKey;
      r.match.value = resolved.value;
      r.match.reason = resolved.reason;
      if (resolved.status === 'FILL') {
        // Preserve a low-confidence marker from the original tier match.
        if (r.match.status !== 'FILL_LOW_CONFIDENCE') r.match.status = 'FILL';
      } else {
        r.match.status = resolved.status;
      }
    }
    return results;
  }

  const Matcher = { matchField, resolveApiKey, resolveApiAction, getByPath, isPlaceholder, resolveValue, applyRepeatableBlockIndexing, WORK_AUTH_DETECT_RE, DRAFT_FORBIDDEN_RE };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Matcher;
  }
  root.Matcher = Matcher;
})(typeof self !== 'undefined' ? self : this);
