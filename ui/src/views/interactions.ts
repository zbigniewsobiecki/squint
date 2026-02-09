import type { ApiClient } from '../api/client';
import type { ChordSelectEvent } from '../d3/chord-diagram';
import { renderChordDiagram } from '../d3/chord-diagram';
import type { Store } from '../state/store';
import type { Interaction } from '../types/api';

export function initInteractions(store: Store, _api: ApiClient) {
  const state = store.getState();
  const data = state.interactionsData;

  if (!data || data.interactions.length === 0) {
    showEmptyState();
    return;
  }

  const container = document.getElementById('graph-container');
  if (!container) return;

  container.innerHTML = `
    <div class="chord-container" id="chord-main">
      <svg id="chord-svg"></svg>
      <div class="chord-sidebar hidden" id="chord-sidebar"></div>
    </div>
  `;

  // Build color index map from module data for consistent cross-view coloring
  const colorIndexByModuleId = new Map<number, number>();
  const dagData = state.flowsDagData;
  if (dagData) {
    for (const m of dagData.modules) {
      colorIndexByModuleId.set(m.id, m.colorIndex ?? 0);
    }
  }

  renderChordDiagram('#chord-svg', '#chord-main', data.interactions, onChordSelect, colorIndexByModuleId);
}

function onChordSelect(event: ChordSelectEvent) {
  const sidebar = document.getElementById('chord-sidebar');
  if (!sidebar) return;

  if (event === null) {
    sidebar.classList.add('hidden');
    return;
  }

  if (event.kind === 'module') {
    const mod = event.module;
    sidebar.innerHTML = `
      <div class="chord-sidebar-header">
        <h3>${escapeHtml(mod.name)}</h3>
        <span class="chord-sidebar-path">${escapeHtml(mod.fullPath)}</span>
      </div>
      <div class="chord-sidebar-list">
        <div class="chord-sidebar-list-title">${event.interactions.length} interaction${event.interactions.length !== 1 ? 's' : ''}</div>
        <div class="chord-sidebar-list-items">
          ${event.interactions.map((ix) => renderInteractionItem(ix)).join('')}
        </div>
      </div>
    `;
  } else {
    sidebar.innerHTML = `
      <div class="chord-sidebar-header">
        <h3>${escapeHtml(event.from.name)} → ${escapeHtml(event.to.name)}</h3>
        <span class="chord-sidebar-path">${escapeHtml(event.from.fullPath)} → ${escapeHtml(event.to.fullPath)}</span>
      </div>
      <div class="chord-sidebar-list">
        <div class="chord-sidebar-list-title">${event.interactions.length} interaction${event.interactions.length !== 1 ? 's' : ''}</div>
        <div class="chord-sidebar-list-items">
          ${event.interactions.map((ix) => renderInteractionItem(ix)).join('')}
        </div>
      </div>
    `;
  }

  sidebar.classList.remove('hidden');
}

function renderInteractionItem(ix: Interaction): string {
  const fromName = ix.fromModulePath.split('.').pop() || ix.fromModulePath;
  const toName = ix.toModulePath.split('.').pop() || ix.toModulePath;
  const patternClass = ix.pattern === 'business' ? 'business' : 'utility';
  const dirLabel = ix.direction === 'bi' ? '↔' : '→';
  const symbols = ix.symbols ? ix.symbols.split(',').map((s) => s.trim()) : [];

  return `
    <div class="chord-sidebar-item">
      <div class="chord-sidebar-item-header">
        <span class="chord-sidebar-module">${escapeHtml(fromName)}</span>
        <span class="chord-sidebar-arrow">${dirLabel}</span>
        <span class="chord-sidebar-module">${escapeHtml(toName)}</span>
        <span class="chord-sidebar-badge ${patternClass}">${ix.pattern || 'utility'}</span>
        <span class="chord-sidebar-badge weight">×${ix.weight}</span>
      </div>
      ${ix.semantic ? `<div class="chord-sidebar-semantic">${escapeHtml(ix.semantic)}</div>` : ''}
      ${symbols.length > 0 ? `<div class="chord-sidebar-symbols">${symbols.map((s) => `<span class="chord-sidebar-symbol">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
    </div>
  `;
}

function showEmptyState() {
  const container = document.getElementById('graph-container');
  if (container) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>No interactions found</h2>
        <p>Run 'ats llm interactions' to detect interactions first</p>
      </div>
    `;
  }
}

function escapeHtml(text: string): string {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}
