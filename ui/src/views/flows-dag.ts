import * as d3 from 'd3';
import type { ApiClient } from '../api/client';
import { getFlowColor } from '../d3/colors';
import type { Store } from '../state/store';
import { selectFlow } from '../state/store';
import type { DagFlow, DagModule } from '../types/api';

interface ModuleTreeNode extends DagModule {
  children: ModuleTreeNode[];
  _width?: number;
  _height?: number;
  _isLeaf?: boolean;
  _rows?: { children: ModuleTreeNode[]; width: number }[];
  _x?: number;
  _y?: number;
}

const modulePositions = new Map<number, { x: number; y: number; width: number; height: number }>();
let originalSidebarHtml: string | null = null;

export function initFlowsDag(store: Store, _api: ApiClient) {
  const state = store.getState();
  const data = state.flowsDagData;

  if (!data || data.modules.length === 0) {
    showEmptyState();
    return;
  }

  renderFlowsDagView(store);
}

function showEmptyState() {
  const container = document.getElementById('graph-container');
  if (container) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>No modules found</h2>
        <p>Run 'ats llm modules' to detect modules first</p>
      </div>
    `;
  }
}

function renderFlowsDagView(store: Store) {
  const state = store.getState();
  const flowsDagData = state.flowsDagData;
  if (!flowsDagData) return;

  const container = document.getElementById('graph-container');
  if (!container) return;

  // Group flows by stakeholder/domain
  const flowsByDomain = new Map<string, DagFlow[]>();
  for (const flow of flowsDagData.flows) {
    const domain = flow.stakeholder || 'Uncategorized';
    if (!flowsByDomain.has(domain)) {
      flowsByDomain.set(domain, []);
    }
    flowsByDomain.get(domain)!.push(flow);
  }

  const sortedDomains = [...flowsByDomain.keys()].sort();

  // Build sidebar HTML
  let sidebarHtml = '';
  let flowIndex = 0;
  for (const domain of sortedDomains) {
    const flows = flowsByDomain.get(domain)!;
    sidebarHtml += `
      <div class="flow-domain-group">
        <div class="flow-domain-header">${domain}</div>
        ${flows
          .map((flow) => {
            const color = getFlowColor(flowIndex);
            flowIndex++;
            const isSelected = state.selectedFlows.has(flow.id);
            return `
              <div class="flow-item${isSelected ? ' selected' : ''}" data-flow-id="${flow.id}">
                <span class="flow-color-dot" style="background: ${color};"></span>
                <span class="flow-name" title="${flow.name}">${flow.name}</span>
                <span class="flow-step-count">${flow.stepCount}</span>
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  }

  container.innerHTML = `
    <div class="flows-dag-container">
      <div class="flows-sidebar" id="flows-sidebar">
        <div class="flows-sidebar-header">
          <h3>Flows</h3>
          <button class="sidebar-toggle-btn" id="sidebar-collapse-btn" title="Collapse sidebar">◀</button>
        </div>
        <div class="flows-sidebar-content">
          ${sidebarHtml || '<div style="padding: 16px; color: #858585;">No flows found</div>'}
        </div>
      </div>
      <div class="flows-dag-main" id="flows-dag-main">
        <button class="sidebar-expand-btn" id="sidebar-expand-btn" title="Expand sidebar">▶</button>
        <svg id="flows-dag-svg"></svg>
        <div class="keyboard-hint">
          <kbd>Ctrl</kbd>+<kbd>S</kbd> Toggle sidebar
          <kbd>Esc</kbd> Deselect all
        </div>
      </div>
    </div>
  `;

  // Initialize module DAG visualization
  initializeModuleDAG(store);

  // Setup sidebar interactions
  setupSidebarInteractions(store);

  // Setup keyboard shortcuts
  setupKeyboardShortcuts(store);
}

function initializeModuleDAG(store: Store) {
  const state = store.getState();
  const flowsDagData = state.flowsDagData;
  if (!flowsDagData) return;

  const mainContainer = document.getElementById('flows-dag-main');
  if (!mainContainer) return;

  const svg = d3.select<SVGSVGElement, unknown>('#flows-dag-svg');
  const width = mainContainer.clientWidth;
  const height = mainContainer.clientHeight;

  svg.selectAll('*').remove();

  const modules = flowsDagData.modules;
  if (modules.length === 0) return;

  // Build tree structure from flat module list
  const moduleById = new Map<number, ModuleTreeNode>();
  for (const m of modules) {
    moduleById.set(m.id, { ...m, children: [] });
  }

  let rootModule: ModuleTreeNode | null = null;

  for (const m of modules) {
    const node = moduleById.get(m.id)!;
    if (m.parentId === null) {
      rootModule = node;
    } else {
      const parent = moduleById.get(m.parentId);
      if (parent) {
        parent.children.push(node);
      }
    }
  }

  if (!rootModule) {
    rootModule = moduleById.get(modules[0].id)!;
  }

  // Layout constants
  const HEADER_HEIGHT = 28;
  const PADDING = 12;
  const MIN_LEAF_WIDTH = 100;
  const MIN_LEAF_HEIGHT = 50;
  const GAP = 8;

  // Calculate sizes recursively
  function calculateSize(node: ModuleTreeNode) {
    if (node.children.length === 0) {
      const textWidth = Math.max(MIN_LEAF_WIDTH, node.name.length * 7 + 20);
      node._width = textWidth;
      node._height = MIN_LEAF_HEIGHT;
      node._isLeaf = true;
      return;
    }

    node.children.forEach((child) => calculateSize(child));

    const maxRowWidth = Math.min(800, width - 100);
    const rows: { children: ModuleTreeNode[]; width: number }[] = [];
    let currentRow: ModuleTreeNode[] = [];
    let currentRowWidth = 0;

    const sortedChildren = [...node.children].sort((a, b) => {
      if (a._isLeaf && !b._isLeaf) return 1;
      if (!a._isLeaf && b._isLeaf) return -1;
      return (b._width || 0) - (a._width || 0);
    });

    for (const child of sortedChildren) {
      if (currentRow.length > 0 && currentRowWidth + (child._width || 0) + GAP > maxRowWidth) {
        rows.push({ children: currentRow, width: currentRowWidth });
        currentRow = [];
        currentRowWidth = 0;
      }
      currentRow.push(child);
      currentRowWidth += (child._width || 0) + (currentRow.length > 1 ? GAP : 0);
    }
    if (currentRow.length > 0) {
      rows.push({ children: currentRow, width: currentRowWidth });
    }

    node._rows = rows;

    const contentWidth = Math.max(...rows.map((r) => r.width));
    const contentHeight = rows.reduce((sum, row) => {
      const rowHeight = Math.max(...row.children.map((c) => c._height || 0));
      return sum + rowHeight + GAP;
    }, 0);

    node._width = contentWidth + PADDING * 2;
    node._height = contentHeight + HEADER_HEIGHT + PADDING;
  }

  calculateSize(rootModule);

  // Position nodes
  function positionNodes(node: ModuleTreeNode, x: number, y: number) {
    node._x = x;
    node._y = y;

    modulePositions.set(node.id, {
      x: x,
      y: y,
      width: node._width || 0,
      height: node._height || 0,
    });

    if (!node._rows) return;

    let currentY = y + HEADER_HEIGHT;
    for (const row of node._rows) {
      let currentX = x + PADDING;
      const rowHeight = Math.max(...row.children.map((c) => c._height || 0));

      for (const child of row.children) {
        positionNodes(child, currentX, currentY);
        currentX += (child._width || 0) + GAP;
      }
      currentY += rowHeight + GAP;
    }
  }

  const startX = (width - (rootModule._width || 0)) / 2;
  const startY = (height - (rootModule._height || 0)) / 2;
  positionNodes(rootModule, startX, startY);

  // Create zoom group
  const g = svg.append('g');

  // Define arrowhead marker
  svg
    .append('defs')
    .append('marker')
    .attr('id', 'arrowhead')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 8)
    .attr('refY', 0)
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-5L10,0L0,5')
    .attr('fill', 'currentColor');

  // Setup zoom
  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.1, 4])
    .on('zoom', (event) => {
      g.attr('transform', event.transform.toString());
    });

  svg.call(zoom);

  // Draw module boxes
  function drawModuleBoxes(node: ModuleTreeNode, depth = 0) {
    const isLeaf = node.children.length === 0;
    const group = g
      .append('g')
      .attr('class', `module-box depth-${depth}${isLeaf ? ' leaf' : ''}`)
      .attr('data-module-id', node.id);

    group
      .append('rect')
      .attr('x', node._x || 0)
      .attr('y', node._y || 0)
      .attr('width', node._width || 0)
      .attr('height', node._height || 0);

    group
      .append('text')
      .attr('class', `module-box-header depth-${depth}`)
      .attr('x', (node._x || 0) + PADDING)
      .attr('y', (node._y || 0) + 18)
      .text(node.name);

    if (!isLeaf) {
      group
        .append('text')
        .attr('class', 'module-box-count')
        .attr('x', (node._x || 0) + (node._width || 0) - PADDING)
        .attr('y', (node._y || 0) + 18)
        .attr('text-anchor', 'end')
        .text(`${node.memberCount}`);
    }

    for (const child of node.children) {
      drawModuleBoxes(child, depth + 1);
    }
  }

  drawModuleBoxes(rootModule);

  // Draw flow arrows for selected flows
  updateFlowArrows(store);
}

function updateFlowArrows(store: Store) {
  const state = store.getState();
  const flowsDagData = state.flowsDagData;
  if (!flowsDagData) return;

  const g = d3.select('#flows-dag-svg g');
  g.selectAll('.flow-arrow').remove();
  g.selectAll('.flow-step-number').remove();

  const selectedFlows = state.selectedFlows;

  // Collect module IDs that are part of selected flows
  const activeModuleIds = new Set<number>();
  let flowIndex = 0;

  for (const flow of flowsDagData.flows) {
    const color = getFlowColor(flowIndex);
    flowIndex++;

    if (!selectedFlows.has(flow.id)) continue;

    let stepNum = 1;
    for (const step of flow.steps) {
      activeModuleIds.add(step.fromModuleId);
      activeModuleIds.add(step.toModuleId);

      const fromPos = modulePositions.get(step.fromModuleId);
      const toPos = modulePositions.get(step.toModuleId);

      if (!fromPos || !toPos) continue;

      const fromX = fromPos.x + fromPos.width / 2;
      const fromY = fromPos.y + fromPos.height / 2;
      const toX = toPos.x + toPos.width / 2;
      const toY = toPos.y + toPos.height / 2;

      // Calculate curve parameters
      const dx = toX - fromX;
      const dy = toY - fromY;
      const len = Math.sqrt(dx * dx + dy * dy);

      // Midpoint of the line
      const midX = (fromX + toX) / 2;
      const midY = (fromY + toY) / 2;

      // Perpendicular offset based on step number for separation
      const perpX = -dy / len; // perpendicular direction
      const perpY = dx / len;
      const curveOffset = (stepNum - 1) * 15; // 15px offset per step

      const ctrlX = midX + perpX * curveOffset;
      const ctrlY = midY + perpY * curveOffset;

      // Helper function to get point along quadratic bezier
      function getQuadraticPoint(t: number, x0: number, y0: number, cx: number, cy: number, x1: number, y1: number) {
        const mt = 1 - t;
        return {
          x: mt * mt * x0 + 2 * mt * t * cx + t * t * x1,
          y: mt * mt * y0 + 2 * mt * t * cy + t * t * y1,
        };
      }

      // Position labels at 15% and 85% along the curve
      const startLabel = getQuadraticPoint(0.15, fromX, fromY, ctrlX, ctrlY, toX, toY);
      const endLabel = getQuadraticPoint(0.85, fromX, fromY, ctrlX, ctrlY, toX, toY);

      // Draw quadratic bezier curve
      g.append('path')
        .attr('class', 'flow-arrow')
        .attr('data-step-idx', stepNum - 1)
        .attr('d', `M${fromX},${fromY} Q${ctrlX},${ctrlY} ${toX},${toY}`)
        .attr('stroke', color)
        .attr('stroke-width', 3)
        .attr('fill', 'none')
        .attr('marker-end', 'url(#arrowhead)')
        .style('color', color); // for marker fill inheritance

      // Add step number at start of arrow
      g.append('text')
        .attr('class', 'flow-step-number')
        .attr('data-step-idx', stepNum - 1)
        .attr('x', startLabel.x)
        .attr('y', startLabel.y)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('fill', color)
        .text(stepNum);

      // Add step number at end of arrow
      g.append('text')
        .attr('class', 'flow-step-number')
        .attr('data-step-idx', stepNum - 1)
        .attr('x', endLabel.x)
        .attr('y', endLabel.y)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .attr('fill', color)
        .text(stepNum + 1);

      stepNum++;
    }
  }

  // Update module dimming based on selection
  updateModuleDimming(activeModuleIds);
}

function updateModuleDimming(activeModuleIds: Set<number>) {
  const hasSelection = activeModuleIds.size > 0;

  d3.selectAll('.module-box').each(function () {
    const el = d3.select(this);
    const moduleId = Number.parseInt(el.attr('data-module-id') || '0');

    if (hasSelection && !activeModuleIds.has(moduleId)) {
      el.classed('module-dimmed', true);
    } else {
      el.classed('module-dimmed', false);
    }
  });
}

function highlightStep(store: Store, stepIdx: number) {
  const state = store.getState();
  const flowId = state.selectedFlowId;
  if (!flowId) return;

  const flow = state.flowsDagData?.flows.find((f) => f.id === flowId);
  if (!flow || !flow.steps[stepIdx]) return;

  const step = flow.steps[stepIdx];
  const activeModuleIds = new Set([step.fromModuleId, step.toModuleId]);

  // Dim all arrows except the hovered one
  d3.selectAll('.flow-arrow').classed('arrow-dimmed', function () {
    return Number.parseInt(d3.select(this).attr('data-step-idx') || '-1') !== stepIdx;
  });

  d3.selectAll('.flow-step-number').classed('number-dimmed', function () {
    return Number.parseInt(d3.select(this).attr('data-step-idx') || '-1') !== stepIdx;
  });

  // Update module dimming - only show from/to modules
  updateModuleDimming(activeModuleIds);
}

function clearStepHighlight(store: Store) {
  // Remove arrow dimming
  d3.selectAll('.flow-arrow').classed('arrow-dimmed', false);
  d3.selectAll('.flow-step-number').classed('number-dimmed', false);

  // Restore flow-level module highlighting
  const state = store.getState();
  const flowId = state.selectedFlowId;
  if (!flowId) return;

  const flow = state.flowsDagData?.flows.find((f) => f.id === flowId);
  if (!flow) return;

  const activeModuleIds = new Set<number>();
  for (const step of flow.steps) {
    activeModuleIds.add(step.fromModuleId);
    activeModuleIds.add(step.toModuleId);
  }

  updateModuleDimming(activeModuleIds);
}

function setupSidebarInteractions(store: Store) {
  // Collapse button
  document.getElementById('sidebar-collapse-btn')?.addEventListener('click', () => {
    document.getElementById('flows-sidebar')?.classList.add('collapsed');
    store.setState({ sidebarCollapsed: true });
  });

  // Expand button
  document.getElementById('sidebar-expand-btn')?.addEventListener('click', () => {
    document.getElementById('flows-sidebar')?.classList.remove('collapsed');
    store.setState({ sidebarCollapsed: false });
  });

  // Flow item clicks
  document.querySelectorAll('.flow-item').forEach((item) => {
    item.addEventListener('click', () => {
      const flowId = Number.parseInt(item.getAttribute('data-flow-id') || '0');

      // Single-select: clear others, select this one
      selectFlow(store, flowId);

      // Update selected state
      document.querySelectorAll('.flow-item').forEach((el) => {
        el.classList.toggle('selected', el.getAttribute('data-flow-id') === String(flowId));
      });

      // Show steps in sidebar
      showFlowSteps(store, flowId);

      // Update arrows
      updateFlowArrows(store);
    });
  });
}

function setupKeyboardShortcuts(store: Store) {
  document.addEventListener('keydown', (e) => {
    // Ctrl+S - Toggle sidebar
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      const sidebar = document.getElementById('flows-sidebar');
      sidebar?.classList.toggle('collapsed');
      store.setState({ sidebarCollapsed: sidebar?.classList.contains('collapsed') || false });
    }

    // Escape - Go back to flows list or deselect all
    if (e.key === 'Escape') {
      const state = store.getState();
      if (state.selectedFlowId !== null) {
        // If viewing a flow's steps, go back to flows list
        goBackToFlowsList(store);
      } else {
        // Otherwise just deselect all
        store.setState({ selectedFlows: new Set() });

        // Update UI
        document.querySelectorAll('.flow-item').forEach((item) => {
          item.classList.remove('selected');
        });

        updateFlowArrows(store);
      }
    }
  });
}

function showFlowSteps(store: Store, flowId: number) {
  const state = store.getState();
  const flow = state.flowsDagData?.flows.find((f) => f.id === flowId);
  if (!flow) return;

  const sidebarContent = document.querySelector('.flows-sidebar-content');
  if (!sidebarContent) return;

  // Store original HTML for back button
  if (!originalSidebarHtml) {
    originalSidebarHtml = sidebarContent.innerHTML;
  }

  // Build steps HTML
  const stepsHtml = flow.steps
    .map(
      (step, idx) => `
    <div class="step-item" data-step-idx="${idx}">
      <span class="step-number">${idx + 1}</span>
      <div class="step-content">
        <div class="step-name">${step.semantic || `Step ${idx + 1}`}</div>
      </div>
    </div>
  `
    )
    .join('');

  sidebarContent.innerHTML = `
    <div class="steps-back-btn" id="steps-back-btn">
      <span class="back-icon">←</span>
      <span>Back to flows</span>
    </div>
    <div class="steps-flow-title">${flow.name}</div>
    <div class="steps-list">
      ${stepsHtml || '<div style="padding: 16px; color: #858585;">No steps</div>'}
    </div>
  `;

  // Setup back button
  document.getElementById('steps-back-btn')?.addEventListener('click', () => {
    goBackToFlowsList(store);
  });

  // Setup step hover handlers
  document.querySelectorAll('.step-item').forEach((item) => {
    item.addEventListener('mouseenter', () => {
      const stepIdx = Number.parseInt(item.getAttribute('data-step-idx') || '0');
      highlightStep(store, stepIdx);
    });

    item.addEventListener('mouseleave', () => {
      clearStepHighlight(store);
    });
  });
}

function goBackToFlowsList(store: Store) {
  const sidebarContent = document.querySelector('.flows-sidebar-content');
  if (!sidebarContent || !originalSidebarHtml) return;

  // Restore original sidebar
  sidebarContent.innerHTML = originalSidebarHtml;

  // Clear selection
  selectFlow(store, null);

  // Re-setup event handlers
  setupSidebarInteractions(store);

  // Clear arrows
  updateFlowArrows(store);
}
