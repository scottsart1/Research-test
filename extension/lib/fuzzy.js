/**
 * fuzzy.js — normalization + scoring primitives. No dependencies.
 * Shared by the matcher (Tier 3), option matcher (§5.5), and workauth matcher.
 * Loaded as a plain script (no ES modules) so it works in content-script and
 * service-worker contexts without a bundler; exposes window.Fuzzy / self.Fuzzy.
 */
(function (root) {
  'use strict';

  function normalize(str) {
    if (str == null) return '';
    return String(str)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '') // strip diacritics
      .replace(/[^\w\s%+.-]/g, ' ') // strip punctuation except a few meaningful chars
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenize(str) {
    const n = normalize(str);
    if (!n) return [];
    return n.split(' ').filter(Boolean);
  }

  function tokenSet(str) {
    return new Set(tokenize(str));
  }

  /** Jaccard similarity between two token sets (0..1). */
  function jaccard(a, b) {
    const setA = a instanceof Set ? a : tokenSet(a);
    const setB = b instanceof Set ? b : tokenSet(b);
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;
    let intersection = 0;
    for (const tok of setA) {
      if (setB.has(tok)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  /** Best jaccard score of `text` against a bag of synonym phrases. */
  function bestJaccardAgainstBag(text, bag) {
    const set = tokenSet(text);
    let best = 0;
    for (const phrase of bag) {
      const score = jaccard(set, tokenSet(phrase));
      if (score > best) best = score;
    }
    return best;
  }

  function normalizedEquals(a, b) {
    return normalize(a) === normalize(b);
  }

  function substringEitherWay(a, b) {
    const na = normalize(a);
    const nb = normalize(b);
    if (!na || !nb) return false;
    return na.includes(nb) || nb.includes(na);
  }

  /**
   * Parse a numeric range-bucket option label into {min, max} (max may be Infinity).
   * Handles "1-3", "3+", "5 or more", "Less than 1", "0-1 years", "1 to 3", etc.
   * Returns null if unparseable (caller must treat as NEEDS_REVIEW per §5.5).
   */
  function parseRangeBucket(label) {
    // Strip currency symbols and thousands separators BEFORE normalizing so
    // "$90,001-$100,000" parses as 90001-100000 instead of fragmenting into
    // small numbers (live failure on an EY compensation-range picker).
    const n = normalize(String(label == null ? '' : label).replace(/[$,]/g, ''));
    if (!n) return null;

    let m = n.match(/less than (\d+(?:\.\d+)?)/);
    if (m) return { min: -Infinity, max: parseFloat(m[1]) - 1e-9 };

    m = n.match(/(\d+(?:\.\d+)?)\s*(?:\+|or more|or greater|and above|and up)/);
    if (m) return { min: parseFloat(m[1]), max: Infinity };

    m = n.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(\d+(?:\.\d+)?)/);
    if (m) return { min: parseFloat(m[1]), max: parseFloat(m[2]) };

    m = n.match(/^(\d+(?:\.\d+)?)$/);
    if (m) return { min: parseFloat(m[1]), max: parseFloat(m[1]) };

    return null;
  }

  /**
   * Given a numeric value and a list of option labels, find the bucket
   * containing the value. Boundary values pick the bucket containing them.
   * Returns the matching option label, or null (=> NEEDS_REVIEW).
   */
  function matchRangeBucket(value, options) {
    const num = typeof value === 'number' ? value : parseFloat(value);
    if (Number.isNaN(num)) return null;
    const matches = [];
    for (const opt of options) {
      const range = parseRangeBucket(opt);
      if (!range) continue;
      if (num >= range.min && num <= range.max) matches.push({ opt, range });
    }
    if (matches.length === 0) return null;
    if (matches.length === 1) return matches[0].opt;

    // Boundary value shared by two buckets (e.g. 5 is both the top of "3-5"
    // and the bottom of "5+"): prefer the bucket where the value is the
    // *lower* bound — that's the conventional reading of adjacent range
    // labels ("5+" means "5 or more", so 5 belongs there, not to "3-5").
    const asLowerBound = matches.find((m) => m.range.min === num);
    if (asLowerBound) return asLowerBound.opt;

    // Otherwise prefer the tightest (most specific, smallest-width) bucket.
    matches.sort((a, b) => (a.range.max - a.range.min) - (b.range.max - b.range.min));
    return matches[0].opt;
  }

  const Fuzzy = {
    normalize,
    tokenize,
    tokenSet,
    jaccard,
    bestJaccardAgainstBag,
    normalizedEquals,
    substringEitherWay,
    parseRangeBucket,
    matchRangeBucket,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Fuzzy;
  }
  root.Fuzzy = Fuzzy;
})(typeof self !== 'undefined' ? self : this);
