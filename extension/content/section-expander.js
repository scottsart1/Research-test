/**
 * section-expander.js — expands empty repeatable sections by clicking their
 * "Add" controls, then lets the orchestrator re-fill the newly-mounted
 * fields. Built for SuccessFactors-style profiles (EY: "Work Experience /
 * Education / Language Skills — There are no items in this section. ⊕ Add")
 * but heuristic enough for similar layouts elsewhere.
 *
 * Safety posture:
 *  - Only clicks controls whose own text is a bare "Add" variant, and only
 *    when the nearest preceding section heading matches a whitelisted
 *    repeatable-section name. Anything whose text ever matches
 *    save/submit/apply/next/continue/delete is refused outright — this
 *    module must never advance or submit a form (spec §11#10).
 *  - Hard budget on total clicks per pass.
 *  - Clicks are sequential with settle-waits so per-field validation and
 *    lazy mounting keep up (spec §11#5/#9).
 */
(function (root) {
  'use strict';

  const SECTION_SPECS = [
    { key: 'experience', headingRe: /(work|professional) experience|employment history/i, entriesFromBank: (bank) => Math.min((bank.experience || []).length, 3) },
    { key: 'education', headingRe: /education/i, entriesFromBank: (bank) => Math.min((bank.education || []).length, 3) },
    { key: 'languages', headingRe: /language/i, entriesFromBank: () => 1 },
  ];

  const ADD_TEXT_RE = /^\s*[+⊕✚]?\s*add\b[\s\w()]*$/i;
  const FORBIDDEN_TEXT_RE = /save|submit|apply|next|continue|delete|remove|cancel|withdraw|sign|upload/i;
  const MAX_TOTAL_CLICKS = 6;

  function textOf(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  /** All headings in document order, for nearest-preceding-heading lookup. */
  function collectHeadings() {
    return Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"], legend'))
      .filter((h) => textOf(h))
      .map((h) => ({ el: h, text: textOf(h) }));
  }

  function nearestPrecedingHeading(el, headings) {
    let best = null;
    for (const h of headings) {
      const pos = h.el.compareDocumentPosition(el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) best = h; // heading precedes el
    }
    return best;
  }

  function findAddControls() {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return candidates.filter((el) => {
      if (!isVisible(el)) return false;
      const t = textOf(el);
      const aria = el.getAttribute('aria-label') || '';
      const label = t || aria;
      if (!label || label.length > 60) return false;
      if (FORBIDDEN_TEXT_RE.test(label)) return false;
      return ADD_TEXT_RE.test(label) || /^add\b/i.test(aria);
    });
  }

  function countFields() {
    return root.Detector ? root.Detector.detectFields(document).length : 0;
  }

  /**
   * Expand whitelisted sections. Calls `onSectionExpanded()` (async, should
   * run a fill pass) after each successful click that mounted new fields.
   * Returns a summary for the panel/log.
   */
  async function expandAndFill(bank, onSectionExpanded) {
    const summary = [];
    let clicksUsed = 0;

    for (const spec of SECTION_SPECS) {
      const wanted = spec.entriesFromBank(bank);
      if (wanted === 0) continue;

      for (let entry = 0; entry < wanted; entry++) {
        if (clicksUsed >= MAX_TOTAL_CLICKS) break;

        // Re-query every iteration: each click mutates the DOM.
        const headings = collectHeadings();
        const control = findAddControls().find((el) => {
          const h = nearestPrecedingHeading(el, headings);
          return h && spec.headingRe.test(h.text);
        });
        if (!control) break; // section not on this page, or no more Add slots

        const before = countFields();
        control.click();
        clicksUsed += 1;

        // Wait for the sub-form to mount (poll field count, up to 3s).
        let after = before;
        for (let i = 0; i < 10; i++) {
          await sleep(300);
          after = countFields();
          if (after > before) break;
        }

        if (after <= before) {
          summary.push({ section: spec.key, entry, outcome: 'no_new_fields' });
          break; // clicking again would likely repeat the no-op
        }

        await sleep(250); // let framework validation settle
        if (typeof onSectionExpanded === 'function') {
          await onSectionExpanded(spec.key, entry);
        }
        summary.push({ section: spec.key, entry, outcome: 'expanded_and_filled' });
      }
    }
    return summary;
  }

  root.SectionExpander = { expandAndFill, findAddControls, SECTION_SPECS };
})(typeof window !== 'undefined' ? window : this);
