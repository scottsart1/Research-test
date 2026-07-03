/**
 * ashby.js — Ashby adapter (spec §7 Tier 2).
 * React app; labels live in adjacent divs (generic labelFromWrapping /
 * labelFromPrecedingSiblingOrLegend already cover this) and selects render
 * as `[role="combobox"]`, which detector.js already classifies as typeahead.
 */
(function (root) {
  'use strict';

  const AshbyAdapter = {
    name: 'ashby',
    priority: 5,
    detect() {
      return /jobs\.ashbyhq\.com/.test(location.hostname);
    },
    quirks: {},
  };

  root.AtsAdapters = root.AtsAdapters || [];
  root.AtsAdapters.push(AshbyAdapter);
})(typeof window !== 'undefined' ? window : this);
