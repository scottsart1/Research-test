(function () {
  'use strict';

  const ATS_NAMES = [
    'generic', 'workday', 'greenhouse', 'icims', 'taleo-legacy', 'oracle-recruiting-cloud',
    'lever', 'ashby', 'smartrecruiters', 'workable', 'bamboohr', 'jobvite',
    'successfactors', 'adp-workforce-now', 'dayforce-paylocity-rippling',
  ];

  // Curated subset of bank paths exposed as simple text inputs (the "Quick
  // fields" tab). Everything else is editable via the Raw JSON tab.
  const QUICK_FIELD_GROUPS = [
    {
      title: 'Identity',
      fields: [
        ['identity.address_line1', 'Street address'],
        ['identity.zip', 'ZIP code'],
        ['identity.github', 'GitHub URL'],
        ['identity.pronouns', 'Pronouns'],
      ],
    },
    {
      title: 'Skills (confirm)',
      fields: [
        ['skills_yoe.aws', 'AWS years'],
        ['skills_yoe.spark', 'Spark years'],
        ['skills_yoe.excel', 'Excel years'],
      ],
    },
    {
      title: 'Compensation',
      fields: [
        ['compensation.desired_salary_annual', 'Desired salary (annual)'],
        ['compensation.salary_answer_text', 'Salary answer (free text)'],
        ['compensation.salary_min', 'Salary min'],
        ['compensation.salary_max', 'Salary max'],
      ],
    },
    {
      title: 'Logistics',
      fields: [
        ['logistics.available_start', 'Available start'],
        ['logistics.willing_to_relocate', 'Willing to relocate'],
        ['logistics.remote_hybrid_onsite', 'Work-location preference'],
        ['logistics.criminal_record', 'Criminal record answer'],
      ],
    },
    {
      title: 'EEO (Emily\'s choice)',
      fields: [
        ['eeo.gender', 'Gender'],
        ['eeo.race_ethnicity', 'Race/ethnicity'],
        ['eeo.hispanic_latino', 'Hispanic or Latino'],
        ['eeo.disability_status', 'Disability status'],
      ],
    },
    {
      title: 'Clearance',
      fields: [['clearance.willing_to_obtain', 'Willing to obtain clearance']],
    },
  ];

  function getByPath(obj, path) {
    return path.split('.').reduce((cur, seg) => (cur == null ? undefined : cur[seg]), obj);
  }

  function setByPath(obj, path, value) {
    const segs = path.split('.');
    let cur = obj;
    for (let i = 0; i < segs.length - 1; i++) {
      if (cur[segs[i]] == null) cur[segs[i]] = {};
      cur = cur[segs[i]];
    }
    cur[segs[segs.length - 1]] = value;
  }

  function isPlaceholder(v) {
    return typeof v === 'string' && /^\s*«.*»\s*$/.test(v);
  }

  function countPlaceholders(obj) {
    let count = 0;
    JSON.stringify(obj, (key, value) => {
      if (isPlaceholder(value)) count += 1;
      return value;
    });
    return count;
  }

  let bank = null;
  let settings = null;

  const els = {
    placeholderCount: document.getElementById('placeholder-count'),
    presetRow: document.getElementById('preset-row'),
    apiEnabled: document.getElementById('api-enabled'),
    apiKey: document.getElementById('api-key'),
    fuzzyFill: document.getElementById('fuzzy-fill'),
    fuzzyFillVal: document.getElementById('fuzzy-fill-val'),
    fuzzyWarn: document.getElementById('fuzzy-warn'),
    fuzzyWarnVal: document.getElementById('fuzzy-warn-val'),
    atsToggles: document.getElementById('ats-toggles'),
    quickFields: document.getElementById('quick-fields'),
    bankJson: document.getElementById('bank-json'),
    jsonValidation: document.getElementById('json-validation'),
    saveBtn: document.getElementById('save-btn'),
    exportBtn: document.getElementById('export-btn'),
    importInput: document.getElementById('import-input'),
    saveStatus: document.getElementById('save-status'),
    resumeStatus: document.getElementById('resume-status'),
    resumeInput: document.getElementById('resume-input'),
    resumeRemoveBtn: document.getElementById('resume-remove-btn'),
  };

  function formatBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return `${n} B`;
    return `${(n / 1024).toFixed(1)} KB`;
  }

  function renderResumeStatus(resumeFile) {
    if (!resumeFile) {
      els.resumeStatus.textContent = 'No resume stored — file-upload fields will be flagged "attach manually".';
      els.resumeStatus.className = 'status-row warn';
      return;
    }
    const sourceLabel = resumeFile.source === 'bundled' ? 'bundled default' : 'uploaded';
    els.resumeStatus.textContent = `${resumeFile.name} (${formatBytes(resumeFile.size)}, ${sourceLabel})`;
    els.resumeStatus.className = 'status-row ok';
  }

  function loadResumeStatus() {
    chrome.storage.local.get(['resumeFile'], (data) => renderResumeStatus(data.resumeFile));
  }

  els.resumeInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result);
      const base64 = window.ResumeUtils.bytesToBase64(bytes);
      const resumeFile = { name: file.name, type: file.type || 'application/pdf', base64, size: file.size, source: 'uploaded' };
      chrome.storage.local.set({ resumeFile }, () => renderResumeStatus(resumeFile));
    };
    reader.readAsArrayBuffer(file);
  });

  els.resumeRemoveBtn.addEventListener('click', () => {
    chrome.storage.local.remove('resumeFile', () => renderResumeStatus(null));
  });

  function renderAtsToggles() {
    els.atsToggles.innerHTML = '';
    ATS_NAMES.forEach((name) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = settings.atsToggles[name] !== false; // default on
      input.dataset.ats = name;
      label.appendChild(input);
      label.appendChild(document.createTextNode(name));
      els.atsToggles.appendChild(label);
    });
  }

  function renderQuickFields() {
    els.quickFields.innerHTML = '';
    QUICK_FIELD_GROUPS.forEach((group) => {
      const wrap = document.createElement('div');
      wrap.className = 'qf-group';
      const h3 = document.createElement('h3');
      h3.textContent = group.title;
      wrap.appendChild(h3);
      group.fields.forEach(([path, label]) => {
        const row = document.createElement('div');
        row.className = 'qf-row';
        const lbl = document.createElement('label');
        lbl.textContent = label;
        const input = document.createElement('input');
        input.type = 'text';
        const value = getByPath(bank, path);
        input.value = value == null ? '' : String(value);
        input.dataset.path = path;
        row.appendChild(lbl);
        row.appendChild(input);
        wrap.appendChild(row);
      });
      els.quickFields.appendChild(wrap);
    });
  }

  function renderAll() {
    els.placeholderCount.textContent = `${countPlaceholders(bank)} placeholder value(s) still need Emily's input.`;
    const checked = els.presetRow.querySelector(`input[value="${settings.immigrationStatus}"]`);
    if (checked) checked.checked = true;
    els.apiEnabled.checked = !!settings.apiEnabled;
    els.apiKey.value = settings.apiKey || '';
    els.fuzzyFill.value = settings.thresholds.fuzzyFill;
    els.fuzzyFillVal.textContent = settings.thresholds.fuzzyFill;
    els.fuzzyWarn.value = settings.thresholds.fuzzyWarn;
    els.fuzzyWarnVal.textContent = settings.thresholds.fuzzyWarn;
    renderAtsToggles();
    renderQuickFields();
    els.bankJson.value = JSON.stringify(bank, null, 2);
  }

  function collectQuickFieldsIntoBank() {
    els.quickFields.querySelectorAll('input[data-path]').forEach((input) => {
      setByPath(bank, input.dataset.path, input.value);
    });
  }

  function validateBank(candidate) {
    const required = [
      'identity', 'education', 'immigration_status', 'experience', 'skills_yoe',
      'clearance', 'federal', 'compensation', 'logistics', 'eeo', 'stock_answers', 'documents',
    ];
    const missing = required.filter((k) => !(k in candidate));
    if (missing.length > 0) return `Missing required top-level keys: ${missing.join(', ')}`;
    if (candidate.immigration_status && !['f1_opt', 'permanent_resident', 'citizen', ''].includes(candidate.immigration_status)) {
      return `immigration_status must be one of f1_opt | permanent_resident | citizen (got "${candidate.immigration_status}")`;
    }
    if (!Array.isArray(candidate.education)) return 'education must be an array';
    if (!Array.isArray(candidate.experience)) return 'experience must be an array';
    return null;
  }

  function load() {
    chrome.storage.local.get(['answerBank', 'settings'], async (data) => {
      bank = data.answerBank;
      if (!bank) {
        const resp = await fetch(chrome.runtime.getURL('data/default-answer-bank.json'));
        bank = await resp.json();
      }
      settings = Object.assign(
        { immigrationStatus: '', apiEnabled: false, apiKey: '', thresholds: { fuzzyFill: 0.72, fuzzyWarn: 0.55 }, atsToggles: {} },
        data.settings || {}
      );
      settings.thresholds = Object.assign({ fuzzyFill: 0.72, fuzzyWarn: 0.55 }, settings.thresholds || {});
      bank.immigration_status = settings.immigrationStatus || bank.immigration_status || '';
      renderAll();
    });
  }

  function save() {
    // Raw JSON tab wins if it's the active tab and parses; otherwise use
    // the quick-fields tab's edits merged into the in-memory bank.
    const jsonTabActive = document.getElementById('tab-json').classList.contains('active');
    let candidate = bank;
    if (jsonTabActive) {
      try {
        candidate = JSON.parse(els.bankJson.value);
      } catch (e) {
        els.jsonValidation.textContent = 'Invalid JSON: ' + e.message;
        els.jsonValidation.className = 'validation error';
        return;
      }
    } else {
      collectQuickFieldsIntoBank();
      candidate = bank;
    }

    const error = validateBank(candidate);
    if (error) {
      els.jsonValidation.textContent = error;
      els.jsonValidation.className = 'validation error';
      return;
    }
    els.jsonValidation.textContent = 'Valid.';
    els.jsonValidation.className = 'validation ok';
    bank = candidate;

    const preset = els.presetRow.querySelector('input[name="preset"]:checked');
    settings.immigrationStatus = preset ? preset.value : '';
    bank.immigration_status = settings.immigrationStatus;
    settings.apiEnabled = els.apiEnabled.checked;
    settings.apiKey = els.apiKey.value;
    settings.thresholds = { fuzzyFill: parseFloat(els.fuzzyFill.value), fuzzyWarn: parseFloat(els.fuzzyWarn.value) };
    settings.atsToggles = {};
    els.atsToggles.querySelectorAll('input[data-ats]').forEach((input) => {
      settings.atsToggles[input.dataset.ats] = input.checked;
    });

    chrome.storage.local.set({ answerBank: bank, settings }, () => {
      els.saveStatus.textContent = 'Saved ' + new Date().toLocaleTimeString();
      renderAll();
    });
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'json') {
        collectQuickFieldsIntoBank();
        els.bankJson.value = JSON.stringify(bank, null, 2);
      }
    });
  });

  els.fuzzyFill.addEventListener('input', () => (els.fuzzyFillVal.textContent = els.fuzzyFill.value));
  els.fuzzyWarn.addEventListener('input', () => (els.fuzzyWarnVal.textContent = els.fuzzyWarn.value));

  els.saveBtn.addEventListener('click', save);

  els.exportBtn.addEventListener('click', () => {
    collectQuickFieldsIntoBank();
    const blob = new Blob([JSON.stringify(bank, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'answer-bank.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  els.importInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const error = validateBank(parsed);
        if (error) {
          els.jsonValidation.textContent = 'Import rejected: ' + error;
          els.jsonValidation.className = 'validation error';
          return;
        }
        bank = parsed;
        renderAll();
      } catch (err) {
        els.jsonValidation.textContent = 'Import rejected: invalid JSON';
        els.jsonValidation.className = 'validation error';
      }
    };
    reader.readAsText(file);
  });

  load();
  loadResumeStatus();
})();
