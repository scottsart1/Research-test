/**
 * content-main.js — orchestrator (spec §2 "Flow").
 *
 * popup "Fill" (or Alt+Shift+F) -> detector collects FieldDescriptor[] ->
 * matcher (Tier 1-3 local, Tier 4 batched API) -> filler writes with proper
 * events -> verification pass -> review panel renders ✅/⚠️/⛔.
 *
 * This file never calls a submit control and never auto-advances a
 * multi-step form (spec §11#10) — it only fills the fields visible on the
 * current page and offers (never forces) a refill when new fields appear.
 */
(function () {
  'use strict';

  let hasWaitedForPrefill = false;
  let stopFieldWatcher = null;
  let stopRouteWatcher = null;
  let lastFillSnapshot = []; // for "Clear all fills"

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
      'education.0.school', 'education.0.degree', 'education.0.field', 'education.0.gpa', 'education.0.end',
      'highest_education', 'total_professional_years', 'skills_flat_list', 'certifications',
      'clearance.has_clearance', 'clearance.clearance_level', 'clearance.willing_to_obtain', 'clearance.held_clearance_past',
      'federal.current_federal_employee', 'federal.former_federal_employee', 'federal.special_hiring_authority',
      'compensation.desired_salary_annual', 'compensation.salary_answer_text',
      'logistics.available_start', 'logistics.willing_to_relocate', 'logistics.remote_hybrid_onsite',
      'logistics.over_18', 'logistics.worked_here_before', 'logistics.relatives_at_company',
      'logistics.non_compete', 'logistics.background_check_consent', 'logistics.drug_test_consent',
      'logistics.criminal_record', 'logistics.military_veteran_service',
      'eeo.gender', 'eeo.race_ethnicity', 'eeo.hispanic_latino', 'eeo.veteran_status', 'eeo.disability_status',
    ];
  }

  async function resolveTier4(unmatchedFields, bank) {
    if (unmatchedFields.length === 0) return {};
    const { settings } = await loadSettings();
    if (!settings.apiEnabled) return {};
    const payload = unmatchedFields.map((f) => ({
      field_id: f.id,
      label_text: f.label_text,
      context_text: f.context_text,
      options: f.options,
    }));
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'RESOLVE_TIER4', fields: payload, catalog: bankKeyCatalog() },
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

  function buildOutcomeRecord(field, matchResult, fillOutcome) {
    return {
      field_id: field.id,
      label_text: field.label_text,
      category: matchResult.category,
      value: matchResult.value,
      lockIcon: !!matchResult.lockIcon,
      status: fillOutcome ? fillOutcome.outcome : matchResult.status,
      note: fillOutcome && fillOutcome.note,
      __field: field,
    };
  }

  async function runFillPass(adapter, opts) {
    opts = opts || {};
    const { bank, settings } = await loadSettings();
    if (!bank) {
      window.ReviewPanel.showToast('No answer bank configured — open the extension options page first.');
      return;
    }
    if (!settings.immigrationStatus) {
      window.ReviewPanel.showToast('No work-authorization preset selected in options — those questions will be flagged for review.');
    }

    if (adapter.isOutOfScope && adapter.isOutOfScope()) {
      window.ReviewPanel.showToast('This page (account creation) is out of scope — nothing was filled.');
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

    const results = fields.map((field) => ({
      field,
      match: window.Matcher.matchField(field, bank, {
        immigrationStatus: settings.immigrationStatus,
        thresholds: settings.thresholds,
      }),
    }));

    const unmatched = results.filter((r) => r.match.status === 'UNMATCHED' && r.match.category !== 'work_auth');
    const tier4Results = await resolveTier4(unmatched.map((r) => r.field), bank);
    for (const r of results) {
      const apiHit = tier4Results[r.field.id];
      if (r.match.status === 'UNMATCHED' && apiHit) {
        r.match = window.Matcher.resolveApiKey(r.field, bank, apiHit.answer_key, apiHit.confidence);
      }
    }

    const toFill = results.filter((r) => r.match.status === 'FILL' || r.match.status === 'FILL_LOW_CONFIDENCE');
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

    renderPanel(records);
    persistState(records);
  }

  function renderPanel(records) {
    window.ReviewPanel.render(records, {
      onItemClick: (record) => {
        const el = record.__field && record.__field.__elements && record.__field.__elements[0];
        window.ReviewPanel.pulseElement(el);
      },
      onClearAll: () => {
        restoreSnapshot();
        renderPanel([]);
      },
      onCopySkipped: () => {},
    });
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
      window.ReviewPanel.showToast('New fields detected on this page.', () => runFillPass(adapter, { force: false }));
    }, 600);

    if (stopRouteWatcher) stopRouteWatcher();
    stopRouteWatcher = window.Observer.startRouteWatcher(() => {
      window.ReviewPanel.showToast('New page detected — fill this page?', () => runFillPass(adapter, { force: false }));
    }, 700);
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
    }
  });
})();
