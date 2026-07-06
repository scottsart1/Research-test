/**
 * filler.js — value injection per input type (spec §6).
 *
 * Every write path here is a *value* injection only. Grep-able invariant
 * (spec §11#10 / CI test in test/run-tests.js): this file must never invoke
 * the DOM form-submission method, and must never simulate a click on a
 * submit-typed button. The extension never advances or submits anything —
 * a review-panel click is the only human-triggered action beyond the
 * initial "Fill" command, and even that never targets a submit control.
 */
(function (root) {
  'use strict';

  function textOf(el) {
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function jitter() {
    return 50 + Math.random() * 100; // 50-150ms pacing, spec §6 / §11#9
  }

  // ---------------------------------------------------------------------
  // Native-setter value injection (React-controlled inputs, spec §6)
  // ---------------------------------------------------------------------

  function setNativeValue(el, value) {
    // Custom-widget guard: SuccessFactors renders comboboxes as non-input
    // elements; calling HTMLInputElement's native setter on them throws
    // "Illegal invocation" (observed live on an EY run). Only use the
    // prototype setter for real inputs/textareas; everything else gets a
    // plain property write or textContent.
    const isInput = typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement;
    const isTextArea = typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement;
    if (isInput || isTextArea) {
      const proto = isTextArea ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, value);
      } else {
        el.value = value;
      }
    } else if ('value' in el) {
      try {
        el.value = value;
      } catch (e) {
        el.textContent = String(value);
      }
    } else {
      el.textContent = String(value);
    }
    ['input', 'change', 'blur'].forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
  }

  /**
   * Loose equality for widget-reformatted values: phone inputs strip or add
   * formatting ("(717) 903-4428" -> "7179034428"), so exact comparison
   * false-alarms even though the value landed (observed live on a
   * Greenhouse phone field, reported FAILED with the number visibly there).
   * When both sides are phone-shaped, compare digits only.
   */
  function valuesEquivalent(actual, expected) {
    if (actual === expected) return true;
    const phoneish = /^[\d\s()+.\-]+$/;
    if (phoneish.test(String(expected)) && phoneish.test(String(actual))) {
      const digits = (s) => String(s).replace(/\D/g, '');
      const de = digits(expected);
      return de.length > 0 && digits(actual) === de;
    }
    return false;
  }

  async function setValueWithKeystrokeFallback(el, value) {
    el.focus();
    setNativeValue(el, value);
    await sleep(30);
    if (valuesEquivalent(el.value, value)) return true;

    // Retry once with simulated per-character keystrokes for stubborn
    // controlled inputs that ignore programmatic value assignment. Uses the
    // same guarded write as setNativeValue — the raw prototype setter throws
    // "Illegal invocation" on custom (non-input) widgets.
    setNativeValue(el, '');
    const isRealInput = (typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement) ||
      (typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement);
    for (const ch of String(value)) {
      if (isRealInput) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, el.value + ch);
      } else {
        el.value = (el.value || '') + ch;
      }
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(30);
    return valuesEquivalent(el.value, value);
  }

  // ---------------------------------------------------------------------
  // Waiting helpers
  // ---------------------------------------------------------------------

  function pollUntil(fn, timeoutMs, intervalMs) {
    intervalMs = intervalMs || 50;
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const result = fn();
        if (result) return resolve(result);
        if (Date.now() - start >= timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  function findListbox(el) {
    const controlsId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    if (controlsId) {
      const root = el.getRootNode();
      const byId = root.getElementById ? root.getElementById(controlsId) : document.getElementById(controlsId);
      if (byId && root.Detector ? root.Detector.isVisible(byId) : isVisibleLocal(byId)) return byId;
    }
    const candidates = document.querySelectorAll('[role="listbox"]');
    for (const c of candidates) {
      if (isVisibleLocal(c) && c.querySelectorAll('[role="option"]').length > 0) return c;
    }
    return null;
  }

  /** Full mouse-interaction sequence — some widgets only listen to mousedown. */
  function openWithMouse(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    try {
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    } catch (e) {
      if (typeof el.click === 'function') el.click();
    }
  }

  function isVisibleLocal(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // ---------------------------------------------------------------------
  // Date formatting
  // ---------------------------------------------------------------------

  function detectDateFormat(el) {
    const hint = (el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('pattern') || '') + ' ' + (el.getAttribute('data-format') || '');
    if (/yyyy-mm-dd/i.test(hint)) return 'YYYY-MM-DD';
    if (/mm\/dd\/yyyy/i.test(hint)) return 'MM/DD/YYYY';
    if (/dd\/mm\/yyyy/i.test(hint)) return 'DD/MM/YYYY';
    return 'MM/DD/YYYY';
  }

  function formatIsoDate(iso, fmt) {
    // iso: "YYYY-MM-DD" or "YYYY-MM"
    const parts = iso.split('-');
    const y = parts[0];
    const m = (parts[1] || '01').padStart(2, '0');
    const d = (parts[2] || '01').padStart(2, '0');
    if (fmt === 'YYYY-MM-DD') return `${y}-${m}-${d}`;
    if (fmt === 'DD/MM/YYYY') return `${d}/${m}/${y}`;
    return `${m}/${d}/${y}`;
  }

  // ---------------------------------------------------------------------
  // Per-type fill strategies. Each returns { ok: bool, note?: string }
  // ---------------------------------------------------------------------

  const strategies = {
    async text(field, el, value) {
      const ok = await setValueWithKeystrokeFallback(el, String(value));
      return ok ? { ok: true } : { ok: false, note: 'value_mismatch_after_retry' };
    },

    async textarea(field, el, value) {
      return strategies.text(field, el, value);
    },

    async contenteditable(field, el, value) {
      el.focus();
      el.textContent = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('blur', { bubbles: true }));
      await sleep(20);
      return textOf(el) === String(value) ? { ok: true } : { ok: false, note: 'value_mismatch' };
    },

    async select(field, el, value) {
      if (field.ui_pattern === 'button_listbox' || el.tagName.toLowerCase() === 'button') {
        openWithMouse(el);
        const listbox = await pollUntil(() => findListbox(el), 1500);
        if (!listbox) return { ok: false, note: 'listbox_did_not_open' };
        const optionEls = Array.from(listbox.querySelectorAll('[role="option"]'));
        const labels = optionEls.map(textOf);
        const idx = labels.findIndex((l) => l === value);
        if (idx === -1) {
          document.body.click(); // close the dropdown without selecting
          return { ok: false, note: 'no_matching_live_option' };
        }
        optionEls[idx].click();
        await sleep(20);
        return { ok: true };
      }
      // Native <select>. Dependent selects (State only populates after
      // Country changes) may still be loading options when we get here —
      // wait once for late-arriving options before giving up.
      let options = Array.from(el.options || []);
      let idx = options.findIndex((o) => textOf(o) === value || o.value === value);
      if (idx === -1) {
        await sleep(900);
        options = Array.from(el.options || []);
        // Options may have loaded with different casing/format than the
        // originally-detected list; re-run the option matcher against them.
        const OptionMatcher = root.OptionMatcher;
        const labels = options.map(textOf);
        const rematched = OptionMatcher ? OptionMatcher.matchOption(String(value), labels) : null;
        idx = rematched ? labels.indexOf(rematched) : options.findIndex((o) => textOf(o) === value || o.value === value);
      }
      if (idx === -1) return { ok: false, note: 'option_not_found_in_dom' };
      el.selectedIndex = idx;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    },

    async radio_group(field, value) {
      const member = field.__elements.find((m) => {
        const label =
          (root.Detector && root.Detector.extractLabel && root.Detector.extractLabel(m)) || m.value || '';
        return label.trim() === value || m.value === value;
      });
      if (!member) return { ok: false, note: 'radio_option_not_found' };
      member.click();
      await sleep(20);
      return { ok: member.checked, note: member.checked ? undefined : 'click_did_not_check' };
    },

    async checkbox_group(field, value) {
      // value may be a single label or an array of labels for multi-select.
      const wanted = Array.isArray(value) ? value : [value];
      let anyOk = false;
      for (const el of field.__elements) {
        const label = (root.Detector && root.Detector.extractLabel(el)) || el.value || '';
        const shouldCheck = wanted.includes(label.trim()) || wanted.includes(el.value);
        if (shouldCheck !== el.checked) {
          el.click();
          anyOk = true;
        }
      }
      await sleep(20);
      return { ok: anyOk || wanted.length === 0 };
    },

    async checkbox(field, el, value) {
      const shouldCheck = value === true || /^(yes|true|checked)$/i.test(String(value));
      if (el.checked !== shouldCheck) el.click();
      await sleep(20);
      return { ok: el.checked === shouldCheck };
    },

    async date(field, el, value) {
      if (el.tagName.toLowerCase() === 'input' && el.getAttribute('type') === 'date') {
        const iso = value.length === 7 ? value + '-01' : value;
        setNativeValue(el, iso);
        return { ok: el.value === iso, note: el.value === iso ? undefined : 'date_input_rejected_value' };
      }
      const fmt = detectDateFormat(el);
      const formatted = formatIsoDate(value, fmt);
      const ok = await setValueWithKeystrokeFallback(el, formatted);
      return ok ? { ok: true } : { ok: false, note: 'value_mismatch_after_retry' };
    },

    async typeahead(field, el, value) {
      el.focus();
      setNativeValue(el, String(value));
      let listbox = await pollUntil(() => findListbox(el), 1200);

      if (!listbox) {
        // Click-to-open combobox (SuccessFactors EEO selects open on click,
        // not on typing — typing alone produced "no_listbox_appeared" live).
        openWithMouse(el);
        listbox = await pollUntil(() => findListbox(el), 1200);
      }

      if (!listbox && el.parentElement) {
        // react-select (Greenhouse's new board) binds mousedown on the
        // styled control WRAPPER, not the inner input — clicking the input
        // itself never opens the menu (observed live on every select of a
        // Robinhood application).
        openWithMouse(el.parentElement);
        listbox = await pollUntil(() => findListbox(el), 1500);
      }

      if (!listbox) {
        // Not actually a typeahead? Plain inputs with aria-autocomplete but
        // no popup behave like text — keep the typed value if it's a plain
        // input, otherwise never leave half-typed text (spec §6 / §11#2).
        const plainInput = el.tagName === 'INPUT' && !el.readOnly && el.getAttribute('role') !== 'combobox' && !el.getAttribute('aria-controls');
        if (plainInput && el.value === String(value)) {
          return { ok: true, note: 'typeahead_degraded_to_text' };
        }
        setNativeValue(el, '');
        return { ok: false, note: 'no_listbox_appeared' };
      }

      const optionEls = Array.from(listbox.querySelectorAll('[role="option"]'));
      const labels = optionEls.map(textOf);
      const OptionMatcher = root.OptionMatcher;
      const matched = OptionMatcher ? OptionMatcher.matchOption(String(value), labels) : labels.find((l) => l === value);
      if (!matched) {
        setNativeValue(el, '');
        document.body.click(); // close the popup without selecting
        return { ok: false, note: 'no_matching_option_typed' };
      }
      optionEls[labels.indexOf(matched)].click();
      await sleep(20);
      return { ok: true };
    },

    async file(field, el) {
      // Only genuine file inputs accept DataTransfer; anything else that
      // got classified 'file' is a custom widget the human must click.
      if (!(el && el.tagName === 'INPUT' && el.getAttribute('type') === 'file')) {
        return { ok: false, note: 'attach_manually_custom_widget' };
      }
      if (typeof chrome === 'undefined' || !chrome.storage) {
        return { ok: false, note: 'attach_manually' };
      }
      const stored = await new Promise((resolve) => {
        chrome.storage.local.get(['resumeFile'], (data) => resolve(data.resumeFile || null));
      });
      if (!stored || !stored.base64) {
        return { ok: false, note: 'attach_manually_no_resume_stored' };
      }
      try {
        const bytes = root.ResumeUtils.base64ToBytes(stored.base64);
        const blob = new Blob([bytes], { type: stored.type || 'application/pdf' });
        const file = new File([blob], stored.name || 'resume.pdf', { type: stored.type || 'application/pdf' });
        const dt = new DataTransfer();
        dt.items.add(file);
        el.files = dt.files;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        const ok = el.files.length === 1 && el.files[0].name === file.name;
        return ok ? { ok: true } : { ok: false, note: 'resume_attach_did_not_take' };
      } catch (err) {
        return { ok: false, note: 'resume_attach_failed: ' + (err && err.message) };
      }
    },
  };

  // ---------------------------------------------------------------------
  // Verification pass
  // ---------------------------------------------------------------------

  function verifyField(field, expectedValue) {
    const el = field.__elements && field.__elements[0];
    if (!el) return false;
    switch (field.input_type) {
      case 'select':
        if (el.tagName.toLowerCase() === 'select') {
          const opt = el.options[el.selectedIndex];
          return opt ? textOf(opt) === expectedValue : false;
        }
        return true; // button_listbox verified inline at click time
      case 'radio_group':
        return field.__elements.some((m) => m.checked);
      case 'checkbox_group':
        return true;
      case 'checkbox':
        return true;
      case 'contenteditable':
        return textOf(el) === String(expectedValue);
      case 'file':
        // el.value is a browser-synthesized fake path, never comparable to
        // the resume filename — check el.files instead (set by the file()
        // strategy's DataTransfer injection).
        return !!(el.files && el.files.length > 0);
      default:
        return el.value === String(expectedValue) || el.value === expectedValue;
    }
  }

  // ---------------------------------------------------------------------
  // Public entry point
  // ---------------------------------------------------------------------

  /**
   * Fills a single field. Never called for NEEDS_REVIEW/UNMATCHED results —
   * caller (content-main.js) is responsible for that gate.
   * @param {object} field - FieldDescriptor with __elements attached by detector.js
   * @param {*} value - resolved value (string, number, or array for checkbox_group)
   * @param {object} [opts] - { force: bool, adapter: AtsAdapter }
   */
  async function fillField(field, value, opts) {
    opts = opts || {};

    if (!opts.force && field.current_value) {
      return { field_id: field.id, outcome: 'SKIPPED_PREFILLED', note: 'already has a value; not overwritten (spec §11#3)' };
    }

    if (opts.adapter && opts.adapter.quirks && typeof opts.adapter.quirks.fillOverride === 'function') {
      const overridden = await opts.adapter.quirks.fillOverride(field, value, { setNativeValue, sleep, pollUntil, findListbox, formatIsoDate, detectDateFormat });
      if (overridden) return finalizeOutcome(field, value, overridden);
    }

    const strategy = strategies[field.input_type];
    if (!strategy) {
      return { field_id: field.id, outcome: 'SKIPPED_UNSUPPORTED_TYPE', note: `no fill strategy for ${field.input_type}` };
    }

    let result;
    try {
      if (field.input_type === 'select' || field.input_type === 'text' || field.input_type === 'textarea' || field.input_type === 'contenteditable' || field.input_type === 'date' || field.input_type === 'typeahead' || field.input_type === 'checkbox' || field.input_type === 'file') {
        result = await strategy(field, field.__elements[0], value);
      } else {
        result = await strategy(field, value);
      }
    } catch (err) {
      result = { ok: false, note: 'exception: ' + (err && err.message) };
    }

    return finalizeOutcome(field, value, result);
  }

  function finalizeOutcome(field, value, result) {
    if (!result.ok) {
      return { field_id: field.id, outcome: 'FAILED', note: result.note || 'unknown_failure' };
    }
    const verified = verifyField(field, value);
    return {
      field_id: field.id,
      outcome: verified ? 'FILLED' : 'FILLED_UNVERIFIED',
      note: verified ? undefined : 'post-write verification mismatch — downgraded to warning',
    };
  }

  /**
   * Sequentially fills a batch of {field, value} pairs with pacing jitter
   * between writes (spec §6 / §11#9 — simultaneous writes break per-field
   * server validation on several ATSs).
   */
  async function fillSequential(entries, opts) {
    const outcomes = [];
    for (const { field, value } of entries) {
      const outcome = await fillField(field, value, opts);
      outcomes.push(outcome);
      await sleep(jitter());
    }
    return outcomes;
  }

  const Filler = { fillField, fillSequential, setNativeValue, verifyField, valuesEquivalent };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Filler;
  }
  root.Filler = Filler;
})(typeof window !== 'undefined' ? window : this);
