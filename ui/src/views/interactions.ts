import type { ApiClient } from '../api/client';
import type { Store } from '../state/store';
import type { Interaction } from '../types/api';

export function initInteractions(store: Store, _api: ApiClient) {
  const state = store.getState();
  const data = state.interactionsData;

  if (!data || data.interactions.length === 0) {
    showEmptyState();
    return;
  }

  renderInteractionsView(store);
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

function renderInteractionsView(store: Store) {
  const state = store.getState();
  const data = state.interactionsData;
  if (!data) return;

  const container = document.getElementById('graph-container');
  if (!container) return;

  // Group interactions by pattern
  const businessInteractions: Interaction[] = [];
  const utilityInteractions: Interaction[] = [];

  for (const interaction of data.interactions) {
    if (interaction.pattern === 'business') {
      businessInteractions.push(interaction);
    } else {
      utilityInteractions.push(interaction);
    }
  }

  // Build sidebar HTML
  let sidebarHtml = '';

  if (businessInteractions.length > 0) {
    sidebarHtml += `
      <div class="pattern-group-header">Business (${businessInteractions.length})</div>
      ${businessInteractions.map((i) => renderInteractionItem(i)).join('')}
    `;
  }

  if (utilityInteractions.length > 0) {
    sidebarHtml += `
      <div class="pattern-group-header">Utility (${utilityInteractions.length})</div>
      ${utilityInteractions.map((i) => renderInteractionItem(i)).join('')}
    `;
  }

  container.innerHTML = `
    <div class="interactions-container">
      <div class="interactions-sidebar" id="interactions-sidebar">
        <div class="interactions-sidebar-header">
          <h3>Interactions</h3>
        </div>
        <div class="interactions-sidebar-content">
          ${sidebarHtml || '<div style="padding: 16px; color: #858585;">No interactions found</div>'}
        </div>
      </div>
      <div class="interactions-main" id="interactions-main">
        ${renderSummaryStats(data)}
      </div>
    </div>
  `;

  // Setup interaction clicks
  setupInteractionClicks(store);
}

function renderInteractionItem(interaction: Interaction): string {
  const fromName = interaction.fromModulePath.split('/').pop() || interaction.fromModulePath;
  const toName = interaction.toModulePath.split('/').pop() || interaction.toModulePath;
  const patternClass = interaction.pattern === 'business' ? 'business' : 'utility';

  return `
    <div class="interaction-item" data-interaction-id="${interaction.id}">
      <div class="interaction-modules">
        <span class="interaction-module">${fromName}</span>
        <span class="interaction-arrow">→</span>
        <span class="interaction-module">${toName}</span>
      </div>
      ${interaction.semantic ? `<div class="interaction-semantic">${interaction.semantic}</div>` : ''}
      <div class="interaction-meta">
        <span class="interaction-badge ${patternClass}">${interaction.pattern || 'utility'}</span>
        <span class="interaction-badge weight">×${interaction.weight}</span>
      </div>
    </div>
  `;
}

function renderSummaryStats(data: import('../types/api').InteractionsResponse): string {
  return `
    <div class="interactions-summary">
      <h2>Interactions Summary</h2>
      <p class="summary-description">Module-to-module interactions describe how different parts of the codebase communicate with each other.</p>

      <div class="summary-stats-grid">
        <div class="summary-stat-card">
          <div class="summary-stat-value">${data.stats.totalCount}</div>
          <div class="summary-stat-label">Total Interactions</div>
        </div>
        <div class="summary-stat-card">
          <div class="summary-stat-value">${data.stats.businessCount}</div>
          <div class="summary-stat-label">Business Logic</div>
        </div>
        <div class="summary-stat-card">
          <div class="summary-stat-value">${data.stats.utilityCount}</div>
          <div class="summary-stat-label">Utility/Infrastructure</div>
        </div>
        <div class="summary-stat-card">
          <div class="summary-stat-value">${data.stats.biDirectionalCount}</div>
          <div class="summary-stat-label">Bi-directional</div>
        </div>
      </div>

      <h3>Relationship Coverage</h3>
      <div class="coverage-stats">
        <div class="coverage-bar">
          <div class="coverage-fill" style="width: ${data.relationshipCoverage.coveragePercent}%"></div>
        </div>
        <div class="coverage-details">
          <span>${data.relationshipCoverage.coveragePercent.toFixed(1)}% of cross-module relationships are covered</span>
        </div>
        <div class="coverage-breakdown">
          <div class="coverage-item">
            <span class="coverage-label">Total relationships:</span>
            <span class="coverage-value">${data.relationshipCoverage.totalRelationships}</span>
          </div>
          <div class="coverage-item">
            <span class="coverage-label">Cross-module:</span>
            <span class="coverage-value">${data.relationshipCoverage.crossModuleRelationships}</span>
          </div>
          <div class="coverage-item">
            <span class="coverage-label">Contributing to interactions:</span>
            <span class="coverage-value">${data.relationshipCoverage.relationshipsContributingToInteractions}</span>
          </div>
          <div class="coverage-item">
            <span class="coverage-label">Same-module:</span>
            <span class="coverage-value">${data.relationshipCoverage.sameModuleCount}</span>
          </div>
        </div>
      </div>

      <p class="summary-hint">Select an interaction from the sidebar to view details.</p>
    </div>
  `;
}

function renderInteractionDetails(interaction: Interaction): string {
  const fromPath = interaction.fromModulePath;
  const toPath = interaction.toModulePath;
  const symbols = interaction.symbols ? interaction.symbols.split(',').map((s) => s.trim()) : [];

  return `
    <div class="interaction-details">
      <div class="interaction-details-header">
        <div class="interaction-path-flow">
          <span class="interaction-path from">${fromPath}</span>
          <span class="interaction-direction">${interaction.direction === 'bi' ? '↔' : '→'}</span>
          <span class="interaction-path to">${toPath}</span>
        </div>
      </div>

      ${interaction.semantic ? `
        <div class="interaction-description">
          <h4>Description</h4>
          <p>${interaction.semantic}</p>
        </div>
      ` : ''}

      <div class="interaction-meta-section">
        <div class="meta-item">
          <span class="meta-label">Pattern</span>
          <span class="interaction-badge ${interaction.pattern === 'business' ? 'business' : 'utility'}">${interaction.pattern || 'utility'}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Weight</span>
          <span class="meta-value">${interaction.weight} relationships</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Direction</span>
          <span class="meta-value">${interaction.direction === 'bi' ? 'Bi-directional' : 'Uni-directional'}</span>
        </div>
      </div>

      ${symbols.length > 0 ? `
        <div class="interaction-symbols">
          <h4>Connecting Symbols (${symbols.length})</h4>
          <div class="symbol-list">
            ${symbols.map((symbol) => `<span class="symbol-tag">${symbol}</span>`).join('')}
          </div>
        </div>
      ` : ''}

      <button class="back-to-summary-btn" id="back-to-summary">← Back to Summary</button>
    </div>
  `;
}

function setupInteractionClicks(store: Store) {
  document.querySelectorAll('.interaction-item').forEach((item) => {
    item.addEventListener('click', () => {
      const interactionId = Number.parseInt(item.getAttribute('data-interaction-id') || '0');
      const state = store.getState();
      const interaction = state.interactionsData?.interactions.find((i) => i.id === interactionId);

      if (!interaction) return;

      // Update selected state
      document.querySelectorAll('.interaction-item').forEach((el) => {
        el.classList.toggle('selected', el.getAttribute('data-interaction-id') === String(interactionId));
      });

      // Show details in main area
      const mainArea = document.getElementById('interactions-main');
      if (mainArea) {
        mainArea.innerHTML = renderInteractionDetails(interaction);

        // Setup back button
        document.getElementById('back-to-summary')?.addEventListener('click', () => {
          document.querySelectorAll('.interaction-item').forEach((el) => {
            el.classList.remove('selected');
          });
          if (state.interactionsData) {
            mainArea.innerHTML = renderSummaryStats(state.interactionsData);
          }
        });
      }
    });
  });
}
