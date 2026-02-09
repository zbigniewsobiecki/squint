import './styles/variables.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/graph.css';

import { createApiClient } from './api/client';
import { createStore } from './state/store';
import { initFlowsDag } from './views/flows-dag';
import { initForceGraph } from './views/force-graph';
import { initInteractions } from './views/interactions';
import { initModulesTree } from './views/modules-tree';
import { initSunburst } from './views/sunburst';

// Initialize store and API client
const store = createStore();
const api = createApiClient();

// View initialization functions
const views = {
  force: initForceGraph,
  sunburst: initSunburst,
  modules: initModulesTree,
  flows: initFlowsDag,
  interactions: initInteractions,
};

// Current view state
let currentView: keyof typeof views = 'force';

// Setup view toggle buttons
function setupViewToggle() {
  document.querySelectorAll('.view-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = (btn as HTMLElement).dataset.view as keyof typeof views;
      if (view && view !== currentView) {
        switchView(view);
      }
    });
  });
}

// Switch between views
function switchView(view: keyof typeof views) {
  // Update button states
  document.querySelectorAll('.view-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.view === view);
  });

  // Show/hide relationship filters (only for hierarchy view)
  const filters = document.getElementById('relationship-filters');
  if (filters) {
    filters.classList.toggle('visible', view === 'sunburst');
  }

  // Show/hide symbol types legend (only for force view)
  const legend = document.getElementById('legend');
  if (legend) {
    legend.classList.toggle('hidden', view !== 'force');
  }

  // Update stats display based on view
  updateStatsForView(view);

  currentView = view;
  renderCurrentView();
}

// Update stats display for the current view
function updateStatsForView(view: string) {
  const statsContainer = document.getElementById('stats');
  if (!statsContainer) return;

  const state = store.getState();

  if (view === 'modules') {
    const moduleCount = state.modulesData?.stats.moduleCount ?? state.flowsDagData?.modules.length ?? '-';
    const assigned = state.modulesData?.stats.assigned ?? '-';
    const unassigned = state.modulesData?.stats.unassigned ?? '-';
    statsContainer.innerHTML = `
      <span class="stat">Modules: <span class="stat-value" id="stat-modules">${moduleCount}</span></span>
      <span class="stat">Assigned: <span class="stat-value annotated" id="stat-assigned">${assigned}</span></span>
      <span class="stat">Unassigned: <span class="stat-value" id="stat-unassigned">${unassigned}</span></span>
    `;
  } else if (view === 'flows') {
    statsContainer.innerHTML = `
      <span class="stat">Flows: <span class="stat-value" id="stat-flows">${state.flowsDagData?.flows.length ?? '-'}</span></span>
      <span class="stat">Modules: <span class="stat-value" id="stat-modules">${state.flowsDagData?.modules.length ?? '-'}</span></span>
    `;
  } else if (view === 'interactions') {
    const data = state.interactionsData;
    if (data) {
      statsContainer.innerHTML = `
        <span class="stat">Interactions: <span class="stat-value">${data.stats.totalCount}</span></span>
        <span class="stat">Business: <span class="stat-value annotated">${data.stats.businessCount}</span></span>
        <span class="stat">Utility: <span class="stat-value">${data.stats.utilityCount}</span></span>
        <span class="stat">Coverage: <span class="stat-value">${data.relationshipCoverage.coveragePercent.toFixed(0)}%</span></span>
      `;
    }
  } else {
    statsContainer.innerHTML = `
      <span class="stat">Symbols: <span class="stat-value" id="stat-symbols">${state.graphData?.stats.totalSymbols ?? '-'}</span></span>
      <span class="stat">Annotated: <span class="stat-value annotated" id="stat-annotated">${state.graphData?.stats.annotatedSymbols ?? '-'}</span></span>
      <span class="stat">Relationships: <span class="stat-value" id="stat-relationships">${state.graphData?.stats.totalRelationships ?? '-'}</span></span>
    `;
  }
}

// Render the current view
function renderCurrentView() {
  const container = document.getElementById('graph-container');
  if (!container) return;

  // Clear container
  container.innerHTML = '<svg id="graph-svg"></svg>';

  // Add loading state
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.id = 'loading';
  loading.textContent = 'Loading...';
  container.appendChild(loading);

  // Render the appropriate view
  const viewInit = views[currentView];
  if (viewInit) {
    viewInit(store, api);
  }
}

// Load initial data
async function loadInitialData() {
  try {
    const graphData = await api.getSymbolGraph();
    store.setState({ graphData });

    // Update stats
    document.getElementById('stat-symbols')!.textContent = String(graphData.stats.totalSymbols);
    document.getElementById('stat-annotated')!.textContent = String(graphData.stats.annotatedSymbols);
    document.getElementById('stat-relationships')!.textContent = String(graphData.stats.totalRelationships);

    // Load modules data
    const modulesData = await api.getModules();
    store.setState({ modulesData });

    // Load flows DAG data
    const flowsDagData = await api.getFlowsDag();
    store.setState({ flowsDagData });

    // Load interactions data
    const interactionsData = await api.getInteractions();
    store.setState({ interactionsData });

    // Render initial view
    renderCurrentView();
  } catch (error) {
    console.error('Failed to load data:', error);
    const loading = document.getElementById('loading');
    if (loading) {
      loading.textContent = 'Failed to load data. Is the API server running?';
    }
  }
}

// Setup relationship filters (for hierarchy view)
function setupRelationshipFilters() {
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const type = (chip as HTMLElement).dataset.type;
      if (!type) return;

      // Update chip styles (single-select)
      document.querySelectorAll('.filter-chip').forEach((c) => {
        c.classList.remove('active');
        c.classList.add('inactive');
      });
      chip.classList.remove('inactive');
      chip.classList.add('active');

      // Update store and re-render
      store.setState({
        selectedGrouping: type as 'structure' | 'extends' | 'implements' | 'calls' | 'imports' | 'uses',
      });
      if (currentView === 'sunburst') {
        renderCurrentView();
      }
    });
  });
}

// Initialize the application
function init() {
  setupViewToggle();
  setupRelationshipFilters();
  loadInitialData();
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
