import type { ApiClient } from '../api/client';
import type { InteractionMapSelectEvent } from '../d3/interaction-map';
import { renderInteractionMap } from '../d3/interaction-map';
import type { Store } from '../state/store';
import type { Interaction } from '../types/api';

export function initInteractions(store: Store, _api: ApiClient) {
  const state = store.getState();
  const data = state.interactionsData;

  if (!data || data.interactions.length === 0) {
    showEmptyState();
    return;
  }

  const dagData = state.flowsDagData;
  if (!dagData || dagData.modules.length === 0) {
    showEmptyState();
    return;
  }

  const container = document.getElementById('graph-container');
  if (!container) return;

  // Build process group summary
  const pg = data.processGroups;
  const processGroupHtml =
    pg && pg.groupCount >= 2
      ? `<div class="process-group-summary">${pg.groupCount} process groups: ${pg.groups.map((g) => g.label).join(', ')}</div>`
      : '';

  container.innerHTML = `
    ${processGroupHtml}
    <div class="imap-container" id="imap-main">
      <div class="imap-controls">
        <button class="imap-filter-btn active" data-filter="business">Business</button>
        <button class="imap-filter-btn active" data-filter="utility">Utility</button>
      </div>
      <svg id="imap-svg"></svg>
      <div class="chord-sidebar hidden" id="imap-sidebar"></div>
      <div class="keyboard-hint">
        <kbd>Click</kbd> module to select &nbsp; <kbd>Click</kbd> background to deselect/zoom out &nbsp; <kbd>Hover</kbd> to preview interactions
      </div>
    </div>
  `;

  // Filter state
  const activeFilters = { business: true, utility: true };

  function getFilteredInteractions(): Interaction[] {
    return data!.interactions.filter((ix) => {
      if (ix.pattern === 'business' && !activeFilters.business) return false;
      if (ix.pattern !== 'business' && !activeFilters.utility) return false;
      return true;
    });
  }

  function render() {
    renderInteractionMap('#imap-svg', '#imap-main', dagData!.modules, getFilteredInteractions(), onMapSelect);
  }

  // Filter button handlers
  const filterBtns = container.querySelectorAll('.imap-filter-btn');
  for (const btn of filterBtns) {
    btn.addEventListener('click', () => {
      const filter = (btn as HTMLElement).dataset.filter as 'business' | 'utility';
      activeFilters[filter] = !activeFilters[filter];
      btn.classList.toggle('active', activeFilters[filter]);
      render();
    });
  }

  // Initial render
  render();
}

function onMapSelect(event: InteractionMapSelectEvent) {
  const sidebar = document.getElementById('imap-sidebar');
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
        <h3>${escapeHtml(event.from.name)} &rarr; ${escapeHtml(event.to.name)}</h3>
        <span class="chord-sidebar-path">${escapeHtml(event.from.fullPath)} &rarr; ${escapeHtml(event.to.fullPath)}</span>
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
  const dirLabel = ix.direction === 'bi' ? '\u2194' : '\u2192';
  const symbols = ix.symbols ? ix.symbols.split(',').map((s) => s.trim()) : [];
  const sourceLabel = ix.source === 'llm-inferred' ? 'inferred' : 'ast';
  const sourceClass = ix.source === 'llm-inferred' ? 'inferred' : 'ast';

  return `
    <div class="chord-sidebar-item">
      <div class="chord-sidebar-item-header">
        <span class="chord-sidebar-module">${escapeHtml(fromName)}</span>
        <span class="chord-sidebar-arrow">${dirLabel}</span>
        <span class="chord-sidebar-module">${escapeHtml(toName)}</span>
        <span class="chord-sidebar-badge ${patternClass}">${ix.pattern || 'utility'}</span>
        <span class="chord-sidebar-badge weight">\u00d7${ix.weight}</span>
        <span class="chord-sidebar-badge ${sourceClass}">${sourceLabel}</span>
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
        <p>Run 'squint llm interactions' to detect interactions first</p>
      </div>
    `;
  }
}

function escapeHtml(text: string): string {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}
