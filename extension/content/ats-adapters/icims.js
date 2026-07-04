/**
 * icims.js — iCIMS adapter (spec §7 Tier 1).
 * Heavy nested iframes (#icims_content_iframe) are handled by manifest
 * `all_frames: true` injection rather than manual traversal — each frame
 * runs its own content-main.js and reports up to the top frame. Legacy
 * inputs accept `.value` directly but still require dispatched events for
 * validation listeners to fire, which filler.js's setNativeValue already
 * does. Per-field server validation makes pacing important, so this
 * adapter widens the generic 50-150ms jitter window.
 */
(function (root) {
  'use strict';

  const IcimsAdapter = {
    name: 'icims',
    priority: 10,
    detect() {
      return /icims\.com/.test(location.hostname) || !!document.querySelector('#icims_content_iframe, [id*="icims" i]');
    },
    pacingMultiplier: 1.5,
    quirks: {},
  };

  root.AtsAdapters = root.AtsAdapters || [];
  root.AtsAdapters.push(IcimsAdapter);
})(typeof window !== 'undefined' ? window : this);
