/**
 * workday.js — Workday adapter (spec §7 Tier 1, largest effort).
 *
 * Quirks handled:
 *  - Everything keyed on data-automation-id; formLabel suffix already
 *    picked up generically by detector.js's labelFromAtsAttribute().
 *  - Dropdowns are <button>s opening [role="listbox"] — generic detector
 *    already classifies these as {type:'select', ui_pattern:'button_listbox'}
 *    and filler.js's generic select() strategy handles the click/await/click
 *    flow, so no override needed there.
 *  - Split M/D/Y date spinbuttons — merged into one synthetic date field by
 *    postProcessFields() below, with a fillOverride that writes each
 *    spinbutton independently via its own automation-id.
 *  - Multi-page flow (My Information -> Experience -> Questions -> EEO) —
 *    fill current page only; review-panel state persists across pages via
 *    chrome.storage.session (content-main.js), not this adapter.
 *  - "Autofill with Resume" pre-fills fields before our detector runs —
 *    preFillDelayMs waits for that to settle so current_value is accurate
 *    and the generic skip-if-filled rule (spec §11#3) applies correctly.
 *  - Account-creation page is out of scope (flagged, not filled).
 */
(function (root) {
  'use strict';

  function textOf(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isAccountCreationPage() {
    return !!document.querySelector('[data-automation-id="createAccountSubHeader"], [data-automation-id="createAccountLink"]');
  }

  function automationId(el) {
    return el.getAttribute && (el.getAttribute('data-automation-id') || '');
  }

  /**
   * Workday date-of-birth / start-date / education-date widgets render as
   * three adjacent spinbutton inputs whose automation-ids share a prefix
   * and end in Month/Day/Year (or -month/-day/-year). Merge the three
   * detector-produced text fields into one synthetic 'date' FieldDescriptor.
   */
  function postProcessFields(fields) {
    const spinbuttonFields = fields.filter((f) => {
      const id = automationId(f.__elements && f.__elements[0]);
      return /month|day|year/i.test(id) && f.__elements && f.__elements[0] && f.__elements[0].getAttribute('role') === 'spinbutton';
    });
    if (spinbuttonFields.length === 0) return fields;

    const groups = new Map();
    for (const f of spinbuttonFields) {
      const id = automationId(f.__elements[0]);
      const prefix = id.replace(/[-_]?(month|day|year).*$/i, '');
      if (!groups.has(prefix)) groups.set(prefix, {});
      const part = /month/i.test(id) ? 'month' : /day/i.test(id) ? 'day' : 'year';
      groups.get(prefix)[part] = f;
    }

    const consumed = new Set();
    const merged = [];
    for (const [prefix, parts] of groups.entries()) {
      if (!parts.month || !parts.day || !parts.year) continue; // incomplete triplet, leave as-is
      [parts.month, parts.day, parts.year].forEach((f) => consumed.add(f.id));
      merged.push({
        id: parts.month.id,
        input_type: 'date',
        label_text: parts.month.context_text || parts.month.label_text,
        context_text: parts.month.context_text,
        attributes: parts.month.attributes,
        options: [],
        required: parts.month.required,
        current_value: '',
        ats: 'workday',
        __elements: [parts.month.__elements[0], parts.day.__elements[0], parts.year.__elements[0]],
        __workdayDateParts: true,
      });
    }

    const remaining = fields.filter((f) => !consumed.has(f.id));
    return remaining.concat(merged);
  }

  async function fillOverride(field, value, helpers) {
    if (!field.__workdayDateParts) return null;
    const [monthEl, dayEl, yearEl] = field.__elements;
    const parts = String(value).split('-'); // ISO YYYY-MM-DD or YYYY-MM
    const y = parts[0];
    const m = String(parseInt(parts[1] || '1', 10));
    const d = String(parseInt(parts[2] || '1', 10));
    helpers.setNativeValue(monthEl, m);
    await helpers.sleep(60);
    helpers.setNativeValue(dayEl, d);
    await helpers.sleep(60);
    helpers.setNativeValue(yearEl, y);
    await helpers.sleep(60);
    const ok = monthEl.value === m && dayEl.value === d && yearEl.value === y;
    return { ok, note: ok ? undefined : 'workday_date_spinbutton_mismatch' };
  }

  const WorkdayAdapter = {
    name: 'workday',
    priority: 10,
    detect() {
      return /myworkdayjobs\.com/.test(location.hostname) || !!document.querySelector('[data-automation-id]');
    },
    preFillDelayMs: 2000, // wait for "Autofill with Resume" network to settle
    isOutOfScope() {
      return isAccountCreationPage();
    },
    quirks: {
      postProcessFields,
      fillOverride,
    },
  };

  root.AtsAdapters = root.AtsAdapters || [];
  root.AtsAdapters.push(WorkdayAdapter);
})(typeof window !== 'undefined' ? window : this);
