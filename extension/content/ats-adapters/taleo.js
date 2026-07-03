/**
 * taleo.js — Taleo / Oracle Recruiting Cloud (spec §7 Tier 1, "two sub-adapters").
 * Legacy Taleo (taleo.net) uses frames + long generated ids, so we rely on
 * label text rather than attributes. Oracle Recruiting Cloud (its
 * successor, oraclecloud.com) is a React SPA with real aria-labels, closer
 * to the generic path. Both register separately so detect() can be precise.
 */
(function (root) {
  'use strict';

  const TaleoLegacyAdapter = {
    name: 'taleo-legacy',
    priority: 10,
    detect() {
      return /taleo\.net/.test(location.hostname);
    },
    quirks: {
      // Legacy Taleo ids are long and auto-generated (e.g. "REQ_1234_field_9");
      // never trust Tier 1 attribute matching here, force label-only matching
      // by stripping id/name from the attribute bag before Tier 1 runs.
      normalizeField(field) {
        field.attributes = Object.assign({}, field.attributes, { name: '', id: '', autocomplete: '' });
        return field;
      },
    },
  };

  const OracleRecruitingAdapter = {
    name: 'oracle-recruiting-cloud',
    priority: 10,
    detect() {
      return /oraclecloud\.com/.test(location.hostname) && /recruiting|careers|jobs/i.test(location.pathname + location.hostname);
    },
    quirks: {},
  };

  root.AtsAdapters = root.AtsAdapters || [];
  root.AtsAdapters.push(TaleoLegacyAdapter, OracleRecruitingAdapter);
})(typeof window !== 'undefined' ? window : this);
