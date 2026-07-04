/**
 * tier3-hints.js — thin Tier 3 adapters (spec §7 Tier 3).
 * Workable, BambooHR, Jobvite, SAP SuccessFactors, ADP Workforce Now,
 * Dayforce/Paylocity/Rippling. All are mostly labelHints over the generic
 * heuristics; only detect() + a couple of ATS-specific notes are needed.
 */
(function (root) {
  'use strict';

  const adapters = [
    {
      name: 'workable',
      priority: 1,
      detect: () => /apply\.workable\.com/.test(location.hostname) || !!document.querySelector('[data-ui]'),
      quirks: {},
    },
    {
      name: 'bamboohr',
      priority: 1,
      detect: () => /bamboohr\.com\/careers/.test(location.hostname + location.pathname),
      quirks: {},
    },
    {
      name: 'jobvite',
      priority: 1,
      detect: () => /jobvite\.com/.test(location.hostname),
      quirks: {},
    },
    {
      name: 'successfactors',
      priority: 1,
      detect: () => /successfactors\.(com|eu)/.test(location.hostname),
      // Legacy, iframe-heavy — same rationale as iCIMS: rely on all_frames
      // injection rather than manual traversal, widen fill pacing.
      pacingMultiplier: 1.5,
      quirks: {},
    },
    {
      name: 'adp-workforce-now',
      priority: 1,
      detect: () => /workforcenow\.adp\.com/.test(location.hostname),
      quirks: {},
    },
    {
      name: 'dayforce-paylocity-rippling',
      priority: 1,
      detect: () => /dayforcehcm\.com|paylocity\.com|ats\.rippling\.com/.test(location.hostname),
      quirks: {},
    },
  ];

  root.AtsAdapters = root.AtsAdapters || [];
  root.AtsAdapters.push(...adapters);
})(typeof window !== 'undefined' ? window : this);
