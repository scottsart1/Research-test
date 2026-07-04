/**
 * service-worker.js — Claude API calls + message routing (spec §2, §5 Tier 4, §9).
 *
 * Classic (non-module) service worker so importScripts() can load the same
 * pure lib/ modules the content scripts use, letting this file independently
 * re-verify the work-auth exclusion rule (spec §4.3 rule 3) instead of
 * trusting the caller. Defense in depth: even if content-main.js had a bug
 * that let a work-auth field reach here, this file refuses to send it to
 * the API or accept an answer_key that resolves into the work-auth/
 * immigration_status namespace.
 */
importScripts('../lib/fuzzy.js', '../lib/workauth-matcher.js', '../lib/resume-utils.js');

const BUNDLED_RESUME_PATH = 'assets/Resume_Emily_Terry.pdf';

const DEFAULT_SETTINGS = {
  immigrationStatus: '',
  apiEnabled: false,
  apiKey: '',
  thresholds: { fuzzyFill: 0.72, fuzzyWarn: 0.55 },
  atsToggles: {},
};

const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(['answerBank', 'settings']);
  if (!existing.answerBank) {
    try {
      const url = chrome.runtime.getURL('data/default-answer-bank.json');
      const resp = await fetch(url);
      const defaultBank = await resp.json();
      await chrome.storage.local.set({ answerBank: defaultBank });
    } catch (e) {
      // If the fetch fails, options.js will still let the user paste/import
      // a bank manually — never leave the extension unusable.
    }
  }
  if (!existing.settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  }

  const existingResume = await chrome.storage.local.get(['resumeFile']);
  if (!existingResume.resumeFile) {
    try {
      const url = chrome.runtime.getURL(BUNDLED_RESUME_PATH);
      const resp = await fetch(url);
      const buf = await resp.arrayBuffer();
      const base64 = ResumeUtils.bytesToBase64(new Uint8Array(buf));
      await chrome.storage.local.set({
        resumeFile: {
          name: 'Resume_Emily_Terry.pdf',
          type: 'application/pdf',
          base64,
          size: buf.byteLength,
          source: 'bundled',
        },
      });
    } catch (e) {
      // No bundled resume available — file inputs fall back to
      // "attach manually" until one is uploaded on the options page.
    }
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'trigger-fill') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'AUTOFILL_START' });
  });
});

function isWorkAuthLabel(labelText, contextText) {
  const hay = `${labelText || ''} ${contextText || ''}`.toLowerCase();
  return /work authoriz|sponsor|visa status|immigration status|citizenship status|\bcitizen\b|permanent resident|green card|\blpr\b/.test(hay);
}

async function callClaudeHaiku(apiKey, fields, catalog) {
  const system = [
    'You map job-application form questions to answer-bank keys. You NEVER invent answer values.',
    'You are given a list of fields (field_id, label_text, context_text, options) and a catalog of valid bank keys.',
    'For each field, choose the single best matching key from the catalog, or null if none fits.',
    'Never choose a key related to work authorization, sponsorship, visa, or citizenship — those are always null.',
    'Respond with ONLY a JSON array, no prose, no markdown fences: [{"field_id": "...", "answer_key": "..."|null, "confidence": 0.0-1.0}]',
  ].join(' ');

  const userContent = JSON.stringify({ fields, catalog });

  const resp = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!resp.ok) {
    throw new Error(`Claude API error ${resp.status}`);
  }
  const data = await resp.json();
  const text = (data.content || []).map((b) => b.text || '').join('');
  const cleaned = text.replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new Error('Claude response was not a JSON array');
  return parsed;
}

async function handleResolveTier4(message) {
  const { settings } = await chrome.storage.local.get(['settings']);
  const cfg = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  if (!cfg.apiEnabled || !cfg.apiKey) return { results: [] };

  const safeFields = (message.fields || []).filter((f) => !isWorkAuthLabel(f.label_text, f.context_text));
  if (safeFields.length === 0) return { results: [] };

  const safeCatalog = (message.catalog || []).filter(
    (k) => !k.startsWith('work_auth') && !k.startsWith('immigration_status')
  );

  try {
    const raw = await callClaudeHaiku(cfg.apiKey, safeFields, safeCatalog);
    const results = raw
      .filter((r) => r && r.field_id)
      .filter((r) => !r.answer_key || !(r.answer_key.startsWith('work_auth') || r.answer_key.startsWith('immigration_status')))
      .map((r) => ({ field_id: r.field_id, answer_key: r.answer_key || null, confidence: typeof r.confidence === 'number' ? r.confidence : 0 }));
    return { results };
  } catch (e) {
    return { results: [], error: String(e && e.message) };
  }
}

async function handlePersistPanelState(message, sender) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;
  const key = `panelState:${tabId}`;
  const existing = await chrome.storage.session.get([key]);
  const pages = (existing[key] && existing[key].pages) || {};
  pages[message.page] = message.records;
  await chrome.storage.session.set({ [key]: { pages, updatedAt: Date.now() } });
}

// ---------------------------------------------------------------------
// Cross-frame relay: iframe-heavy ATSs (iCIMS, legacy Taleo,
// SuccessFactors) run the content script in every frame, but only the top
// frame renders the review panel. Child-frame results, pulse requests, and
// clear-fills all route through here because sibling frames cannot message
// each other directly. sender.frameId identifies the child; frameId 0 is
// always the top frame.
// ---------------------------------------------------------------------

function relayToFrame(tabId, frameId, message) {
  chrome.tabs.sendMessage(tabId, message, { frameId }, () => {
    // Swallow "no receiving end" — the frame may have navigated away.
    void chrome.runtime.lastError;
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RESOLVE_TIER4') {
    handleResolveTier4(message).then(sendResponse);
    return true;
  }
  if (message.type === 'PERSIST_PANEL_STATE') {
    handlePersistPanelState(message, sender).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'GET_PANEL_STATE') {
    const tabId = message.tabId;
    chrome.storage.session.get([`panelState:${tabId}`]).then((data) => {
      sendResponse(data[`panelState:${tabId}`] || { pages: {} });
    });
    return true;
  }

  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;

  if (message.type === 'FRAME_RECORDS') {
    relayToFrame(tabId, 0, { type: 'MERGE_RECORDS', frameId: sender.frameId, records: message.records });
    return;
  }
  if (message.type === 'FRAME_TOAST') {
    relayToFrame(tabId, 0, { type: 'SHOW_TOAST', message: message.message });
    return;
  }
  if (message.type === 'FRAME_NEW_FIELDS') {
    relayToFrame(tabId, 0, { type: 'FRAME_NEW_FIELDS_TOAST', frameId: sender.frameId });
    return;
  }
  if (message.type === 'PULSE_FIELD') {
    relayToFrame(tabId, Number(message.frameId), { type: 'PULSE_LOCAL', field_id: message.field_id });
    return;
  }
  if (message.type === 'FILL_FRAME') {
    relayToFrame(tabId, Number(message.frameId), { type: 'AUTOFILL_START' });
    return;
  }
  if (message.type === 'CLEAR_FILLS_BROADCAST') {
    // No frameId option -> delivered to every frame in the tab.
    chrome.tabs.sendMessage(tabId, { type: 'CLEAR_FILLS' }, () => {
      void chrome.runtime.lastError;
    });
  }
});
