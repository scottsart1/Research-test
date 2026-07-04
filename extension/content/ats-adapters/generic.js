/**
 * generic.js — fallback adapter (spec §7 "Generic fallback").
 * Always detects (lowest priority: -1). Handles everything not covered by
 * a more specific adapter using pure §3 heuristics with no overrides.
 */
(function (root) {
  'use strict';

  const GenericAdapter = {
    name: 'generic',
    priority: -1,
    detect() {
      return true;
    },
    quirks: {},
  };

  root.AtsAdapters = root.AtsAdapters || [];
  root.AtsAdapters.push(GenericAdapter);
})(typeof window !== 'undefined' ? window : this);
