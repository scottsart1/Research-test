/**
 * option-matcher.js — select/radio option matching (spec §5.5).
 * Order: exact normalized equality -> substring either direction ->
 * token overlap >= 0.8 -> else null (caller must treat as NEEDS_REVIEW).
 * Never picks index 0, never picks "Other" silently.
 */
(function (root) {
  'use strict';

  const Fuzzy = root.Fuzzy || (typeof require === 'function' ? require('./fuzzy.js') : null);

  const OTHER_TOKENS = new Set(['other', 'others', 'n/a', 'na']);

  function isOtherOption(opt) {
    const n = Fuzzy.normalize(opt);
    return OTHER_TOKENS.has(n);
  }

  /**
   * @param {string} desired - the canonical value we want to select
   * @param {string[]} options - the actual option labels rendered by the form
   * @returns {string|null} the matched option label, or null if none qualifies
   */
  function matchOption(desired, options) {
    if (!desired || !options || options.length === 0) return null;
    const usable = options.filter((o) => !isOtherOption(o));

    for (const opt of usable) {
      if (Fuzzy.normalizedEquals(opt, desired)) return opt;
    }
    for (const opt of usable) {
      if (Fuzzy.substringEitherWay(opt, desired)) return opt;
    }
    let best = null;
    let bestScore = 0;
    for (const opt of usable) {
      const score = Fuzzy.jaccard(opt, desired);
      if (score > bestScore) {
        bestScore = score;
        best = opt;
      }
    }
    if (best && bestScore >= 0.8) return best;
    return null;
  }

  /**
   * Numeric years-of-experience -> range-bucket option (spec §5.5 NEW).
   * @returns {string|null}
   */
  function matchRangeBucket(value, options) {
    return Fuzzy.matchRangeBucket(value, options);
  }

  /**
   * Exact numeric-string equality only (e.g. option "5" for value 5).
   * Deliberately skips the substring pass matchOption() uses for text
   * options: "5" is a substring of "3-5" and "5+", which would otherwise
   * produce a false-positive "exact" hit before range-bucket logic ever runs.
   */
  function matchNumericExact(value, options) {
    const usable = options.filter((o) => !isOtherOption(o));
    for (const opt of usable) {
      if (Fuzzy.normalizedEquals(opt, String(value))) return opt;
    }
    return null;
  }

  const OptionMatcher = { matchOption, matchRangeBucket, matchNumericExact, isOtherOption };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OptionMatcher;
  }
  root.OptionMatcher = OptionMatcher;
})(typeof self !== 'undefined' ? self : this);
