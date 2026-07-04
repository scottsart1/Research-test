/**
 * observer.js — MutationObserver for SPA/lazy/multi-step forms (spec §7 end).
 *
 * Never auto-refires a fill on its own (spec §11#5): lazy-mounted fields
 * (SmartRecruiters, Oracle) and multi-step navigation (Workday) only ever
 * produce an *offer* — a toast the human clicks — never a silent re-fill.
 */
(function (root) {
  'use strict';

  function startFieldWatcher(onNewFieldsAvailable, debounceMs) {
    debounceMs = debounceMs || 500;
    let timer = null;
    const mo = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(onNewFieldsAvailable, debounceMs);
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      clearTimeout(timer);
      mo.disconnect();
    };
  }

  /** Polls location.href for SPA route changes (pushState-driven ATSs don't fire popstate). */
  function startRouteWatcher(onRouteChange, intervalMs) {
    let last = location.href;
    const handle = setInterval(() => {
      if (location.href !== last) {
        last = location.href;
        onRouteChange(last);
      }
    }, intervalMs || 500);
    return () => clearInterval(handle);
  }

  /**
   * Workday's Hispanic/Latino pre-question can hide/reveal the race
   * question when answered (spec §5.6). Re-scan the EEO section shortly
   * after any change to a field whose matched category is hispanic_latino.
   */
  function watchEeoDependency(field, onRescan) {
    if (!field || !field.__elements) return () => {};
    const listeners = field.__elements.map((el) => {
      const handler = () => setTimeout(onRescan, 300);
      el.addEventListener('change', handler);
      return () => el.removeEventListener('change', handler);
    });
    return () => listeners.forEach((off) => off());
  }

  const Observer = { startFieldWatcher, startRouteWatcher, watchEeoDependency };
  root.Observer = Observer;
})(typeof window !== 'undefined' ? window : this);
