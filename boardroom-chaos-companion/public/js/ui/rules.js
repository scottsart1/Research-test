import { RULES, RULEBOOK_VERSION } from "../../rules.js";
import { escapeHtml } from "../helpers.js";

export function renderRules() {
  const categories = [...new Set(RULES.map(rule => rule.category))];
  const anchor = category => `rule-${category.toLowerCase().replaceAll(" ", "-")}`;
  return `<section class="page rules-page">
    <div class="section-head"><div><p class="eyebrow">Version ${RULEBOOK_VERSION}</p><h1>Corporate Chaos House Rules</h1><p>Conventional Monopoly remains the baseline. These rules govern the extra nonsense.</p></div></div>
    <div class="rule-index">${categories.map(category => `<a href="#${anchor(category)}">${escapeHtml(category)}</a>`).join("")}</div>
    ${categories.map(category => `<section class="rule-category" id="${anchor(category)}"><h2>${escapeHtml(category)}</h2>${RULES.filter(rule => rule.category === category).map(rule => `<article class="rule"><span>${rule.id}</span><div><h3>${escapeHtml(rule.title)}</h3><p>${escapeHtml(rule.text)}</p></div></article>`).join("")}</section>`).join("")}
    <div class="callout silly"><strong>Supreme administrative principle:</strong> Personal grudges should expire when the game ends. Corporate grudges may survive one snack break.</div>
  </section>`;
}
