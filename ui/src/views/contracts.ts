import type { ApiClient } from '../api/client';
import type { Store } from '../state/store';
import type { ContractDetail } from '../types/api';

export function initContracts(store: Store, api: ApiClient) {
  const state = store.getState();
  const container = document.getElementById('graph-container');
  if (!container) return;

  // Load contracts data if not already loaded
  if (!state.contractsData) {
    api.getContracts().then((data) => {
      store.setState({ contractsData: data });
      render(store);
    });
    return;
  }

  render(store);
}

function render(store: Store) {
  const container = document.getElementById('graph-container');
  if (!container) return;

  const data = store.getState().contractsData;
  if (!data || data.contracts.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>No contracts found</h2>
        <p>Run 'squint contracts extract' to detect API contracts first</p>
      </div>
    `;
    return;
  }

  const protocols = Object.keys(data.stats.byProtocol).sort();
  let activeProtocol: string | null = null;
  let showFilter: 'all' | 'matched' | 'unmatched' = 'all';

  function getFilteredContracts(): ContractDetail[] {
    let contracts = data!.contracts;
    if (activeProtocol) {
      contracts = contracts.filter((c) => c.protocol === activeProtocol);
    }
    if (showFilter === 'matched') {
      contracts = contracts.filter((c) => c.matched);
    } else if (showFilter === 'unmatched') {
      contracts = contracts.filter((c) => !c.matched);
    }
    return contracts;
  }

  function renderUI() {
    const contracts = getFilteredContracts();

    container!.innerHTML = `
      <div class="contracts-container">
        <div class="contracts-toolbar">
          <div class="contracts-filters">
            <button class="contracts-filter-btn ${showFilter === 'all' ? 'active' : ''}" data-filter="all">
              All (${data!.stats.total})
            </button>
            <button class="contracts-filter-btn ${showFilter === 'matched' ? 'active' : ''}" data-filter="matched">
              Matched (${data!.stats.matched})
            </button>
            <button class="contracts-filter-btn ${showFilter === 'unmatched' ? 'active' : ''}" data-filter="unmatched">
              Unmatched (${data!.stats.unmatched})
            </button>
          </div>
          <div class="contracts-protocol-tabs">
            <button class="contracts-protocol-btn ${activeProtocol === null ? 'active' : ''}" data-protocol="">All protocols</button>
            ${protocols.map((p) => `<button class="contracts-protocol-btn ${activeProtocol === p ? 'active' : ''}" data-protocol="${escapeAttr(p)}">${escapeHtml(p)} (${data!.stats.byProtocol[p]})</button>`).join('')}
          </div>
        </div>
        <div class="contracts-list">
          <div class="contracts-table-header">
            <span class="contracts-col-status">Status</span>
            <span class="contracts-col-key">Endpoint / Key</span>
            <span class="contracts-col-protocol">Protocol</span>
            <span class="contracts-col-roles">Roles</span>
            <span class="contracts-col-modules">Modules</span>
          </div>
          ${contracts.map((c) => renderContractRow(c)).join('')}
        </div>
      </div>
    `;

    // Wire filter buttons
    container!.querySelectorAll('.contracts-filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        showFilter = ((btn as HTMLElement).dataset.filter ?? 'all') as typeof showFilter;
        renderUI();
      });
    });

    // Wire protocol tabs
    container!.querySelectorAll('.contracts-protocol-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const proto = (btn as HTMLElement).dataset.protocol ?? '';
        activeProtocol = proto || null;
        renderUI();
      });
    });

    // Wire row expand/collapse
    container!.querySelectorAll('.contracts-row').forEach((row) => {
      row.addEventListener('click', () => {
        row.classList.toggle('expanded');
      });
    });
  }

  renderUI();
}

function renderContractRow(c: ContractDetail): string {
  const statusIcon = c.matched
    ? '<span class="contract-matched">\u2713</span>'
    : '<span class="contract-unmatched">\u2717</span>';
  const roles = [...new Set(c.participants.map((p) => p.role))];
  const rolesStr = roles.join(' \u2194 ');
  const modules = [
    ...new Set(c.participants.filter((p) => p.modulePath).map((p) => p.modulePath!.split('.').slice(-2).join('.'))),
  ];

  return `
    <div class="contracts-row ${c.matched ? 'matched' : 'unmatched'}">
      <div class="contracts-row-summary">
        <span class="contracts-col-status">${statusIcon}</span>
        <span class="contracts-col-key">${escapeHtml(c.normalizedKey)}</span>
        <span class="contracts-col-protocol"><span class="contracts-badge protocol">${escapeHtml(c.protocol)}</span></span>
        <span class="contracts-col-roles">${escapeHtml(rolesStr)}</span>
        <span class="contracts-col-modules">${modules.map((m) => `<span class="contracts-badge module">${escapeHtml(m)}</span>`).join(' ')}</span>
      </div>
      <div class="contracts-row-details">
        ${c.description ? `<div class="contracts-detail-desc">${escapeHtml(c.description)}</div>` : ''}
        <div class="contracts-participants">
          ${c.participants
            .map(
              (p) => `
            <div class="contracts-participant">
              <span class="contracts-participant-role">${escapeHtml(p.role)}</span>
              <span class="contracts-participant-name">${escapeHtml(p.definitionName)}</span>
              ${p.modulePath ? `<span class="contracts-participant-module">${escapeHtml(p.modulePath)}</span>` : ''}
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    </div>
  `;
}

function escapeHtml(text: string): string {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
