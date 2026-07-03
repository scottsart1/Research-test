/**
 * smartrecruiters.js — SmartRecruiters adapter (spec §7 Tier 2).
 * Sectioned SPA with lazy-mounted fields. Per spec §11#5, a race with
 * lazy-mounted fields must never trigger an automatic refill — only an
 * observer-driven *offer* to refill when new fields appear. This adapter
 * just flags itself so observer.js knows to surface that toast instead of
 * silently re-running the fill pass.
 */
(function (root) {
  'use strict';

  const SmartRecruitersAdapter = {
    name: 'smartrecruiters',
    priority: 5,
    detect() {
      return /jobs\.smartrecruiters\.com/.test(location.hostname);
    },
    lazyMounted: true,
    quirks: {},
  };

  root.AtsAdapters = root.AtsAdapters || [];
  root.AtsAdapters.push(SmartRecruitersAdapter);
})(typeof window !== 'undefined' ? window : this);
