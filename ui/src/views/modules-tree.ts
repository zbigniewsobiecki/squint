import type { ApiClient } from '../api/client';
import { renderModuleDag } from '../d3/module-dag';
import type { Store } from '../state/store';

export function initModulesTree(store: Store, _api: ApiClient) {
  const state = store.getState();
  const data = state.flowsDagData;

  if (!data || data.modules.length === 0) {
    showEmptyState();
    return;
  }

  renderModulesView(store);
}

function showEmptyState() {
  const container = document.getElementById('graph-container');
  if (container) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>No modules found</h2>
        <p>Run 'ats llm modules' to detect modules</p>
      </div>
    `;
  }
}

function renderModulesView(store: Store) {
  const state = store.getState();
  const flowsDagData = state.flowsDagData;
  if (!flowsDagData) return;

  const container = document.getElementById('graph-container');
  if (!container) return;

  container.innerHTML = `
    <div class="modules-dag-container" id="modules-dag-main">
      <svg id="modules-dag-svg"></svg>
      <div class="keyboard-hint">
        <kbd>Scroll</kbd> to zoom &nbsp; <kbd>Drag</kbd> to pan
      </div>
    </div>
  `;

  renderModuleDag('#modules-dag-svg', '#modules-dag-main', flowsDagData.modules);
}
