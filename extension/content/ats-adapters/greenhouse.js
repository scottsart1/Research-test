/**
 * greenhouse.js — Greenhouse adapter (spec §7 Tier 1).
 * Two generations: legacy `#application_form` (clean <label for>) and the
 * new React board on job-boards.greenhouse.io (combobox EEO selects, aria
 * labeling). Both are covered by the generic detector's label-priority
 * chain; this adapter mainly supplies detection + the resume-parse
 * pre-fill delay and iframe-embed awareness.
 */
(function (root) {
  'use strict';

  const GreenhouseAdapter = {
    name: 'greenhouse',
    priority: 10,
    detect() {
      return (
        /boards\.greenhouse\.io|job-boards\.greenhouse\.io/.test(location.hostname) ||
        !!document.querySelector('#application_form, [id^="grnhse_"], [class*="greenhouse" i]')
      );
    },
    preFillDelayMs: 2000, // LinkedIn/resume autofill may pre-populate fields
    quirks: {},
  };

  root.AtsAdapters = root.AtsAdapters || [];
  root.AtsAdapters.push(GreenhouseAdapter);
})(typeof window !== 'undefined' ? window : this);
