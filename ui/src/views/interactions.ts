import type { ApiClient } from '../api/client';
import type { AggregatedEdge } from '../d3/interaction-map';
import { clearSankey, getMaxRelativeDepth, renderOverviewSankey, renderSankeyView } from '../d3/interaction-sankey';
import type { SankeyRenderResult } from '../d3/interaction-sankey';
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

  container.innerHTML = `
    <div class="ixmap-container">
      <div class="ix-module-sidebar">
        <div class="ix-module-sidebar-header"><h3>Modules</h3></div>
        <div class="ix-module-sidebar-content" id="ix-module-sidebar-content"></div>
      </div>
      <div class="ixmap-main">
        <div class="ixmap-controls">
          <div class="ixmap-depth-control">
            <button class="ixmap-depth-btn" id="ixmap-depth-minus">&minus;</button>
            <span class="ixmap-depth-label" id="ixmap-depth-label">Depth ${currentDepth}</span>
            <button class="ixmap-depth-btn" id="ixmap-depth-plus">+</button>
          </div>
        </div>
        <div class="ixmap-grid-area" id="ixmap-grid-area">
          <div class="ixmap-placeholder" id="ixmap-placeholder"><span>Select a module to view interactions</span></div>
          <svg class="ixmap-svg-overlay" id="ixmap-svg-overlay"></svg>
        </div>
      </div>
      <div class="chord-sidebar hidden" id="imap-sidebar"></div>
    </div>
  `;

  const moduleSidebarContent = document.getElementById('ix-module-sidebar-content') as HTMLElement;
  const gridArea = document.getElementById('ixmap-grid-area') as HTMLElement;
  const placeholder = document.getElementById('ixmap-placeholder') as HTMLElement;
  const svgOverlay = document.getElementById('ixmap-svg-overlay') as unknown as SVGSVGElement;
  const sidebar = document.getElementById('imap-sidebar') as HTMLElement;
  const depthLabel = document.getElementById('ixmap-depth-label') as HTMLElement;
  const depthMinus = document.getElementById('ixmap-depth-minus') as HTMLButtonElement;
  const depthPlus = document.getElementById('ixmap-depth-plus') as HTMLButtonElement;

  // Selection state
  let selectedModuleId: number | null = null;
  let currentEdges: AggregatedEdge[] = [];

  // Link focus (Sankey drill-down) state
  let linkFocus: {
    moduleA: ModuleTreeNode;
    moduleB: ModuleTreeNode;
    interactions: Interaction[];
    sankeyDepth: number;
    sankeyMaxDepth: number;
  } | null = null;
  let sankeyResult: SankeyRenderResult | null = null;
  let escapeHandler: ((e: KeyboardEvent) => void) | null = null;

  // Track which branch nodes are expanded (by module id); depth-1 nodes start expanded
  const expandedNodes = new Set<number>(rootModule.children.map((c) => c.id));

  function updateDepthButtons() {
    depthLabel.textContent = `Depth ${currentDepth}`;
    depthMinus.disabled = currentDepth <= 1;
    depthPlus.disabled = currentDepth >= maxDepth;
  }

  function renderModuleSidebar() {
    const { edges, countByModule } = aggregateToVisible(data!.interactions);
    currentEdges = edges;

    moduleSidebarContent.innerHTML = '';

    function renderNode(node: ModuleTreeNode, depth: number, parent: HTMLElement) {
      const hasChildren = node.children.length > 0;
      const isVisibleModule = countByModule.has(node.id);
      const colors = getBoxColors(depth, node.colorIndex ?? 0);
      const indent = 8 + (depth - 1) * 16;

      const row = document.createElement('div');
      row.className = 'ix-module-item';
      if (selectedModuleId === node.id) row.classList.add('selected');
      row.dataset.moduleId = String(node.id);
      row.style.paddingLeft = `${indent}px`;

      let html = '';
      if (hasChildren) {
        const isExpanded = expandedNodes.has(node.id);
        html += `<span class="ix-module-toggle ${isExpanded ? 'expanded' : ''}">\u25b6</span>`;
      } else {
        html += `<span class="ix-module-toggle-spacer"></span>`;
      }
      html += `<span class="ix-module-color" style="background: ${colors.stroke}"></span>`;
      html += `<span class="ix-module-name${!isVisibleModule && hasChildren ? ' branch-label' : ''}">${escapeHtml(node.name)}</span>`;
      if (isVisibleModule) {
        const count = countByModule.get(node.id) ?? 0;
        html += `<span class="ix-module-count">${count}</span>`;
      }
      row.innerHTML = html;

      // Toggle click for nodes with children — expand/collapse only
      if (hasChildren) {
        const toggle = row.querySelector('.ix-module-toggle') as HTMLElement;
        toggle.addEventListener('click', (e) => {
          e.stopPropagation();
          if (expandedNodes.has(node.id)) {
            expandedNodes.delete(node.id);
          } else {
            expandedNodes.add(node.id);
          }
          renderModuleSidebar();
        });
      }

      // Row click — always select/deselect
      row.addEventListener('click', () => {
        if (linkFocus) exitLinkFocus();
        if (selectedModuleId === node.id) {
          clearSelection();
          renderModuleSidebar();
          return;
        }
        // If this module isn't visible at current depth, adjust depth to include it
        if (!isVisibleModule) {
          currentDepth = depth;
          rebuildAncestorMap();
          updateDepthButtons();
          renderModuleSidebar();
        }
        applySelection(node.id);
      });

      parent.appendChild(row);

      // Render children if expanded
      if (hasChildren && expandedNodes.has(node.id)) {
        const childrenContainer = document.createElement('div');
        childrenContainer.className = 'ix-module-children';
        for (const child of node.children) {
          renderNode(child, depth + 1, childrenContainer);
        }
        parent.appendChild(childrenContainer);
      }
    }

    for (const child of rootModule!.children) {
      renderNode(child, 1, moduleSidebarContent);
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

    // Hover to highlight Sankey band
    let hoveredItem: HTMLElement | null = null;

    listItems.addEventListener('mouseover', (event) => {
      const item = (event.target as HTMLElement).closest('.chord-sidebar-item') as HTMLElement | null;
      if (item === hoveredItem) return;
      hoveredItem = item;
      if (!item) {
        if (sankeyResult) sankeyResult.clearHighlight();
        return;
      }
      const fromVis = Number(item.dataset.fromVis);
      const toVis = Number(item.dataset.toVis);
      if (sankeyResult) {
        sankeyResult.highlightBand(fromVis, toVis);
      }
    });

    listItems.addEventListener('mouseleave', () => {
      hoveredItem = null;
      if (sankeyResult) sankeyResult.clearHighlight();
    });
  }

  function applySelection(moduleId: number) {
    selectedModuleId = moduleId;

    // Hide placeholder, enable SVG
    placeholder.style.display = 'none';
    svgOverlay.style.pointerEvents = 'auto';

    // Update sidebar selection
    for (const el of moduleSidebarContent.querySelectorAll('.ix-module-item')) {
      el.classList.toggle('selected', (el as HTMLElement).dataset.moduleId === String(moduleId));
    }

    const mod = visibleModules.find((m) => m.id === moduleId);
    if (!mod) return;

    // Find connected peer modules
    const connectedPeerIds = new Set<number>();
    for (const edge of currentEdges) {
      if (edge.fromId === moduleId) connectedPeerIds.add(edge.toId);
      if (edge.toId === moduleId) connectedPeerIds.add(edge.fromId);
    }
    const peerMods = visibleModules.filter((m) => connectedPeerIds.has(m.id));

    sankeyResult = renderOverviewSankey(svgOverlay, mod, data!.interactions, peerMods, ancestorMap, gridArea, {
      onBandHover: (_subId, _peerId) => {
        const items = sidebar.querySelectorAll('.chord-sidebar-item');
        for (const item of items) {
          item.classList.remove('highlighted');
        }
      },
      onBandClick: (peerMod, ixs) => {
        enterLinkFocus(mod, peerMod, ixs);
      },
      onNodeClick: (id) => {
        applySelection(id);
        renderModuleSidebar();
      },
    });

    {
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

  // ── Link focus (Sankey drill-down) ──────────────────────────────

  function enterLinkFocus(modA: ModuleTreeNode, modB: ModuleTreeNode, interactions: Interaction[]) {
    const maxA = getMaxRelativeDepth(modA);
    const maxB = getMaxRelativeDepth(modB);
    const sankeyMaxDepth = Math.max(maxA, maxB);

    if (sankeyMaxDepth === 0) {
      // Neither has children — nothing to drill into
      return;
    }

    linkFocus = { moduleA: modA, moduleB: modB, interactions, sankeyDepth: 1, sankeyMaxDepth };
    renderLinkFocusView();
  }

  function renderLinkFocusView() {
    if (!linkFocus) return;

    const { moduleA: modA, moduleB: modB, interactions } = linkFocus;

    // Hide placeholder, enable SVG
    placeholder.style.display = 'none';
    svgOverlay.style.pointerEvents = 'auto';

    clearSankey(svgOverlay);

    // Create/update sankey header
    let header = gridArea.querySelector('.sankey-header') as HTMLElement | null;
    if (!header) {
      header = document.createElement('div');
      header.className = 'sankey-header';
      gridArea.appendChild(header);
    }

    const colorsA = getBoxColors(modA.depth, modA.colorIndex ?? 0);
    const colorsB = getBoxColors(modB.depth, modB.colorIndex ?? 0);

    header.innerHTML = `
      <button class="sankey-back-btn" id="sankey-back-btn">\u2190 Back</button>
      <div class="sankey-title">
        <span style="color: ${colorsA.stroke}">${escapeHtml(modA.name)}</span>
        <span class="sankey-separator">\u2194</span>
        <span style="color: ${colorsB.stroke}">${escapeHtml(modB.name)}</span>
      </div>
      <div class="ixmap-depth-control">
        <button class="ixmap-depth-btn" id="sankey-depth-minus">\u2212</button>
        <span class="ixmap-depth-label" id="sankey-depth-label">Detail ${linkFocus.sankeyDepth}</span>
        <button class="ixmap-depth-btn" id="sankey-depth-plus">+</button>
      </div>
    `;

    // Wire header buttons
    header.querySelector('#sankey-back-btn')!.addEventListener('click', () => exitLinkFocus());

    const sDepthMinus = header.querySelector('#sankey-depth-minus') as HTMLButtonElement;
    const sDepthPlus = header.querySelector('#sankey-depth-plus') as HTMLButtonElement;
    const sDepthLabel = header.querySelector('#sankey-depth-label') as HTMLElement;

    sDepthMinus.disabled = linkFocus.sankeyDepth <= 1;
    sDepthPlus.disabled = linkFocus.sankeyDepth >= linkFocus.sankeyMaxDepth;

    sDepthMinus.addEventListener('click', () => {
      if (!linkFocus || linkFocus.sankeyDepth <= 1) return;
      linkFocus.sankeyDepth--;
      renderLinkFocusView();
    });
    sDepthPlus.addEventListener('click', () => {
      if (!linkFocus || linkFocus.sankeyDepth >= linkFocus.sankeyMaxDepth) return;
      linkFocus.sankeyDepth++;
      renderLinkFocusView();
    });

    sDepthLabel.textContent = `Detail ${linkFocus.sankeyDepth}`;

    // Highlight both modules in left sidebar
    for (const el of moduleSidebarContent.querySelectorAll('.ix-module-item')) {
      const id = (el as HTMLElement).dataset.moduleId;
      el.classList.toggle('selected', id === String(modA.id) || id === String(modB.id));
    }

    // Render Sankey
    sankeyResult = renderSankeyView(svgOverlay, modA, modB, interactions, linkFocus.sankeyDepth, gridArea, {
      onBandHover: (_fromSubId, _toSubId) => {
        const items = sidebar.querySelectorAll('.chord-sidebar-item');
        for (const item of items) {
          item.classList.remove('highlighted');
        }
        if (_fromSubId === null || _toSubId === null) return;
      },
      onBandClick: (leftMod, rightMod, bandInteractions) => {
        enterLinkFocus(leftMod, rightMod, bandInteractions);
      },
    });

    // Populate right sidebar with interactions between A and B
    const totalCount = interactions.length;
    sidebar.innerHTML = `
      <div class="chord-sidebar-header">
        <h3>${escapeHtml(modA.name)} \u2194 ${escapeHtml(modB.name)}</h3>
        <span class="chord-sidebar-path">${escapeHtml(modA.fullPath)} \u2194 ${escapeHtml(modB.fullPath)}</span>
      </div>
      <div class="chord-sidebar-list">
        <div class="chord-sidebar-list-title">${totalCount} interaction${totalCount !== 1 ? 's' : ''}</div>
        <div class="chord-sidebar-list-items">
          ${interactions.map((ix) => renderInteractionItem(ix, modA.id, modB.id)).join('')}
        </div>
      </div>
    `;
    sidebar.classList.remove('hidden');
    setupSidebarEvents();

    // Escape key handler
    if (escapeHandler) document.removeEventListener('keydown', escapeHandler);
    escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitLinkFocus();
    };
    document.addEventListener('keydown', escapeHandler);
  }

  function exitLinkFocus() {
    // Remove sankey header
    const header = gridArea.querySelector('.sankey-header');
    if (header) header.remove();

    clearSankey(svgOverlay);

    // Remove escape listener
    if (escapeHandler) {
      document.removeEventListener('keydown', escapeHandler);
      escapeHandler = null;
    }

    linkFocus = null;
    sankeyResult = null;

    // Restore previous state
    if (selectedModuleId !== null) {
      applySelection(selectedModuleId);
    } else {
      clearSelection();
      renderModuleSidebar();
    }
  }

  function clearSelection() {
    selectedModuleId = null;

    // Show placeholder, disable SVG
    placeholder.style.display = '';
    svgOverlay.style.pointerEvents = 'none';
    clearSankey(svgOverlay);

    // Remove sidebar selection highlight
    for (const el of moduleSidebarContent.querySelectorAll('.ix-module-item.selected')) {
      el.classList.remove('selected');
    }

    sidebar.classList.add('hidden');
  }

  const INTERNAL_GROUP_ID = -1;

  function collectGroupedInteractions(
    moduleId: number
  ): { otherId: number; otherName: string; interactions: Interaction[] }[] {
    const groups = new Map<number, Interaction[]>();
    const filtered = data!.interactions;

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

  // Click background to deselect
  gridArea.addEventListener('click', (event) => {
    if (event.target !== gridArea) return;
    if (linkFocus) {
      exitLinkFocus();
      return;
    }
    if (selectedModuleId !== null) {
      clearSelection();
      renderModuleSidebar();
    }
  });

  // Depth control handlers
  depthMinus.addEventListener('click', () => {
    if (currentDepth <= 1) return;
    if (linkFocus) exitLinkFocus();
    currentDepth--;
    rebuildAncestorMap();
    updateDepthButtons();
    clearSelection();
    renderModuleSidebar();
  });

  depthPlus.addEventListener('click', () => {
    if (currentDepth >= maxDepth) return;
    if (linkFocus) exitLinkFocus();
    currentDepth++;
    rebuildAncestorMap();
    updateDepthButtons();
    clearSelection();
    renderModuleSidebar();
  });

  // ResizeObserver — re-render on resize
  const resizeObserver = new ResizeObserver(() => {
    if (linkFocus) {
      renderLinkFocusView();
    } else if (selectedModuleId !== null) {
      applySelection(selectedModuleId);
    }
  });
  resizeObserver.observe(gridArea);

  // Initial render
  updateDepthButtons();
  renderModuleSidebar();
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
