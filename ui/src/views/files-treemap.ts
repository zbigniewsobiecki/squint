import type { ApiClient } from '../api/client';
import { type FileTreemapControls, buildFileTree, renderFileTreemap } from '../d3/file-treemap';
import type { Store } from '../state/store';

export function initFilesTreemap(store: Store, _api: ApiClient) {
  const state = store.getState();
  const data = state.graphData;

  if (!data || data.nodes.length === 0) {
    showEmptyState();
    return;
  }

  renderFilesView(store);
}

function showEmptyState() {
  const container = document.getElementById('graph-container');
  if (container) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>No symbol data found</h2>
        <p>Index a codebase to see the file treemap</p>
      </div>
    `;
  }
}

function renderFilesView(store: Store) {
  const state = store.getState();
  const graphData = state.graphData;
  if (!graphData) return;

  const container = document.getElementById('graph-container');
  if (!container) return;

  const tree = buildFileTree(graphData.nodes);

  container.innerHTML = `
    <div class="files-treemap-container" id="files-treemap-main">
      <div class="treemap-breadcrumb" id="treemap-breadcrumb">
        <span class="breadcrumb-segment breadcrumb-root">root</span>
      </div>
      <svg id="files-treemap-svg"></svg>
      <div class="keyboard-hint">
        <kbd>Click</kbd> directory to zoom in &nbsp; <kbd>Click</kbd> background or breadcrumb to zoom out
      </div>
    </div>
  `;

  let controls: FileTreemapControls | null = null;

  function onSelect(path: string[]) {
    const breadcrumb = document.getElementById('treemap-breadcrumb');
    if (!breadcrumb) return;

    let html = `<span class="breadcrumb-segment breadcrumb-root breadcrumb-clickable" data-depth="0">root</span>`;
    for (let i = 0; i < path.length; i++) {
      html += `<span class="breadcrumb-sep">/</span><span class="breadcrumb-segment breadcrumb-clickable" data-depth="${i + 1}">${escapeHtml(path[i])}</span>`;
    }
    breadcrumb.innerHTML = html;

    // Attach click handlers to breadcrumb segments
    breadcrumb.querySelectorAll('.breadcrumb-clickable').forEach((el) => {
      el.addEventListener('click', () => {
        const depth = Number.parseInt((el as HTMLElement).dataset.depth ?? '0', 10);
        controls?.navigateTo(depth);
      });
    });
  }

  controls = renderFileTreemap('#files-treemap-svg', '#files-treemap-main', tree, onSelect);
}

function escapeHtml(text: string): string {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}
