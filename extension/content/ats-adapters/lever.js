/**
 * lever.js — Lever adapter (spec §7 Tier 2).
 * Reliable `name=` attributes make Tier 1 highly effective here. Lever runs
 * its own resume parse on upload, so we wait for it to settle before
 * detecting current_value (spec §11#3 skip-if-filled rule).
 */
(function (root) {
  'use strict';

  const LeverAdapter = {
    name: 'lever',
    priority: 5,
    detect() {
      return /jobs\.lever\.co/.test(location.hostname);
    },
    preFillDelayMs: 2000,
    quirks: {},
  };

  root.AtsAdapters = root.AtsAdapters || [];
  root.AtsAdapters.push(LeverAdapter);
})(typeof window !== 'undefined' ? window : this);
