(function () {
  'use strict';

  const bankStatusEl = document.getElementById('bank-status');
  const presetStatusEl = document.getElementById('preset-status');
  const fillBtn = document.getElementById('fill-btn');
  const resultEl = document.getElementById('result');
  const openOptionsLink = document.getElementById('open-options');

  function isPlaceholder(v) {
    return typeof v === 'string' && /^\s*«.*»\s*$/.test(v);
  }

  chrome.storage.local.get(['answerBank', 'settings'], ({ answerBank, settings }) => {
    if (!answerBank) {
      bankStatusEl.textContent = 'No answer bank loaded — open Options.';
      bankStatusEl.className = 'status-row warn';
      fillBtn.disabled = true;
    } else {
      const placeholders = countPlaceholders(answerBank);
      bankStatusEl.textContent = placeholders === 0 ? 'Answer bank loaded.' : `Answer bank loaded (${placeholders} fields still need Emily's input).`;
      bankStatusEl.className = placeholders === 0 ? 'status-row ok' : 'status-row warn';
    }

    const status = settings && settings.immigrationStatus;
    if (!status) {
      presetStatusEl.textContent = 'No work-authorization preset selected.';
      presetStatusEl.className = 'status-row warn';
    } else {
      presetStatusEl.textContent = `Work-auth preset: ${status.replace(/_/g, ' ')}`;
      presetStatusEl.className = 'status-row ok';
    }
  });

  function countPlaceholders(obj) {
    let count = 0;
    JSON.stringify(obj, (key, value) => {
      if (isPlaceholder(value)) count += 1;
      return value;
    });
    return count;
  }

  fillBtn.addEventListener('click', () => {
    fillBtn.disabled = true;
    resultEl.textContent = 'Filling…';
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.id) {
        resultEl.textContent = 'No active tab.';
        fillBtn.disabled = false;
        return;
      }
      chrome.tabs.sendMessage(tab.id, { type: 'AUTOFILL_START' }, (response) => {
        fillBtn.disabled = false;
        if (chrome.runtime.lastError) {
          resultEl.textContent = 'Could not reach this page (try reloading it).';
          return;
        }
        resultEl.textContent = 'Review panel opened on the page.';
      });
    });
  });

  openOptionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
})();
