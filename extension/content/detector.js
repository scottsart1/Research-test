/**
 * detector.js — field discovery (spec §3, §7 "Shadow DOM"/"iframes").
 *
 * Browser-only (DOM required). Injected with `all_frames: true`, so each
 * iframe gets its own detector instance; content-main.js is responsible for
 * relaying per-frame counts up to the top frame for the review panel.
 *
 * Cross-origin iframes cannot be reached from a parent frame's JS context at
 * all (browser sandboxing) — that's why we rely on all_frames injection
 * rather than manual iframe traversal here. Same-origin iframes are walked
 * by the browser's own DOM the same as any other node, so no special-casing
 * is needed beyond the shadow-DOM recursion below.
 */
(function (root) {
  'use strict';

  let fieldCounter = 0;
  function nextId() {
    fieldCounter += 1;
    return 'fd_' + String(fieldCounter).padStart(4, '0');
  }

  // type=password excluded outright: credentials are never autofill
  // territory for this extension (iCIMS/Workday account-creation sections),
  // and even reading their current_value would be inappropriate.
  const FILLABLE_SELECTOR = [
    'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=password])',
    'select',
    'textarea',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[role="combobox"]',
    'button[aria-haspopup="listbox"]',
    'button[aria-haspopup="true"]',
  ].join(', ');

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isDisabled(el) {
    return el.disabled || el.getAttribute('aria-disabled') === 'true' || el.readOnly;
  }

  /** Recursively collect fillable candidate elements, descending into open shadow roots. */
  function collectCandidates(rootNode, out) {
    let nodes;
    try {
      nodes = rootNode.querySelectorAll(FILLABLE_SELECTOR);
    } catch (e) {
      return;
    }
    for (const el of nodes) out.push(el);

    const allEls = rootNode.querySelectorAll('*');
    for (const el of allEls) {
      if (el.shadowRoot) {
        collectCandidates(el.shadowRoot, out);
      } else if (el.shadowRoot === null && el.tagName && el.getAttribute && el.getAttribute('data-shadow-closed')) {
        // Closed shadow roots are unreachable by design; flagged unscannable
        // by the caller via markUnscannable() when it sees this marker.
      }
    }
  }

  // ---------------------------------------------------------------------
  // Label extraction (priority order per spec §3)
  // ---------------------------------------------------------------------

  function textOf(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function labelFromFor(el) {
    if (!el.id) return '';
    const root = el.getRootNode();
    const label = root.querySelector ? root.querySelector(`label[for="${cssEscape(el.id)}"]`) : null;
    return label ? textOf(label) : '';
  }

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }

  function labelFromAriaLabelledby(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    if (ids.length === 0) return '';
    const root = el.getRootNode();
    const parts = ids.map((id) => {
      const node = root.getElementById ? root.getElementById(id) : document.getElementById(id);
      return node ? textOf(node) : '';
    });
    return parts.filter(Boolean).join(' ');
  }

  function labelFromWrapping(el) {
    const wrapper = el.closest ? el.closest('label') : null;
    if (!wrapper) return '';
    const clone = wrapper.cloneNode(true);
    clone.querySelectorAll('input, select, textarea').forEach((n) => n.remove());
    return textOf(clone);
  }

  function labelFromAtsAttribute(el) {
    // Generic ATS pattern: a sibling/ancestor element whose automation-id or
    // class ends in "formLabel"/"label" within the same field wrapper.
    const container = el.closest('[data-automation-id], [class*="field"], [class*="Field"], fieldset, .form-group, .question') || el.parentElement;
    if (!container) return '';
    const candidate = container.querySelector('[data-automation-id$="formLabel"], [class*="label" i]');
    if (candidate && candidate !== el && !candidate.contains(el)) return textOf(candidate);
    return '';
  }

  function isFormControl(node) {
    return node && /^(input|select|textarea|button)$/i.test(node.tagName || '');
  }

  /**
   * Sibling-text label guess with OWNERSHIP tracking. Some ATSs (Pinpoint)
   * render the label AFTER the input, so the naive "previous sibling text"
   * walk hands field N's label to field N+1 — observed live as a City input
   * labeled "First Name" being filled with "Emily". Rules:
   *   - a text node/element can label at most ONE field (claimed set);
   *   - if the preceding candidate is already claimed, try the FOLLOWING
   *     sibling instead (label-after-input layouts);
   *   - never cross another form control while walking.
   */
  function labelFromSiblingsOrLegend(el, claimed) {
    const fieldset = el.closest ? el.closest('fieldset') : null;
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend && textOf(legend)) return textOf(legend);
    }

    let sib = el.previousElementSibling;
    let hops = 0;
    while (sib && hops < 3) {
      if (isFormControl(sib) || sib.querySelector && sib.querySelector('input, select, textarea')) break;
      const t = textOf(sib);
      if (t) {
        if (!claimed.has(sib)) {
          claimed.add(sib);
          return t;
        }
        break; // already labels an earlier field — fall through to next-sibling
      }
      sib = sib.previousElementSibling;
      hops += 1;
    }

    sib = el.nextElementSibling;
    hops = 0;
    while (sib && hops < 2) {
      if (isFormControl(sib) || (sib.querySelector && sib.querySelector('input, select, textarea'))) break;
      const t = textOf(sib);
      if (t && !claimed.has(sib)) {
        claimed.add(sib);
        return t;
      }
      if (t) break;
      sib = sib.nextElementSibling;
      hops += 1;
    }
    return '';
  }

  function extractLabel(el, claimed) {
    claimed = claimed || new Set();
    return (
      labelFromFor(el) ||
      labelFromAriaLabelledby(el) ||
      el.getAttribute('aria-label') ||
      labelFromWrapping(el) ||
      labelFromAtsAttribute(el) ||
      labelFromSiblingsOrLegend(el, claimed) ||
      el.getAttribute('placeholder') ||
      ''
    ).trim();
  }

  /** Nearest legend / heading-like ancestor text, walking up a few levels. */
  function extractContext(el) {
    const fieldset = el.closest ? el.closest('fieldset') : null;
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend) return textOf(legend);
    }
    let node = el.parentElement;
    let hops = 0;
    while (node && hops < 6) {
      const heading = node.querySelector
        ? node.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > [role="heading"], :scope > [class*="header" i], :scope > [class*="section-title" i]')
        : null;
      if (heading && textOf(heading)) return textOf(heading);
      node = node.parentElement;
      hops += 1;
    }
    return '';
  }

  // ---------------------------------------------------------------------
  // Attribute capture
  // ---------------------------------------------------------------------

  function captureAttributes(el) {
    return {
      name: el.getAttribute('name') || '',
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '',
      'aria-label': el.getAttribute('aria-label') || '',
      autocomplete: el.getAttribute('autocomplete') || '',
      'data-automation-id': el.getAttribute('data-automation-id') || '',
    };
  }

  // ---------------------------------------------------------------------
  // Type classification
  // ---------------------------------------------------------------------

  function classify(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'textarea') return { type: 'textarea' };
    if (tag === 'select') return { type: 'select', uiPattern: 'native' };
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '') {
      return { type: 'contenteditable' };
    }
    if (tag === 'button') {
      return { type: 'select', uiPattern: 'button_listbox' };
    }
    if (el.getAttribute('role') === 'combobox') {
      return { type: 'typeahead', uiPattern: 'combobox' };
    }
    if (tag === 'input') {
      const inputType = (el.getAttribute('type') || 'text').toLowerCase();
      if (inputType === 'radio') return { type: 'radio_group', uiPattern: 'native' };
      if (inputType === 'checkbox') return { type: 'checkbox', uiPattern: 'native' };
      if (inputType === 'date') return { type: 'date', uiPattern: 'native' };
      if (inputType === 'file') return { type: 'file', uiPattern: 'native' };
      if (el.getAttribute('aria-autocomplete') === 'list' || el.hasAttribute('list')) {
        return { type: 'typeahead', uiPattern: 'combobox' };
      }
      return { type: 'text', uiPattern: 'native' };
    }
    return { type: 'text', uiPattern: 'native' };
  }

  // ---------------------------------------------------------------------
  // Radio/checkbox grouping
  // ---------------------------------------------------------------------

  function groupRadiosAndCheckboxes(elements) {
    const grouped = [];
    const seenGroups = new Set();
    const standalone = [];

    for (const el of elements) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'input' && el.getAttribute('type') === 'radio' && el.name) {
        const groupKey = el.name + '::' + (el.getRootNode() === document ? 'doc' : 'shadow');
        if (seenGroups.has(groupKey)) continue;
        seenGroups.add(groupKey);
        const root = el.getRootNode();
        const members = Array.from(root.querySelectorAll(`input[type="radio"][name="${cssEscape(el.name)}"]`)).filter(isVisible);
        grouped.push({ kind: 'radio_group', members, anchor: el });
      } else if (tag === 'input' && el.getAttribute('type') === 'checkbox' && el.name) {
        const root = el.getRootNode();
        const siblings = Array.from(root.querySelectorAll(`input[type="checkbox"][name="${cssEscape(el.name)}"]`)).filter(isVisible);
        if (siblings.length > 1) {
          const groupKey = el.name + '::cb::' + (root === document ? 'doc' : 'shadow');
          if (seenGroups.has(groupKey)) continue;
          seenGroups.add(groupKey);
          grouped.push({ kind: 'checkbox_group', members: siblings, anchor: el });
        } else {
          standalone.push(el);
        }
      } else {
        standalone.push(el);
      }
    }
    return { grouped, standalone };
  }

  function optionLabelForRadioOrCheckbox(el) {
    return (
      labelFromFor(el) ||
      labelFromWrapping(el) ||
      el.getAttribute('aria-label') ||
      textOf(el.nextElementSibling) ||
      el.value ||
      ''
    ).trim();
  }

  // ---------------------------------------------------------------------
  // Select options
  // ---------------------------------------------------------------------

  function optionsFor(el, classification) {
    if (classification.type === 'select' && classification.uiPattern === 'native') {
      return Array.from(el.options || []).map((o) => textOf(o) || o.value);
    }
    if (classification.type === 'select' && classification.uiPattern === 'button_listbox') {
      // Options are only rendered after the button is clicked; filler.js
      // opens the dropdown and reads live options at fill time. Detector
      // still tries to sniff a pre-associated `[role=listbox]` if present.
      const root = el.getRootNode();
      const listboxId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      if (listboxId) {
        const listbox = root.getElementById ? root.getElementById(listboxId) : null;
        if (listbox) {
          return Array.from(listbox.querySelectorAll('[role="option"]')).map(textOf).filter(Boolean);
        }
      }
      return [];
    }
    return [];
  }

  // ---------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------

  function detectFields(scopeDocument) {
    scopeDocument = scopeDocument || document;
    const candidates = [];
    collectCandidates(scopeDocument, candidates);
    // file inputs are exempt from the visibility filter: upload widgets
    // (SuccessFactors, Greenhouse) hide the real <input type=file> behind a
    // styled button, but DataTransfer injection works on the hidden input.
    const visibleCandidates = candidates.filter(
      (el) => !isDisabled(el) && (isVisible(el) || (el.tagName === 'INPUT' && el.getAttribute('type') === 'file'))
    );
    const claimedLabelNodes = new Set();

    const { grouped, standalone } = groupRadiosAndCheckboxes(visibleCandidates);
    const fields = [];

    for (const group of grouped) {
      const anchor = group.anchor;
      const options = group.members.map(optionLabelForRadioOrCheckbox);
      const checkedMember = group.members.find((m) => m.checked);
      fields.push({
        id: nextId(),
        input_type: group.kind,
        label_text: extractContext(anchor) || extractLabel(anchor, claimedLabelNodes),
        context_text: extractContext(anchor),
        attributes: captureAttributes(anchor),
        options,
        required: group.members.some((m) => m.required || m.getAttribute('aria-required') === 'true'),
        current_value: checkedMember ? optionLabelForRadioOrCheckbox(checkedMember) : '',
        ats: null,
        __elements: group.members,
      });
    }

    for (const el of standalone) {
      const classification = classify(el);
      const tag = el.tagName.toLowerCase();
      let currentValue = '';
      if (tag === 'select') currentValue = textOf(el.options[el.selectedIndex]) || '';
      else if (classification.type === 'checkbox') currentValue = el.checked ? 'checked' : '';
      else if (classification.type === 'contenteditable') currentValue = textOf(el);
      else currentValue = el.value || '';

      fields.push({
        id: nextId(),
        input_type: classification.type,
        label_text: extractLabel(el, claimedLabelNodes),
        context_text: extractContext(el),
        attributes: captureAttributes(el),
        options: optionsFor(el, classification),
        required: el.required || el.getAttribute('aria-required') === 'true',
        current_value: currentValue,
        ats: null,
        ui_pattern: classification.uiPattern,
        __elements: [el],
      });
    }

    return fields;
  }

  const Detector = { detectFields, extractLabel, extractContext, isVisible };
  root.Detector = Detector;
})(typeof window !== 'undefined' ? window : this);
