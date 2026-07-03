/**
 * review-panel.js — injected sidebar UI (spec §8).
 * Shadow-DOM isolated so host-page CSS can't leak in or out. Renders a
 * summary + grouped list of every filled/skipped field. Work-auth fields
 * are always listed with lock icons regardless of confidence (spec §4.3
 * rule 5) and ⚠️/⛔ entries are pinned to the top.
 */
(function (root) {
  'use strict';

  const ICONS = {
    FILLED: '✅',
    FILLED_LOW_CONFIDENCE: '⚠️',
    FILLED_UNVERIFIED: '⚠️',
    NEEDS_REVIEW: '⛔',
    UNMATCHED: '⛔',
    SKIPPED_PREFILLED: '⏭️',
    SKIPPED_UNSUPPORTED_TYPE: '⛔',
    FAILED: '⛔',
  };

  const STYLE = `
    :host { all: initial; }
    .panel {
      position: fixed; top: 0; right: 0; height: 100vh; width: 360px;
      max-width: 90vw; background: #ffffff; color: #1a1a2e;
      box-shadow: -2px 0 12px rgba(0,0,0,0.15); z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex; flex-direction: column; font-size: 13px;
    }
    @media (prefers-color-scheme: dark) {
      .panel { background: #1a1a2e; color: #f0f0f5; }
    }
    .header { padding: 14px 16px; border-bottom: 1px solid rgba(0,0,0,0.1); }
    .header h1 { font-size: 15px; margin: 0 0 6px; }
    .summary { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; }
    .summary span { padding: 2px 8px; border-radius: 10px; background: rgba(0,0,0,0.06); }
    .lock-section { padding: 10px 16px; background: rgba(255, 196, 0, 0.12); border-bottom: 1px solid rgba(0,0,0,0.08); }
    .lock-section h2 { font-size: 12px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: .04em; opacity: .8; }
    .clearance-notice { padding: 10px 16px; background: rgba(255,80,80,0.12); border-bottom: 1px solid rgba(0,0,0,0.08); font-size: 12px; }
    .list { flex: 1; overflow-y: auto; padding: 6px 0; }
    .item { padding: 8px 16px; cursor: pointer; border-bottom: 1px solid rgba(0,0,0,0.05); display: flex; gap: 8px; align-items: flex-start; }
    .item:hover { background: rgba(0,0,0,0.04); }
    .item .icon { flex-shrink: 0; }
    .item .label { font-weight: 500; line-height: 1.3; }
    .item .meta { opacity: .65; font-size: 11px; margin-top: 2px; }
    .footer { padding: 10px 16px; border-top: 1px solid rgba(0,0,0,0.1); display: flex; gap: 8px; }
    button { flex: 1; padding: 8px 10px; border-radius: 6px; border: 1px solid rgba(0,0,0,0.15); background: transparent; color: inherit; cursor: pointer; font-size: 12px; }
    button:hover { background: rgba(0,0,0,0.06); }
    .pulse { animation: pulse-anim 1s ease; }
    @keyframes pulse-anim { 0% { box-shadow: 0 0 0 0 rgba(79,70,229,0.6); } 100% { box-shadow: 0 0 0 12px rgba(79,70,229,0); } }
    .toast { position: fixed; bottom: 20px; right: 380px; background: #1a1a2e; color: #fff; padding: 10px 14px; border-radius: 8px; font-size: 12px; z-index: 2147483647; display: flex; gap: 10px; align-items: center; box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
    .toast button { flex: none; padding: 4px 10px; }
  `;

  let hostEl = null;
  let shadow = null;
  let currentOutcomes = [];

  function ensureHost() {
    if (hostEl && hostEl.isConnected) return shadow;
    hostEl = document.createElement('div');
    hostEl.id = 'autofill-review-panel-host';
    document.documentElement.appendChild(hostEl);
    shadow = hostEl.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    shadow.appendChild(style);
    const panel = document.createElement('div');
    panel.className = 'panel';
    shadow.appendChild(panel);
    return shadow;
  }

  function categoryLabel(category) {
    return String(category || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }

  function render(outcomes, handlers) {
    handlers = handlers || {};
    currentOutcomes = outcomes;
    const sh = ensureHost();
    const panel = sh.querySelector('.panel');

    const filled = outcomes.filter((o) => o.status === 'FILLED').length;
    const warnings = outcomes.filter((o) => o.status === 'FILLED_LOW_CONFIDENCE' || o.status === 'FILLED_UNVERIFIED').length;
    const review = outcomes.filter((o) => o.status === 'NEEDS_REVIEW' || o.status === 'UNMATCHED' || o.status === 'FAILED').length;
    const lockItems = outcomes.filter((o) => o.lockIcon);
    const clearanceFlag = outcomes.some((o) => o.category === 'clearance' && o.clearanceRequiredNotice);

    const others = outcomes.filter((o) => !o.lockIcon);
    const sorted = [...others].sort((a, b) => rank(a) - rank(b));

    panel.innerHTML = '';

    const header = document.createElement('div');
    header.className = 'header';
    header.innerHTML = `<h1>Autofill review</h1>
      <div class="summary">
        <span>✅ ${filled} filled</span>
        <span>⚠️ ${warnings} low-confidence</span>
        <span>⛔ ${review} need review</span>
      </div>`;
    panel.appendChild(header);

    if (clearanceFlag) {
      const notice = document.createElement('div');
      notice.className = 'clearance-notice';
      notice.textContent = '⚠️ This posting appears to require an active security clearance. Review before applying.';
      panel.appendChild(notice);
    }

    if (lockItems.length > 0) {
      const lockSection = document.createElement('div');
      lockSection.className = 'lock-section';
      lockSection.innerHTML = '<h2>🔒 Work authorization (always shown)</h2>';
      lockItems.forEach((o) => lockSection.appendChild(renderItem(o, handlers)));
      panel.appendChild(lockSection);
    }

    const list = document.createElement('div');
    list.className = 'list';
    sorted.forEach((o) => list.appendChild(renderItem(o, handlers)));
    panel.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'footer';
    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear all fills';
    clearBtn.addEventListener('click', () => handlers.onClearAll && handlers.onClearAll());
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy skipped questions';
    copyBtn.addEventListener('click', () => {
      const skipped = outcomes.filter((o) => o.status === 'NEEDS_REVIEW' || o.status === 'UNMATCHED');
      const text = skipped.map((o) => `- ${o.label_text || o.field_id}`).join('\n');
      navigator.clipboard && navigator.clipboard.writeText(text);
      handlers.onCopySkipped && handlers.onCopySkipped(text);
    });
    footer.appendChild(clearBtn);
    footer.appendChild(copyBtn);
    panel.appendChild(footer);
  }

  function rank(o) {
    if (o.status === 'NEEDS_REVIEW' || o.status === 'UNMATCHED' || o.status === 'FAILED') return 0;
    if (o.status === 'FILLED_LOW_CONFIDENCE' || o.status === 'FILLED_UNVERIFIED') return 1;
    return 2;
  }

  function renderItem(o, handlers) {
    const item = document.createElement('div');
    item.className = 'item';
    const icon = document.createElement('div');
    icon.className = 'icon';
    icon.textContent = (o.lockIcon ? '🔒 ' : '') + (ICONS[o.status] || '•');
    const body = document.createElement('div');
    body.innerHTML = `<div class="label">${escapeHtml(o.label_text || o.field_id)}</div>
      <div class="meta">${escapeHtml(categoryLabel(o.category))}${o.value ? ' — ' + escapeHtml(String(o.value)) : ''}</div>`;
    item.appendChild(icon);
    item.appendChild(body);
    item.addEventListener('click', () => handlers.onItemClick && handlers.onItemClick(o));
    return item;
  }

  function escapeHtml(s) {
    const div = document.createElement('div');
    div.textContent = s;
    return div.innerHTML;
  }

  function pulseElement(el) {
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('pulse');
    setTimeout(() => el.classList.remove('pulse'), 1000);
  }

  function showToast(message, onAccept, onDismiss) {
    const sh = ensureHost();
    const existing = sh.querySelector('.toast');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = 'toast';
    const span = document.createElement('span');
    span.textContent = message;
    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Fill this page';
    acceptBtn.addEventListener('click', () => {
      toast.remove();
      onAccept && onAccept();
    });
    const dismissBtn = document.createElement('button');
    dismissBtn.textContent = 'Dismiss';
    dismissBtn.addEventListener('click', () => {
      toast.remove();
      onDismiss && onDismiss();
    });
    toast.appendChild(span);
    toast.appendChild(acceptBtn);
    toast.appendChild(dismissBtn);
    sh.appendChild(toast);
  }

  function destroy() {
    if (hostEl) hostEl.remove();
    hostEl = null;
    shadow = null;
  }

  const ReviewPanel = { render, pulseElement, showToast, destroy };
  root.ReviewPanel = ReviewPanel;
})(typeof window !== 'undefined' ? window : this);
