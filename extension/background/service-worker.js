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
  apiModel: 'claude-haiku-4-5-20251001',
  aiDraftEnabled: true,
  thresholds: { fuzzyFill: 0.72, fuzzyWarn: 0.55 },
  atsToggles: {},
};

const ALLOWED_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-5'];
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

/**
 * Candidate profile sent to the model so it can draft grounded qualitative
 * answers. Whitelisted sections only: education, experience, skills, and
 * scheduling logistics. Deliberately excluded: email/phone/street address
 * (not needed to write an answer), EEO demographics, immigration status,
 * clearance details, and salary figures — those categories are either
 * attestations the AI must never speak for, or map-only keys.
 */
function buildCandidateProfile(bank) {
  if (!bank) return null;
  const scrub = (v) => (typeof v === 'string' && /^\s*«.*»\s*$/.test(v) ? undefined : v);
  const identity = bank.identity || {};
  const logistics = bank.logistics || {};
  return {
    name: scrub(identity.full_name),
    location: [scrub(identity.city), scrub(identity.state_abbr)].filter(Boolean).join(', '),
    linkedin: scrub(identity.linkedin),
    portfolio: scrub(identity.portfolio),
    education: (bank.education || []).map((e) => ({
      school: e.school, degree: e.degree, field: e.field, gpa: e.gpa, start: e.start, end: e.end,
    })),
    experience: (bank.experience || []).map((x) => ({
      title: x.title, company: x.company, start: x.start, end: x.end, summary: x.summary,
    })),
    skills: scrub(bank.skills_flat_list),
    certifications: scrub(bank.certifications),
    total_professional_years: scrub(bank.total_professional_years),
    availability: scrub(logistics.available_start),
    work_preferences: {
      relocate: scrub(logistics.willing_to_relocate),
      arrangement: scrub(logistics.remote_hybrid_onsite),
      travel: scrub(logistics.willing_to_travel),
      employment_type: scrub(logistics.employment_type),
    },
  };
}

function buildSystemPrompt(draftEnabled) {
  const lines = [
    'You fill job-application form fields for one real candidate. For each field, first work out what the question is ACTUALLY asking — do not pattern-match on keywords — then return exactly one action:',
    '- "map": the factual answer already exists in the answer_key_catalog. Return that key in answer_key.',
    '- "option": the correct choice for this candidate is one of the field\'s listed options. Return it in option, copied VERBATIM from the options array.',
  ];
  if (draftEnabled) {
    lines.push(
      '- "draft": the question is qualitative or open-ended (motivation, fit, reason for leaving, cover-letter-style, "tell us about...", project descriptions). Write the candidate\'s answer in first person in draft. Ground every claim strictly in candidate_profile and job_context — never invent employers, dates, degrees, skills, tools, metrics, or anecdotes that are not in the profile. If the question asks for something the profile does not contain, use "skip" instead of inventing. 2-5 sentences unless the question clearly wants more or less. Specific and professional; no filler like "I am a passionate team player".'
    );
  }
  lines.push(
    '- "skip": use this for anything about work authorization, citizenship, visas, sponsorship, security clearance, EEO demographics (gender, race, ethnicity, veteran or disability status), salary or compensation figures, criminal history, legal attestations, logins or passwords — and whenever you are unsure. A skipped field is flagged for the human; a wrong answer is worse than no answer.',
    'Every result needs a confidence from 0 to 1 reflecting how certain you are that the action and content are what this candidate should submit.',
    'Respond with ONLY a JSON array, no prose, no markdown fences: [{"field_id": "...", "action": "map"|"option"|"draft"|"skip", "answer_key": "..."|null, "option": "..."|null, "draft": "..."|null, "confidence": 0.0-1.0}]'
  );
  return lines.join('\n');
}

async function callClaude(cfg, payload) {
  const model = ALLOWED_MODELS.includes(cfg.apiModel) ? cfg.apiModel : ALLOWED_MODELS[0];
  const resp = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: buildSystemPrompt(cfg.aiDraftEnabled),
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
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
  const { settings, answerBank } = await chrome.storage.local.get(['settings', 'answerBank']);
  const cfg = Object.assign({}, DEFAULT_SETTINGS, settings || {});
  if (!cfg.apiEnabled || !cfg.apiKey) return { results: [] };

  const safeFields = (message.fields || []).filter((f) => !isWorkAuthLabel(f.label_text, f.context_text));
  if (safeFields.length === 0) return { results: [] };

  const safeCatalog = (message.catalog || []).filter(
    (k) => !k.startsWith('work_auth') && !k.startsWith('immigration_status')
  );

  const payload = {
    job_context: {
      page_title: String((message.job_context && message.job_context.page_title) || '').slice(0, 300),
      page_excerpt: String((message.job_context && message.job_context.page_excerpt) || '').slice(0, 2500),
    },
    candidate_profile: buildCandidateProfile(answerBank),
    answer_key_catalog: safeCatalog,
    fields: safeFields,
  };

  try {
    const raw = await callClaude(cfg, payload);
    const results = raw
      .filter((r) => r && r.field_id && r.action)
      // Drafts stripped here too when the toggle is off — belt and braces
      // with the prompt-side omission of the draft action.
      .filter((r) => cfg.aiDraftEnabled || r.action !== 'draft')
      .filter((r) => !r.answer_key || !(r.answer_key.startsWith('work_auth') || r.answer_key.startsWith('immigration_status')))
      .map((r) => ({
        field_id: r.field_id,
        action: r.action,
        answer_key: r.answer_key || null,
        option: r.option || null,
        draft: r.draft || null,
        confidence: typeof r.confidence === 'number' ? r.confidence : 0,
      }));
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
