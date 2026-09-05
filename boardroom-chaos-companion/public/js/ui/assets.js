import { getState } from "../store.js";
import { escapeHtml } from "../helpers.js";
import { propertyCard } from "./shared.js";

export function renderAssets() {
  const state = getState();
  const groups = [...new Set(state.properties.map(p => p.group))];
  return `<section class="page">
    <div class="section-head"><div><p class="eyebrow">Property register</p><h1>Assets and improvements</h1><p>Ownership percentages must total 100%. Houses use 0–4; 5 represents a hotel.</p></div></div>
    <div class="group-summary">${groups.map(group => {
      const props = state.properties.filter(p => p.group === group);
      const owned = props.filter(p => p.ownerShares.length).length;
      return `<div><span>${escapeHtml(group)}</span><strong>${owned}/${props.length}</strong></div>`;
    }).join("")}</div>
    <div class="property-grid">${state.properties.map(propertyCard).join("")}</div>
  </section>`;
}
