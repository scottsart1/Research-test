/**
 * content-main.js — orchestrator (spec §2 "Flow").
 *
 * popup "Fill" (or Alt+Shift+F) -> detector collects FieldDescriptor[] ->
 * matcher (Tier 1-3 local, Tier 4 batched API) -> repeatable-block indexing
 * -> filler writes with proper events -> verification pass -> review panel.
 *
 * FRAME MODEL (spec §7 iCIMS/Greenhouse "merge to top-frame panel"):
 * content scripts run in every frame (all_frames: true). Only the TOP frame
 * ever renders the review panel. Child frames fill their own documents,
 * then ship plain serialized records up through the background worker
 * (FRAME_RECORDS -> MERGE_RECORDS), which the top frame merges into the
 * single panel. Click-to-scroll and "Clear all fills" are routed back down
 * to the owning frame the same way (PULSE_FIELD -> PULSE_LOCAL,
 * CLEAR_FILLS broadcast). Without this, iframe-heavy ATSs (iCIMS, legacy
 * Taleo, SuccessFactors) show one empty panel in the top frame and a
 * second squeezed panel inside the iframe — the exact failure observed on
 * a live iCIMS run.
 *
 * This file never calls a submit control and never auto-advances a
 * multi-step form (spec §11#10).
 */
(function () {
  'use strict';

  const IS_TOP = window === window.top;

  let hasWaitedForPrefill = false;
  let stopFieldWatcher = null;
  let stopRouteWatcher = null;
  let lastFillSnapshot = []; // for "Clear all fills" (per frame)
  let localFieldsById = new Map(); // field_id -> field (per frame, for pulse)
  let mergedRecords = new Map(); // top frame only: `${frameKey}:${field_id}` -> record

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function pickAdapter() {
    const list = (window.AtsAdapters || []).filter((a) => {
      try {
        return a.detect();
      } catch (e) {
        return false;
      }
    });
    list.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    return list[0] || { name: 'generic', priority: -1, quirks: {} };
  }

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['answerBank', 'settings'], (data) => {
        resolve({
          bank: data.answerBank || null,
          settings: Object.assign(
            { immigrationStatus: '', apiEnabled: false, thresholds: {}, atsToggles: {} },
            data.settings || {}
          ),
        });
      });
    });
  }

  function bankKeyCatalog() {
    // Flattened list of fillable, non-work-auth bank paths offered to the
    // Tier 4 API for key mapping (spec §5 Tier 4 — API maps to keys only).
    return [
      'identity.first_name', 'identity.last_name', 'identity.full_name', 'identity.email',
      'identity.phone_formatted', 'identity.address_line1', 'identity.city', 'identity.state',
      'identity.zip', 'identity.country', 'identity.linkedin', 'identity.portfolio', 'identity.github',
      'identity.how_heard', 'identity.preferred_name', 'identity.pronouns',
      'education.0.school', 'education.0.degree', 'education.0.degree_level', 'education.0.field',
      'education.0.gpa', 'education.0.start', 'education.0.end',
      'experience.0.company', 'experience.0.title', 'experience.0.summary',
      'experience.0.location_city', 'experience.0.location_state', 'experience.0.country',
      'experience.0.start', 'experience.0.end',
      'highest_education', 'total_professional_years', 'skills_flat_list', 'certifications',
      'clearance.has_clearance', 'clearance.clearance_level', 'clearance.willing_to_obtain', 'clearance.held_clearance_past',
      'federal.current_federal_employee', 'federal.former_federal_employee', 'federal.special_hiring_authority',
      'compensation.desired_salary_annual', 'compensation.salary_answer_text',
      'logistics.available_start', 'logistics.willing_to_relocate', 'logistics.remote_hybrid_onsite',
      'logistics.willing_to_travel', 'logistics.employment_type', 'logistics.languages',
      'logistics.over_18', 'logistics.worked_here_before', 'logistics.relatives_at_company',
      'logistics.non_compete', 'logistics.background_check_consent', 'logistics.drug_test_consent',
      'logistics.criminal_record', 'logistics.military_veteran_service',
      'eeo.gender', 'eeo.race_ethnicity', 'eeo.hispanic_latino', 'eeo.veteran_status', 'eeo.disability_status',
      'documents.resume_filename',
    ];
  }

  // Fields the AI must never see, even for mapping: locked work-auth
  // records, EEO demographics, and anything the local rules flagged as
  // credentials or a human-only attestation.
  const AI_EXCLUDED_REASONS = new Set(['password', 'login_username', 'public_trust']);

  function aiEligible(r) {
    if (r.match.lockIcon || r.match.category === 'work_auth' || r.match.category === 'eeo') return false;
    if (AI_EXCLUDED_REASONS.has(r.match.reason)) return false;
    return r.match.status === 'UNMATCHED' || r.match.status === 'NEEDS_REVIEW';
  }

  function collectJobContext() {
    let excerpt = '';
    try {
      excerpt = (document.body.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 2500);
    } catch (e) { /* detached body etc. */ }
    return { page_title: document.title || '', page_excerpt: excerpt };
  }

  async function resolveTier4(candidateFields) {
    if (candidateFields.length === 0) return {};
    const { settings } = await loadSettings();
    if (!settings.apiEnabled) return {};
    const payload = candidateFields.map((f) => ({
      field_id: f.id,
      label_text: f.label_text,
      context_text: f.context_text,
      input_type: f.input_type,
      options: f.options,
    }));
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'RESOLVE_TIER4', fields: payload, catalog: bankKeyCatalog(), job_context: collectJobContext() },
        (response) => {
          if (chrome.runtime.lastError || !response || !response.results) return resolve({});
          const byId = {};
          response.results.forEach((r) => {
            byId[r.field_id] = r;
          });
          resolve(byId);
        }
      );
    });
  }

  /**
   * Combine the match decision with what the filler actually did into a
   * single panel status. A low-confidence match that filled successfully
   * must stay visible as a warning, not get promoted to a clean FILLED.
   */
  function combinedStatus(matchResult, fillOutcome) {
    if (!fillOutcome) return matchResult.status;
    if (fillOutcome.outcome === 'FILLED' && matchResult.status === 'FILL_LOW_CONFIDENCE') {
      return 'FILLED_LOW_CONFIDENCE';
    }
    if (fillOutcome.outcome === 'FILLED' && matchResult.status === 'FILL_AI_DRAFT') {
      return 'FILLED_AI_DRAFT';
    }
    return fillOutcome.outcome;
  }

  function buildOutcomeRecord(field, matchResult, fillOutcome) {
    return {
      field_id: field.id,
      label_text: field.label_text,
      category: matchResult.category,
      value: matchResult.value,
      lockIcon: !!matchResult.lockIcon,
      aiGenerated: !!matchResult.aiGenerated,
      status: combinedStatus(matchResult, fillOutcome),
      note: (fillOutcome && fillOutcome.note) || matchResult.reason || undefined,
    };
  }

  function frameToast(message) {
    // Only the top frame owns UI. Child frames route toasts upward.
    if (IS_TOP) {
      window.ReviewPanel.showToast(message);
    } else {
      chrome.runtime.sendMessage({ type: 'FRAME_TOAST', message });
    }
  }

  async function runFillPass(adapter, opts) {
    opts = opts || {};
    const { bank, settings } = await loadSettings();
    if (!bank) {
      frameToast('No answer bank configured — open the extension options page first.');
      return;
    }
    if (!settings.immigrationStatus && IS_TOP) {
      frameToast('No work-authorization preset selected in options — those questions will be flagged for review.');
    }

    if (adapter.isOutOfScope && adapter.isOutOfScope()) {
      frameToast('This page (account creation) is out of scope — nothing was filled.');
      return;
    }

    if (adapter.preFillDelayMs && !hasWaitedForPrefill) {
      hasWaitedForPrefill = true;
      await sleep(adapter.preFillDelayMs);
    }

    let fields = window.Detector.detectFields(document);
    if (adapter.quirks && adapter.quirks.postProcessFields) {
      fields = adapter.quirks.postProcessFields(fields);
    }
    if (adapter.quirks && adapter.quirks.normalizeField) {
      fields = fields.map(adapter.quirks.normalizeField);
    }

    localFieldsById = new Map(fields.map((f) => [f.id, f]));

    const results = fields.map((field) => ({
      field,
      match: window.Matcher.matchField(field, bank, {
        immigrationStatus: settings.immigrationStatus,
        thresholds: settings.thresholds,
      }),
    }));

    // Repeatable blocks: 2nd/3rd occurrence of the same experience/education
    // field gets re-pointed at experience[1]/[2] etc. (spec §4.4, §11#4).
    window.Matcher.applyRepeatableBlockIndexing(results, bank);

    // AI pass: everything local matching couldn't confidently answer —
    // unmatched AND needs-review — goes to the model for semantic
    // understanding (map to a known answer, pick the right option, or draft
    // a grounded qualitative answer). Locked/attestation fields never go.
    const aiCandidates = results.filter(aiEligible);
    const tier4Results = await resolveTier4(aiCandidates.map((r) => r.field));
    for (const r of aiCandidates) {
      const decision = tier4Results[r.field.id];
      if (!decision) continue;
      const next = window.Matcher.resolveApiAction(r.field, bank, decision);
      if (next) r.match = next;
    }

    const toFill = results.filter((r) => ['FILL', 'FILL_LOW_CONFIDENCE', 'FILL_AI_DRAFT'].includes(r.match.status));
    const snapshot = toFill.map((r) => ({ field: r.field, originalValue: r.field.current_value }));

    const fillEntries = toFill.map((r) => ({ field: r.field, value: r.match.value }));
    const fillOutcomes = await window.Filler.fillSequential(fillEntries, { adapter, force: opts.force });
    const fillOutcomeById = {};
    fillOutcomes.forEach((o) => {
      fillOutcomeById[o.field_id] = o;
    });

    lastFillSnapshot = lastFillSnapshot.concat(snapshot);

    const records = results.map((r) => buildOutcomeRecord(r.field, r.match, fillOutcomeById[r.field.id]));

    // EEO re-scan hook (spec §5.6 — Workday two-step Hispanic/Latino radio).
    const hispanicField = results.find((r) => r.match.bankKey === 'eeo.hispanic_latino');
    if (hispanicField) {
      window.Observer.watchEeoDependency(hispanicField.field, () => runFillPass(adapter, { force: false }));
    }

    // Clearance-required posting notice (spec §4.6 / §8).
    const pageText = (document.body.innerText || '').toLowerCase();
    if (/active (secret|top secret|ts\/sci) clearance required|must (currently )?hold an? (active )?clearance/.test(pageText)) {
      records.forEach((r) => {
        if (r.category === 'clearance') r.clearanceRequiredNotice = true;
      });
    }

    publishRecords(records);
    persistState(records);
  }

  // ---------------------------------------------------------------------
  // Record publication: child frames send up, top frame merges + renders
  // ---------------------------------------------------------------------

  function publishRecords(records) {
    if (IS_TOP) {
      mergeRecords('local', records);
    } else {
      chrome.runtime.sendMessage({ type: 'FRAME_RECORDS', records });
    }
  }

  function mergeRecords(frameKey, records) {
    for (const r of records) {
      mergedRecords.set(`${frameKey}:${r.field_id}`, Object.assign({}, r, { __frameKey: frameKey }));
    }
    renderPanel();
  }

  function renderPanel() {
    const all = [...mergedRecords.values()];
    window.ReviewPanel.render(all, {
      onItemClick: (record) => {
        if (record.__frameKey === 'local') {
          const field = localFieldsById.get(record.field_id);
          window.ReviewPanel.pulseElement(field && field.__elements && field.__elements[0]);
        } else {
          chrome.runtime.sendMessage({ type: 'PULSE_FIELD', frameId: record.__frameKey, field_id: record.field_id });
        }
      },
      onClearAll: () => {
        restoreSnapshot();
        chrome.runtime.sendMessage({ type: 'CLEAR_FILLS_BROADCAST' });
        mergedRecords = new Map();
        renderPanel();
      },
      onCopySkipped: () => {},
    });
  }

  function pulseLocalField(fieldId) {
    const field = localFieldsById.get(fieldId);
    const el = field && field.__elements && field.__elements[0];
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Inline-style highlight: the panel's shadow-DOM keyframes can't reach
    // page elements (and don't exist at all in child frames).
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = '3px solid #4f46e5';
    el.style.outlineOffset = '2px';
    setTimeout(() => {
      el.style.outline = prevOutline;
      el.style.outlineOffset = prevOffset;
    }, 1400);
  }

  function restoreSnapshot() {
    for (const { field, originalValue } of lastFillSnapshot) {
      const el = field.__elements && field.__elements[0];
      if (!el) continue;
      if (field.input_type === 'radio_group' || field.input_type === 'checkbox_group') {
        field.__elements.forEach((m) => {
          if (m.checked && !originalValue) m.click();
        });
      } else if (field.input_type === 'checkbox') {
        if (el.checked && !originalValue) el.click();
      } else if (field.input_type === 'file') {
        try {
          el.value = '';
        } catch (e) { /* some browsers disallow programmatic clear; harmless */ }
      } else if (window.Filler) {
        window.Filler.setNativeValue(el, originalValue || '');
      }
    }
    lastFillSnapshot = [];
  }

  function persistState(records) {
    const summary = records.map((r) => ({
      field_id: r.field_id,
      label_text: r.label_text,
      category: r.category,
      status: r.status,
      value: r.value,
      lockIcon: r.lockIcon,
    }));
    chrome.runtime.sendMessage({ type: 'PERSIST_PANEL_STATE', page: location.href, records: summary });
  }

  function offerRefillOnNewFields(adapter) {
    if (stopFieldWatcher) stopFieldWatcher();
    stopFieldWatcher = window.Observer.startFieldWatcher(() => {
      if (IS_TOP) {
        window.ReviewPanel.showToast('New fields detected on this page.', () => runFillPass(adapter, { force: false }));
      } else {
        chrome.runtime.sendMessage({ type: 'FRAME_NEW_FIELDS' });
      }
    }, 600);

    if (IS_TOP) {
      if (stopRouteWatcher) stopRouteWatcher();
      stopRouteWatcher = window.Observer.startRouteWatcher(() => {
        window.ReviewPanel.showToast('New page detected — fill this page?', () => runFillPass(adapter, { force: false }));
      }, 700);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'AUTOFILL_START') {
      const adapter = pickAdapter();
      runFillPass(adapter, { force: !!message.force }).then(() => {
        offerRefillOnNewFields(adapter);
        sendResponse({ ok: true });
      });
      return true; // async response
    }
    if (message.type === 'GET_FIELD_COUNT') {
      sendResponse({ count: window.Detector.detectFields(document).length });
      return;
    }
    if (message.type === 'PULSE_LOCAL') {
      pulseLocalField(message.field_id);
      return;
    }
    if (message.type === 'CLEAR_FILLS') {
      restoreSnapshot();
      return;
    }
    if (!IS_TOP) return;

    // --- Top-frame-only handlers (relayed by the background worker) ---
    if (message.type === 'MERGE_RECORDS') {
      mergeRecords(String(message.frameId), message.records || []);
      return;
    }
    if (message.type === 'SHOW_TOAST') {
      window.ReviewPanel.showToast(message.message);
      return;
    }
    if (message.type === 'FRAME_NEW_FIELDS_TOAST') {
      window.ReviewPanel.showToast('New fields detected in an embedded form — fill them?', () => {
        chrome.runtime.sendMessage({ type: 'FILL_FRAME', frameId: message.frameId });
      });
    }
  });
})();
