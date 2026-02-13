import type { ApiClient } from '../api/client';
import { clearDag, clearDagHighlight, highlightDagLink, renderDagView } from '../d3/interaction-dag';
import type { DagCallbacks } from '../d3/interaction-dag';
import type { AggregatedEdge } from '../d3/interaction-map';
import { buildModuleTree, getBoxColors } from '../d3/module-dag';
import type { ModuleTreeNode } from '../d3/module-dag';
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

  const rootModule = buildModuleTree(dagData.modules);
  if (!rootModule) {
    showEmptyState();
    return;
  }

  // Compute max depth in the tree
  function treeMaxDepth(node: ModuleTreeNode, depth: number): number {
    if (node.children.length === 0) return depth;
    return Math.max(...node.children.map((c) => treeMaxDepth(c, depth + 1)));
  }
  const maxDepth = treeMaxDepth(rootModule, 0);

  // Depth state
  let currentDepth = 1;

  // Collect visible (leaf-level) modules at a given depth
  function getModulesAtDepth(depth: number): ModuleTreeNode[] {
    const result: ModuleTreeNode[] = [];
    function walk(node: ModuleTreeNode, d: number) {
      if (d === depth || node.children.length === 0) {
        result.push(node);
        return;
      }
      for (const child of node.children) {
        walk(child, d + 1);
      }
    }
    for (const child of rootModule!.children) {
      walk(child, 1);
    }
    return result;
  }

  // Build ancestor map: every module ID -> the visible module ID it rolls up to
  let visibleModules: ModuleTreeNode[] = [];
  let ancestorMap = new Map<number, number>();

  function rebuildAncestorMap() {
    visibleModules = getModulesAtDepth(currentDepth);
    ancestorMap = new Map();

    function mapDescendants(node: ModuleTreeNode, visibleId: number) {
      ancestorMap.set(node.id, visibleId);
      for (const child of node.children) {
        mapDescendants(child, visibleId);
      }
    }

    for (const mod of visibleModules) {
      mapDescendants(mod, mod.id);
    }
  }

  rebuildAncestorMap();

  // Filter state
  const activeFilters = { business: true, utility: true };

  function getFilteredInteractions(): Interaction[] {
    return data!.interactions.filter((ix) => {
      if (ix.pattern === 'business' && !activeFilters.business) return false;
      if (ix.pattern !== 'business' && !activeFilters.utility) return false;
      return true;
    });
  }

  // Aggregate interactions to visible module level
  function aggregateToVisible(interactions: Interaction[]): {
    edges: AggregatedEdge[];
    countByModule: Map<number, number>;
  } {
    const edgeMap = new Map<string, AggregatedEdge>();
    const countByModule = new Map<number, number>();

    for (const mod of visibleModules) {
      countByModule.set(mod.id, 0);
    }

    for (const ix of interactions) {
      const fromVis = ancestorMap.get(ix.fromModuleId);
      const toVis = ancestorMap.get(ix.toModuleId);
      if (fromVis === undefined || toVis === undefined) continue;

      countByModule.set(fromVis, (countByModule.get(fromVis) ?? 0) + 1);
      if (fromVis !== toVis) {
        countByModule.set(toVis, (countByModule.get(toVis) ?? 0) + 1);
      }

      if (fromVis === toVis) continue;

      const key = `${fromVis}->${toVis}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.weight += ix.weight;
        existing.interactions.push(ix);
        if (ix.pattern === 'business') existing.pattern = 'business';
      } else {
        edgeMap.set(key, {
          fromId: fromVis,
          toId: toVis,
          weight: ix.weight,
          pattern: ix.pattern === 'business' ? 'business' : 'utility',
          interactions: [ix],
        });
      }
    }

    return { edges: [...edgeMap.values()], countByModule };
  }

  // Build process group summary
  const pg = data.processGroups;
  const processGroupHtml =
    pg && pg.groupCount >= 2
      ? `<div class="process-group-summary">${pg.groupCount} process groups: ${pg.groups.map((g) => g.label).join(', ')}</div>`
      : '';

  container.innerHTML = `
    ${processGroupHtml}
    <div class="ixmap-container">
      <div class="ixmap-controls">
        <button class="ixmap-filter-btn active" data-filter="business">Business</button>
        <button class="ixmap-filter-btn active" data-filter="utility">Utility</button>
        <div class="ixmap-depth-control">
          <button class="ixmap-depth-btn" id="ixmap-depth-minus">&minus;</button>
          <span class="ixmap-depth-label" id="ixmap-depth-label">Depth ${currentDepth}</span>
          <button class="ixmap-depth-btn" id="ixmap-depth-plus">+</button>
        </div>
      </div>
      <div class="ixmap-grid-area" id="ixmap-grid-area">
        <div class="ixmap-grid" id="ixmap-grid"></div>
        <svg class="ixmap-svg-overlay" id="ixmap-svg-overlay"></svg>
      </div>
      <div class="chord-sidebar hidden" id="imap-sidebar"></div>
    </div>
  `;

  const gridArea = document.getElementById('ixmap-grid-area') as HTMLElement;
  const grid = document.getElementById('ixmap-grid') as HTMLElement;
  const svgOverlay = document.getElementById('ixmap-svg-overlay') as unknown as SVGSVGElement;
  const sidebar = document.getElementById('imap-sidebar') as HTMLElement;
  const depthLabel = document.getElementById('ixmap-depth-label') as HTMLElement;
  const depthMinus = document.getElementById('ixmap-depth-minus') as HTMLButtonElement;
  const depthPlus = document.getElementById('ixmap-depth-plus') as HTMLButtonElement;

  // Card element lookup (only leaf-level visible modules)
  const cardElements = new Map<number, HTMLElement>();

  // Selection state
  let selectedModuleId: number | null = null;
  let currentEdges: AggregatedEdge[] = [];

  const GAP = 36;
  const PAD_X = 32;
  const PAD_TOP = 48;
  const PAD_BOTTOM = 32;
  const TARGET_RATIO = 4 / 3;

  // Top-level grid layout uses depth-1 module count (always the outer containers)
  function updateGridLayout() {
    const n = rootModule!.children.length;
    if (n === 0) return;

    const areaW = gridArea.clientWidth;
    const areaH = gridArea.clientHeight;
    const usableW = areaW - PAD_X * 2;
    const usableH = areaH - PAD_TOP - PAD_BOTTOM;

    let bestCols = 1;
    let bestDelta = Number.POSITIVE_INFINITY;

    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const cardW = (usableW - (cols - 1) * GAP) / cols;
      const cardH = (usableH - (rows - 1) * GAP) / rows;
      if (cardW <= 0 || cardH <= 0) continue;

      const ratio = cardW / cardH;
      const delta = Math.abs(ratio - TARGET_RATIO);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestCols = cols;
      }
    }

    const rows = Math.ceil(n / bestCols);
    grid.style.gridTemplateColumns = `repeat(${bestCols}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  }

  function updateDepthButtons() {
    depthLabel.textContent = `Depth ${currentDepth}`;
    depthMinus.disabled = currentDepth <= 1;
    depthPlus.disabled = currentDepth >= maxDepth;
  }

  // Recursively create a card element for a module node.
  // Leaf nodes (at target depth or with no children) become selectable cards.
  // Non-leaf nodes become parent containers with nested children.
  function createModuleCard(node: ModuleTreeNode, depth: number, countByModule: Map<number, number>): HTMLElement {
    const isLeaf = depth >= currentDepth || node.children.length === 0;
    const colors = getBoxColors(depth, node.colorIndex ?? 0);

    if (isLeaf) {
      const card = document.createElement('div');
      card.className = 'ixmap-card';
      card.dataset.moduleId = String(node.id);
      card.style.background = colors.fill;
      card.style.borderColor = colors.stroke;

      const count = countByModule.get(node.id) ?? 0;
      card.innerHTML = `
        <div class="ixmap-card-title">${escapeHtml(node.name)}</div>
        <div class="ixmap-card-count">${count} interaction${count !== 1 ? 's' : ''}</div>
      `;

      cardElements.set(node.id, card);
      return card;
    }

    // Parent container
    const parent = document.createElement('div');
    parent.className = 'ixmap-card-parent';
    parent.style.background = colors.fill;
    parent.style.borderColor = colors.stroke;

    const header = document.createElement('div');
    header.className = 'ixmap-card-header';
    header.textContent = node.name;
    parent.appendChild(header);

    const childrenGrid = document.createElement('div');
    childrenGrid.className = 'ixmap-card-children';
    for (const child of node.children) {
      childrenGrid.appendChild(createModuleCard(child, depth + 1, countByModule));
    }
    parent.appendChild(childrenGrid);

    return parent;
  }

  function renderCards() {
    const { edges, countByModule } = aggregateToVisible(getFilteredInteractions());
    currentEdges = edges;

    grid.innerHTML = '';
    cardElements.clear();

    for (const d1 of rootModule!.children) {
      grid.appendChild(createModuleCard(d1, 1, countByModule));
    }

    updateGridLayout();

    if (selectedModuleId !== null && cardElements.has(selectedModuleId)) {
      applySelection(selectedModuleId);
    } else {
      clearSelection();
    }
  }

  function setupSidebarEvents() {
    const listItems = sidebar.querySelector('.chord-sidebar-list-items');
    if (!listItems) return;

    // Click to expand/collapse
    listItems.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest('.chord-sidebar-item') as HTMLElement | null;
      if (!item) return;
      item.classList.toggle('expanded');
    });

    // Hover to highlight specific edge
    let hoveredItem: HTMLElement | null = null;

    listItems.addEventListener('mouseover', (event) => {
      const item = (event.target as HTMLElement).closest('.chord-sidebar-item') as HTMLElement | null;
      if (item === hoveredItem) return;
      hoveredItem = item;
      if (!item || selectedModuleId === null) {
        clearDagHighlight(svgOverlay);
        return;
      }
      const fromVis = Number(item.dataset.fromVis);
      const toVis = Number(item.dataset.toVis);
      if (fromVis === toVis) return; // internal, no arrow
      highlightDagLink(svgOverlay, fromVis, toVis);
    });

    listItems.addEventListener('mouseleave', () => {
      hoveredItem = null;
      clearDagHighlight(svgOverlay);
    });
  }

  const dagCallbacks: DagCallbacks = {
    onNodeClick: (id: number) => {
      if (selectedModuleId === id) {
        clearSelection();
      } else {
        applySelection(id);
      }
    },
    onLinkHover: (fromId: number | null, toId: number | null) => {
      if (fromId !== null && toId !== null) {
        highlightDagLink(svgOverlay, fromId, toId);
      } else {
        clearDagHighlight(svgOverlay);
      }
    },
  };

  function applySelection(moduleId: number) {
    selectedModuleId = moduleId;

    // Hide grid, show DAG
    grid.style.display = 'none';
    svgOverlay.style.pointerEvents = 'auto';
    renderDagView(svgOverlay, moduleId, currentEdges, visibleModules, gridArea, dagCallbacks);

    const mod = visibleModules.find((m) => m.id === moduleId);
    if (mod) {
      const grouped = collectGroupedInteractions(moduleId);
      const totalCount = grouped.reduce((s, g) => s + g.interactions.length, 0);
      sidebar.innerHTML = `
        <div class="chord-sidebar-header">
          <h3>${escapeHtml(mod.name)}</h3>
          <span class="chord-sidebar-path">${escapeHtml(mod.fullPath)}</span>
        </div>
        <div class="chord-sidebar-list">
          <div class="chord-sidebar-list-title">${totalCount} interaction${totalCount !== 1 ? 's' : ''}</div>
          <div class="chord-sidebar-list-items">
            ${grouped
              .map((g) => {
                const otherMod = g.otherId === INTERNAL_GROUP_ID ? mod : visibleModules.find((m) => m.id === g.otherId);
                const sectionColor = otherMod
                  ? getBoxColors(otherMod.depth, otherMod.colorIndex ?? 0).stroke
                  : 'transparent';
                return `
              <div class="chord-sidebar-section" style="border-left: 3px solid ${sectionColor}; padding-left: calc(var(--spacing-lg) - 3px);">${escapeHtml(g.otherName)}</div>
              ${g.interactions
                .map((ix) => {
                  const fromVis = ancestorMap.get(ix.fromModuleId) ?? -1;
                  const toVis = ancestorMap.get(ix.toModuleId) ?? -1;
                  return renderInteractionItem(ix, fromVis, toVis);
                })
                .join('')}`;
              })
              .join('')}
          </div>
        </div>
      `;
      sidebar.classList.remove('hidden');
      setupSidebarEvents();
    }
  }

  function clearSelection() {
    selectedModuleId = null;

    // Show grid, disable SVG pointer events
    grid.style.display = '';
    svgOverlay.style.pointerEvents = 'none';
    clearDag(svgOverlay);

    for (const card of cardElements.values()) {
      card.classList.remove('selected', 'dimmed');
    }
    sidebar.classList.add('hidden');
  }

  const INTERNAL_GROUP_ID = -1;

  function collectGroupedInteractions(
    moduleId: number
  ): { otherId: number; otherName: string; interactions: Interaction[] }[] {
    const groups = new Map<number, Interaction[]>();
    const filtered = getFilteredInteractions();

    for (const ix of filtered) {
      const fromVis = ancestorMap.get(ix.fromModuleId);
      const toVis = ancestorMap.get(ix.toModuleId);
      if (fromVis === undefined || toVis === undefined) continue;

      const fromInside = fromVis === moduleId;
      const toInside = toVis === moduleId;
      if (!fromInside && !toInside) continue;

      let groupId: number;
      if (fromInside && toInside) {
        groupId = INTERNAL_GROUP_ID;
      } else if (fromInside) {
        groupId = toVis;
      } else {
        groupId = fromVis;
      }

      let list = groups.get(groupId);
      if (!list) {
        list = [];
        groups.set(groupId, list);
      }
      list.push(ix);
    }

    return [...groups.entries()]
      .map(([otherId, interactions]) => {
        if (otherId === INTERNAL_GROUP_ID) {
          return { otherId, otherName: 'Internal', interactions };
        }
        const other = visibleModules.find((m) => m.id === otherId);
        return { otherId, otherName: other?.name ?? 'Unknown', interactions };
      })
      .sort((a, b) => b.interactions.length - a.interactions.length);
  }

  // Card click handler — only leaf cards (.ixmap-card) have data-module-id
  grid.addEventListener('click', (event) => {
    const card = (event.target as HTMLElement).closest('.ixmap-card') as HTMLElement | null;
    if (!card || !card.dataset.moduleId) return;

    const moduleId = Number(card.dataset.moduleId);

    if (selectedModuleId === moduleId) {
      clearSelection();
    } else {
      applySelection(moduleId);
    }

    event.stopPropagation();
  });

  // Click background / parent container to deselect
  gridArea.addEventListener('click', () => {
    if (selectedModuleId !== null) {
      clearSelection();
    }
  });

  // Filter button handlers
  const filterBtns = container.querySelectorAll('.ixmap-filter-btn');
  for (const btn of filterBtns) {
    btn.addEventListener('click', () => {
      const filter = (btn as HTMLElement).dataset.filter as 'business' | 'utility';
      activeFilters[filter] = !activeFilters[filter];
      btn.classList.toggle('active', activeFilters[filter]);
      renderCards();
    });
  }

  // Depth control handlers
  depthMinus.addEventListener('click', () => {
    if (currentDepth <= 1) return;
    currentDepth--;
    rebuildAncestorMap();
    updateDepthButtons();
    renderCards();
  });

  depthPlus.addEventListener('click', () => {
    if (currentDepth >= maxDepth) return;
    currentDepth++;
    rebuildAncestorMap();
    updateDepthButtons();
    renderCards();
  });

  // ResizeObserver to recalculate layout and re-render DAG/grid
  const resizeObserver = new ResizeObserver(() => {
    updateGridLayout();
    if (selectedModuleId !== null) {
      renderDagView(svgOverlay, selectedModuleId, currentEdges, visibleModules, gridArea, dagCallbacks);
    }
  });
  resizeObserver.observe(gridArea);

  // Initial render
  updateDepthButtons();
  renderCards();
}

function renderInteractionItem(ix: Interaction, fromVis: number, toVis: number): string {
  const fromName = ix.fromModulePath.split('.').pop() || ix.fromModulePath;
  const toName = ix.toModulePath.split('.').pop() || ix.toModulePath;
  const patternClass = ix.pattern === 'business' ? 'business' : 'utility';
  const dirLabel = ix.direction === 'bi' ? '\u2194' : '\u2192';
  const symbols = ix.symbols ? ix.symbols.split(',').map((s) => s.trim()) : [];
  const sourceLabel = ix.source === 'llm-inferred' ? 'inferred' : 'ast';
  const sourceClass = ix.source === 'llm-inferred' ? 'inferred' : 'ast';
  const summary = ix.semantic ? escapeHtml(ix.semantic) : `${escapeHtml(fromName)} ${dirLabel} ${escapeHtml(toName)}`;

  return `
    <div class="chord-sidebar-item" data-from-vis="${fromVis}" data-to-vis="${toVis}">
      <div class="chord-sidebar-item-summary">${summary}</div>
      <div class="chord-sidebar-item-details">
        <div class="chord-sidebar-item-header">
          <span class="chord-sidebar-module">${escapeHtml(fromName)}</span>
          <span class="chord-sidebar-arrow">${dirLabel}</span>
          <span class="chord-sidebar-module">${escapeHtml(toName)}</span>
          <span class="chord-sidebar-badge ${patternClass}">${ix.pattern || 'utility'}</span>
          <span class="chord-sidebar-badge weight">\u00d7${ix.weight}</span>
          <span class="chord-sidebar-badge ${sourceClass}">${sourceLabel}</span>
        </div>
        ${symbols.length > 0 ? `<div class="chord-sidebar-symbols">${symbols.map((s) => `<span class="chord-sidebar-symbol">${escapeHtml(s)}</span>`).join('')}</div>` : ''}
      </div>
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
