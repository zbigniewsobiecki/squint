import * as d3 from 'd3';
import type { ApiClient } from '../api/client';
import { getFlowColor } from '../d3/colors';
import { buildModuleTree, getBoxColors } from '../d3/module-dag';
import type { ModuleTreeNode } from '../d3/module-dag';
import { fitToViewport } from '../d3/zoom';
import type { Store } from '../state/store';
import { selectFlow } from '../state/store';
import type { DagFlow, DagFlowStep, DagModule } from '../types/api';

let originalSidebarHtml: string | null = null;

// Sequence diagram layout constants
const PARTICIPANT_WIDTH = 130;
const PARTICIPANT_GAP = 40;
const PARTICIPANT_HEIGHT = 48;
const MESSAGE_ROW_HEIGHT = 60;
const TOP_PADDING = 80;
const GROUP_HEADER_HEIGHT = 22;
const CONTAINER_PAD = 8;

// Expansion state — reset on flow change
let expandedModules = new Set<number>();

// Mapping from original step index to remapped step index (for sidebar hover)
let originalToRemappedIdx = new Map<number, number>();

export interface RemappedStep {
  fromVisibleId: number;
  toVisibleId: number;
  originalIndices: number[];
  labels: string[];
}

// --- Selective depth helpers ---

export function getSelectiveVisibleModules(root: ModuleTreeNode, expanded: Set<number>): ModuleTreeNode[] {
  const result: ModuleTreeNode[] = [];
  function walk(node: ModuleTreeNode) {
    if (node.children.length === 0 || !expanded.has(node.id)) {
      result.push(node);
      return;
    }
    for (const child of node.children) walk(child);
  }
  for (const child of root.children) walk(child);
  return result;
}

export function buildSelectiveAncestorMap(visibleModules: ModuleTreeNode[]): Map<number, number> {
  const map = new Map<number, number>();
  function mapDesc(node: ModuleTreeNode, visId: number) {
    map.set(node.id, visId);
    for (const child of node.children) mapDesc(child, visId);
  }
  for (const mod of visibleModules) mapDesc(mod, mod.id);
  return map;
}

export function remapSteps(steps: DagFlowStep[], ancestorMap: Map<number, number>): RemappedStep[] {
  const groupMap = new Map<string, RemappedStep>();
  const groupOrder: string[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const fromVis = ancestorMap.get(step.fromModuleId);
    const toVis = ancestorMap.get(step.toModuleId);
    if (fromVis === undefined || toVis === undefined) continue;

    const key = `${fromVis}->${toVis}`;
    const existing = groupMap.get(key);
    if (existing) {
      existing.originalIndices.push(i);
      const label = step.semantic || step.toDefName || `Step ${i + 1}`;
      existing.labels.push(label);
    } else {
      const label = step.semantic || step.toDefName || `Step ${i + 1}`;
      const remapped: RemappedStep = {
        fromVisibleId: fromVis,
        toVisibleId: toVis,
        originalIndices: [i],
        labels: [label],
      };
      groupMap.set(key, remapped);
      groupOrder.push(key);
    }
  }

  // Sort by first original index
  return groupOrder.map((k) => groupMap.get(k)!);
}

export function getRemappedLabel(remapped: RemappedStep): string {
  if (remapped.labels.length === 1) return remapped.labels[0];
  return `${remapped.labels[0]} (+${remapped.labels.length - 1} more)`;
}

/** Find the nearest expanded ancestor for a visible module */
export function buildVisibleToExpandedParent(
  visibleModules: ModuleTreeNode[],
  expanded: Set<number>,
  nodeById: Map<number, ModuleTreeNode>
): Map<number, number> {
  const result = new Map<number, number>();
  for (const mod of visibleModules) {
    // Walk up looking for an expanded ancestor
    let parentId = mod.parentId;
    while (parentId !== null) {
      if (expanded.has(parentId)) {
        result.set(mod.id, parentId);
        break;
      }
      const parent = nodeById.get(parentId);
      parentId = parent?.parentId ?? null;
    }
  }
  return result;
}

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
        <p>Run 'squint llm modules' to detect modules first</p>
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

  // Group flows by tier, then by stakeholder/domain
  const tierNames: Record<number, string> = { 0: 'Atomic', 1: 'Operations', 2: 'Journeys' };
  const tiers = [1, 2]; // Show operations and journeys only (atomics are sub-steps)

  // Build sidebar HTML
  let sidebarHtml = '';
  let flowIndex = 0;
  // Build global flow index for consistent colors
  const flowColorMap = new Map<number, number>();
  for (const flow of flowsDagData.flows) {
    flowColorMap.set(flow.id, flowIndex++);
  }

  for (const tier of tiers) {
    const tierFlows = flowsDagData.flows.filter((f) => f.tier === tier);
    if (tierFlows.length === 0) continue;

    // Group by feature within the tier (fall back to stakeholder if no features)
    const flowIdToFeature = new Map<number, string>();
    if (flowsDagData.features && flowsDagData.features.length > 0) {
      for (const feature of flowsDagData.features) {
        for (const flowId of feature.flowIds) {
          flowIdToFeature.set(flowId, feature.name);
        }
      }
    }
    const hasFeatures = flowIdToFeature.size > 0;
    const flowsByDomain = new Map<string, DagFlow[]>();
    for (const flow of tierFlows) {
      const domain = hasFeatures
        ? flowIdToFeature.get(flow.id) || 'Uncategorized'
        : flow.stakeholder || 'Uncategorized';
      if (!flowsByDomain.has(domain)) {
        flowsByDomain.set(domain, []);
      }
      flowsByDomain.get(domain)!.push(flow);
    }

    const tierLabel = tierNames[tier] ?? `Tier ${tier}`;
    const isCollapsed = tier === 0; // Atomics start collapsed
    sidebarHtml += `
      <div class="flow-tier-group${isCollapsed ? ' collapsed' : ''}" data-tier="${tier}">
        <div class="flow-tier-header" data-tier="${tier}">
          <span class="tier-toggle">${isCollapsed ? '▶' : '▼'}</span>
          <span class="tier-label">${tierLabel}</span>
          <span class="tier-count">${tierFlows.length}</span>
        </div>
        <div class="flow-tier-content">
    `;

    const sortedDomains = [...flowsByDomain.keys()].sort((a, b) => {
      if (a === 'Uncategorized') return 1;
      if (b === 'Uncategorized') return -1;
      return a.localeCompare(b);
    });
    for (const domain of sortedDomains) {
      const flows = flowsByDomain.get(domain)!;
      sidebarHtml += `
        <div class="flow-domain-group">
          <div class="flow-domain-header">${domain}</div>
          ${flows
            .map((flow) => {
              const colorIdx = flowColorMap.get(flow.id) ?? 0;
              const color = getFlowColor(colorIdx);
              const isSelected = state.selectedFlows.has(flow.id);
              return `
                <div class="flow-item${isSelected ? ' selected' : ''}" data-flow-id="${flow.id}">
                  <span class="flow-color-dot" style="background: ${color};"></span>
                  <div class="flow-item-content">
                    <span class="flow-name" title="${flow.name}">${flow.name}</span>
                    ${flow.description ? `<span class="flow-description">${flow.description}</span>` : ''}
                  </div>
                  ${flow.actionType ? `<span class="flow-action-badge">${flow.actionType}</span>` : ''}
                  <span class="flow-step-count">${flow.stepCount}</span>
                </div>
              `;
            })
            .join('')}
        </div>
      `;
    }

    sidebarHtml += `
        </div>
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

  // Show placeholder when no flow is selected
  showSequencePlaceholder();

  // Setup sidebar interactions
  setupSidebarInteractions(store);

  // Setup keyboard shortcuts
  setupKeyboardShortcuts(store);
}

function showSequencePlaceholder() {
  const svg = d3.select<SVGSVGElement, unknown>('#flows-dag-svg');
  svg.selectAll('*').remove();

  const mainContainer = document.getElementById('flows-dag-main');
  if (!mainContainer) return;

  const width = mainContainer.clientWidth;
  const height = mainContainer.clientHeight;

  svg
    .append('text')
    .attr('class', 'seq-placeholder')
    .attr('x', width / 2)
    .attr('y', height / 2)
    .attr('text-anchor', 'middle')
    .attr('dominant-baseline', 'middle')
    .text('Select a flow to view its sequence diagram');
}

function renderSequenceDiagram(store: Store) {
  const state = store.getState();
  const flowsDagData = state.flowsDagData;
  if (!flowsDagData) return;

  const flowId = state.selectedFlowId;
  if (!flowId) {
    showSequencePlaceholder();
    return;
  }

  // Find the selected flow and its color index
  const flow = flowsDagData.flows.find((f) => f.id === flowId);
  if (!flow || flow.steps.length === 0) {
    showSequencePlaceholder();
    return;
  }

  let flowColorIndex = 0;
  for (const f of flowsDagData.flows) {
    if (f.id === flowId) break;
    flowColorIndex++;
  }
  const flowColor = getFlowColor(flowColorIndex);

  const mainContainer = document.getElementById('flows-dag-main');
  if (!mainContainer) return;

  const svg = d3.select<SVGSVGElement, unknown>('#flows-dag-svg');
  svg.selectAll('*').remove();

  // Build module tree and lookup
  const moduleById = new Map<number, DagModule>();
  for (const m of flowsDagData.modules) {
    moduleById.set(m.id, m);
  }

  const rootModule = buildModuleTree(flowsDagData.modules);
  if (!rootModule) return;

  // Build a node-by-id map from the tree for parent lookups
  const treeNodeById = new Map<number, ModuleTreeNode>();
  function indexTree(node: ModuleTreeNode) {
    treeNodeById.set(node.id, node);
    for (const child of node.children) indexTree(child);
  }
  indexTree(rootModule);

  // Get visible modules based on expansion state
  const visibleModules = getSelectiveVisibleModules(rootModule, expandedModules);
  const ancestorMap = buildSelectiveAncestorMap(visibleModules);

  // Remap steps (includes internal self-calls for participant extraction)
  const remappedSteps = remapSteps(flow.steps, ancestorMap);

  // Filter to renderable steps — hide internal flows within collapsed modules
  const renderableSteps = remappedSteps.filter((rs) => rs.fromVisibleId !== rs.toVisibleId);

  // Build original-to-renderable index mapping for sidebar hover
  originalToRemappedIdx = new Map();
  for (let ri = 0; ri < renderableSteps.length; ri++) {
    for (const oi of renderableSteps[ri].originalIndices) {
      originalToRemappedIdx.set(oi, ri);
    }
  }

  // Extract participant order from remapped steps (first-appearance)
  const participantIds: number[] = [];
  const participantSet = new Set<number>();
  for (const rs of remappedSteps) {
    if (!participantSet.has(rs.fromVisibleId)) {
      participantSet.add(rs.fromVisibleId);
      participantIds.push(rs.fromVisibleId);
    }
    if (!participantSet.has(rs.toVisibleId)) {
      participantSet.add(rs.toVisibleId);
      participantIds.push(rs.toVisibleId);
    }
  }

  const participantIndexMap = new Map<number, number>();
  for (let i = 0; i < participantIds.length; i++) {
    participantIndexMap.set(participantIds[i], i);
  }

  // Determine which visible modules belong to which expanded parent
  const visibleToParent = buildVisibleToExpandedParent(visibleModules, expandedModules, treeNodeById);

  // Identify group spans for expanded parents
  const groupSpans = new Map<number, { first: number; last: number; name: string; node: ModuleTreeNode }>();
  for (let i = 0; i < participantIds.length; i++) {
    const parentId = visibleToParent.get(participantIds[i]);
    if (parentId === undefined) continue;
    const existing = groupSpans.get(parentId);
    if (existing) {
      existing.last = i;
    } else {
      const parentNode = treeNodeById.get(parentId);
      groupSpans.set(parentId, {
        first: i,
        last: i,
        name: parentNode?.name ?? `Module ${parentId}`,
        node: parentNode!,
      });
    }
  }

  // Compute nesting level for each group span (how many ancestor containers wrap it)
  const groupNestingLevel = new Map<number, number>();
  for (const [parentId] of groupSpans) {
    let level = 0;
    let ancestorId = treeNodeById.get(parentId)?.parentId ?? null;
    while (ancestorId !== null) {
      if (groupSpans.has(ancestorId)) level++;
      ancestorId = treeNodeById.get(ancestorId)?.parentId ?? null;
    }
    groupNestingLevel.set(parentId, level);
  }
  const maxNestingLevel = groupSpans.size > 0 ? Math.max(...groupNestingLevel.values()) + 1 : 0;

  // Calculate diagram dimensions
  const diagramWidth = participantIds.length * (PARTICIPANT_WIDTH + PARTICIPANT_GAP) - PARTICIPANT_GAP;
  const headerOffset = maxNestingLevel * (GROUP_HEADER_HEIGHT + CONTAINER_PAD);

  // Create zoom group
  const g = svg.append('g');

  // Define arrowhead markers
  const defs = svg.append('defs');

  defs
    .append('marker')
    .attr('id', 'seq-arrowhead')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 10)
    .attr('refY', 0)
    .attr('markerWidth', 8)
    .attr('markerHeight', 8)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-4L10,0L0,4')
    .attr('fill', flowColor);

  // Setup zoom
  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.2, 4])
    .on('zoom', (event) => {
      g.attr('transform', event.transform.toString());
    });

  svg.call(zoom);

  // Get branch-colored fill/stroke for participant box using tree node data
  function getParticipantColors(moduleId: number): { fill: string; stroke: string } {
    const treeNode = treeNodeById.get(moduleId);
    const mod = moduleById.get(moduleId);
    const depth = treeNode?.depth ?? mod?.depth ?? 1;
    const colorIndex = treeNode?.colorIndex ?? mod?.colorIndex ?? 0;
    return getBoxColors(depth, colorIndex);
  }

  // Flow title at top of diagram
  const titleGroup = g.append('g').attr('class', 'seq-title');
  titleGroup
    .append('text')
    .attr('class', 'seq-title-text')
    .attr('x', diagramWidth / 2)
    .attr('y', -20 - headerOffset)
    .attr('text-anchor', 'middle')
    .text(flow.name);

  // Draw nesting containers for expanded modules (behind participant boxes)
  // Sort by nesting level (outermost first) so outer containers render behind inner ones
  const sortedGroupSpans = [...groupSpans.entries()].sort(
    (a, b) => (groupNestingLevel.get(a[0]) ?? 0) - (groupNestingLevel.get(b[0]) ?? 0)
  );
  for (const [parentId, span] of sortedGroupSpans) {
    const parentNode = span.node;
    const nestingLevel = groupNestingLevel.get(parentId) ?? 0;
    const colors = getBoxColors(parentNode.depth, parentNode.colorIndex ?? 0);
    const nestPad = nestingLevel * (CONTAINER_PAD + 1);
    const x1 = span.first * (PARTICIPANT_WIDTH + PARTICIPANT_GAP) - CONTAINER_PAD - nestPad;
    const x2 = span.last * (PARTICIPANT_WIDTH + PARTICIPANT_GAP) + PARTICIPANT_WIDTH + CONTAINER_PAD + nestPad;
    // Each nesting level shifts the container up by one header+pad layer
    const containerY = -(GROUP_HEADER_HEIGHT + CONTAINER_PAD) * (nestingLevel + 1);
    const containerHeight =
      (GROUP_HEADER_HEIGHT + CONTAINER_PAD) * (nestingLevel + 1) + PARTICIPANT_HEIGHT + CONTAINER_PAD;

    const containerGroup = g.append('g').attr('class', 'seq-group-container');

    // Background rectangle wrapping the child participants
    containerGroup
      .append('rect')
      .attr('x', x1)
      .attr('y', containerY)
      .attr('width', x2 - x1)
      .attr('height', containerHeight)
      .attr('rx', 8)
      .attr('ry', 8)
      .attr('fill', colors.fill)
      .attr('stroke', colors.stroke)
      .attr('stroke-width', 1.5);

    // Parent name label at top of container
    containerGroup
      .append('text')
      .attr('class', 'seq-group-label')
      .attr('x', x1 + CONTAINER_PAD + 2)
      .attr('y', containerY + GROUP_HEADER_HEIGHT / 2 + CONTAINER_PAD / 2)
      .attr('dominant-baseline', 'central')
      .text(`${span.name} ▾`);

    // Click to collapse
    containerGroup.style('cursor', 'pointer').on('click', () => {
      expandedModules.delete(parentId);
      // Also remove any expanded descendants
      function removeDescendants(node: ModuleTreeNode) {
        for (const child of node.children) {
          expandedModules.delete(child.id);
          removeDescendants(child);
        }
      }
      removeDescendants(parentNode);
      renderSequenceDiagram(store);
      // Re-wire sidebar hover handlers with updated mapping
      rewireSidebarStepHovers(store);
    });
  }

  // Draw participant boxes and lifelines
  const lifelineEnd = TOP_PADDING + renderableSteps.length * MESSAGE_ROW_HEIGHT + 20;
  for (let i = 0; i < participantIds.length; i++) {
    const moduleId = participantIds[i];
    const treeNode = treeNodeById.get(moduleId);
    const mod = moduleById.get(moduleId);
    const name = treeNode?.name ?? mod?.name ?? `Module ${moduleId}`;
    const x = i * (PARTICIPANT_WIDTH + PARTICIPANT_GAP);
    const hasChildren = (treeNode?.children.length ?? 0) > 0;

    const participantGroup = g.append('g').attr('class', `seq-participant${hasChildren ? ' expandable' : ''}`);

    // Participant box
    participantGroup
      .append('rect')
      .attr('x', x)
      .attr('y', 0)
      .attr('width', PARTICIPANT_WIDTH)
      .attr('height', PARTICIPANT_HEIGHT)
      .attr('rx', 6)
      .attr('ry', 6)
      .attr('fill', getParticipantColors(moduleId).fill)
      .attr('stroke', getParticipantColors(moduleId).stroke)
      .attr('stroke-width', 1.5);

    // Participant label — wrap to two lines
    const lines = wrapText(name, 16);
    const textEl = participantGroup
      .append('text')
      .attr('x', x + PARTICIPANT_WIDTH / 2)
      .attr('text-anchor', 'middle');
    if (lines.length === 1) {
      textEl
        .attr('y', PARTICIPANT_HEIGHT / 2)
        .attr('dominant-baseline', 'central')
        .text(lines[0]);
    } else {
      textEl
        .append('tspan')
        .attr('x', x + PARTICIPANT_WIDTH / 2)
        .attr('y', PARTICIPANT_HEIGHT / 2 - 7)
        .text(lines[0]);
      textEl
        .append('tspan')
        .attr('x', x + PARTICIPANT_WIDTH / 2)
        .attr('y', PARTICIPANT_HEIGHT / 2 + 7)
        .text(lines[1]);
    }
    textEl.append('title').text(name);

    // Expand indicator for modules with children
    if (hasChildren) {
      participantGroup
        .append('text')
        .attr('class', 'seq-expand-indicator')
        .attr('x', x + PARTICIPANT_WIDTH - 10)
        .attr('y', PARTICIPANT_HEIGHT - 6)
        .attr('text-anchor', 'middle')
        .text('▸');

      // Click to expand
      participantGroup.style('cursor', 'pointer').on('click', () => {
        expandedModules.add(moduleId);
        renderSequenceDiagram(store);
        rewireSidebarStepHovers(store);
      });
    }

    // Lifeline
    g.append('line')
      .attr('class', 'seq-lifeline')
      .attr('x1', x + PARTICIPANT_WIDTH / 2)
      .attr('y1', PARTICIPANT_HEIGHT)
      .attr('x2', x + PARTICIPANT_WIDTH / 2)
      .attr('y2', lifelineEnd);
  }

  // Draw renderable message arrows (self-calls hidden until expanded)
  for (let stepIdx = 0; stepIdx < renderableSteps.length; stepIdx++) {
    const rs = renderableSteps[stepIdx];
    const fromIdx = participantIndexMap.get(rs.fromVisibleId);
    const toIdx = participantIndexMap.get(rs.toVisibleId);
    if (fromIdx === undefined || toIdx === undefined) continue;

    const y = TOP_PADDING + stepIdx * MESSAGE_ROW_HEIGHT;
    const fromX = fromIdx * (PARTICIPANT_WIDTH + PARTICIPANT_GAP) + PARTICIPANT_WIDTH / 2;
    const toX = toIdx * (PARTICIPANT_WIDTH + PARTICIPANT_GAP) + PARTICIPANT_WIDTH / 2;

    const messageGroup = g.append('g').attr('class', 'seq-message').attr('data-step-idx', stepIdx);

    // Arrow between two lifelines
    const arrowMargin = 2;
    const actualFromX = fromX + (fromIdx < toIdx ? arrowMargin : -arrowMargin);
    const actualToX = toX + (fromIdx < toIdx ? -arrowMargin : arrowMargin);

    messageGroup
      .append('line')
      .attr('x1', actualFromX)
      .attr('y1', y)
      .attr('x2', actualToX)
      .attr('y2', y)
      .attr('stroke', flowColor)
      .attr('stroke-width', 2)
      .attr('marker-end', 'url(#seq-arrowhead)');

    // Label above the arrow, centered between the two lifelines
    const labelX = (fromX + toX) / 2;
    messageGroup
      .append('text')
      .attr('class', 'seq-message-label')
      .attr('x', labelX)
      .attr('y', y - 10)
      .attr('text-anchor', 'middle')
      .text(getRemappedLabel(rs));

    // Step badge
    const badgeX = fromX - 16;
    const mergedCount = rs.originalIndices.length;

    if (mergedCount > 1) {
      // Merged step: pill-shaped badge with xN
      const badgeGroup = messageGroup.append('g').attr('class', 'seq-merged-badge');
      const label = `\u00d7${mergedCount}`;
      const pillWidth = 28;
      const pillHeight = 18;
      badgeGroup
        .append('rect')
        .attr('x', badgeX - pillWidth / 2)
        .attr('y', y - pillHeight / 2)
        .attr('width', pillWidth)
        .attr('height', pillHeight)
        .attr('rx', pillHeight / 2)
        .attr('ry', pillHeight / 2);
      badgeGroup
        .append('text')
        .attr('x', badgeX)
        .attr('y', y)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .text(label);
    } else {
      // Single step: circle badge with step number
      messageGroup
        .append('circle')
        .attr('class', 'seq-step-badge-circle')
        .attr('cx', badgeX)
        .attr('cy', y)
        .attr('r', 10);

      messageGroup
        .append('text')
        .attr('class', 'seq-step-badge')
        .attr('x', badgeX)
        .attr('y', y)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .text(rs.originalIndices[0] + 1);
    }
  }

  // Zoom-to-fit after all content is drawn
  const contentBounds = g.node()!.getBBox();
  fitToViewport(svg, zoom, contentBounds);
}

function wrapText(text: string, maxCharsPerLine: number): [string] | [string, string] {
  if (text.length <= maxCharsPerLine) return [text];
  // Find a break point near the middle, preferring word boundaries
  const mid = Math.ceil(text.length / 2);
  let breakIdx = text.lastIndexOf(' ', mid);
  if (breakIdx <= 0) breakIdx = text.indexOf(' ', mid);
  if (breakIdx <= 0) breakIdx = mid; // no spaces, just split
  return [text.slice(0, breakIdx).trim(), text.slice(breakIdx).trim()];
}

function highlightRemappedStep(stepIdx: number) {
  d3.selectAll('.seq-message').classed('dimmed', function () {
    return Number.parseInt(d3.select(this).attr('data-step-idx') || '-1') !== stepIdx;
  });
}

function clearStepHighlight() {
  d3.selectAll('.seq-message').classed('dimmed', false);
}

/** Re-wire sidebar step hover handlers after diagram re-render */
function rewireSidebarStepHovers(store: Store) {
  const state = store.getState();
  const flowId = state.selectedFlowId;
  if (!flowId) return;

  document.querySelectorAll('.step-item').forEach((item) => {
    const newItem = item.cloneNode(true) as HTMLElement;
    item.parentNode?.replaceChild(newItem, item);

    newItem.addEventListener('mouseenter', () => {
      const origIdx = Number.parseInt(newItem.getAttribute('data-step-idx') || '0');
      const remappedIdx = originalToRemappedIdx.get(origIdx);
      if (remappedIdx !== undefined) {
        highlightRemappedStep(remappedIdx);
      }
    });

    newItem.addEventListener('mouseleave', () => {
      clearStepHighlight();
    });
  });
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

  // Tier header toggle
  document.querySelectorAll('.flow-tier-header').forEach((header) => {
    header.addEventListener('click', () => {
      const group = header.closest('.flow-tier-group');
      if (group) {
        group.classList.toggle('collapsed');
        const toggle = header.querySelector('.tier-toggle');
        if (toggle) {
          toggle.textContent = group.classList.contains('collapsed') ? '▶' : '▼';
        }
      }
    });
  });

  // Flow item clicks
  document.querySelectorAll('.flow-item').forEach((item) => {
    item.addEventListener('click', () => {
      const flowId = Number.parseInt(item.getAttribute('data-flow-id') || '0');

      // Reset expansion state on flow change
      expandedModules = new Set<number>();

      // Single-select: clear others, select this one
      selectFlow(store, flowId);

      // Update selected state
      document.querySelectorAll('.flow-item').forEach((el) => {
        el.classList.toggle('selected', el.getAttribute('data-flow-id') === String(flowId));
      });

      // Show steps in sidebar
      showFlowSteps(store, flowId);

      // Render sequence diagram
      renderSequenceDiagram(store);
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

        showSequencePlaceholder();
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

  // Build steps HTML with tree structure showing module paths
  const stepsHtml = flow.steps
    .map((step, idx) => {
      // Find module names from IDs
      const fromModule = state.flowsDagData?.modules.find((m) => m.id === step.fromModuleId);
      const toModule = state.flowsDagData?.modules.find((m) => m.id === step.toModuleId);

      return `
        <div class="step-item step-tree" data-step-idx="${idx}">
          <div class="step-tree-header">
            <span class="step-number">${idx + 1}</span>
            <span class="step-semantic">${step.semantic || step.toDefName || `Step ${idx + 1}`}</span>
          </div>
          <div class="step-tree-path">
            <span class="step-module from">${step.fromDefName || fromModule?.name || 'Unknown'}</span>
            <span class="step-arrow">\u2192</span>
            <span class="step-module to">${step.toDefName || toModule?.name || 'Unknown'}</span>
          </div>
        </div>
      `;
    })
    .join('');

  sidebarContent.innerHTML = `
    <div class="steps-back-btn" id="steps-back-btn">
      <span class="back-icon">\u2190</span>
      <span>Back to flows</span>
    </div>
    <div class="steps-flow-title">${flow.name}</div>
    ${flow.description ? `<div class="steps-flow-description">${flow.description}</div>` : ''}
    <div class="steps-list">
      ${stepsHtml || '<div style="padding: 16px; color: #858585;">No steps</div>'}
    </div>
  `;

  // Setup back button
  document.getElementById('steps-back-btn')?.addEventListener('click', () => {
    goBackToFlowsList(store);
  });

  // Setup step hover handlers — use remapped index for highlight
  document.querySelectorAll('.step-item').forEach((item) => {
    item.addEventListener('mouseenter', () => {
      const origIdx = Number.parseInt(item.getAttribute('data-step-idx') || '0');
      const remappedIdx = originalToRemappedIdx.get(origIdx);
      if (remappedIdx !== undefined) {
        highlightRemappedStep(remappedIdx);
      }
    });

    item.addEventListener('mouseleave', () => {
      clearStepHighlight();
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

  // Reset expansion state
  expandedModules = new Set<number>();

  // Re-setup event handlers
  setupSidebarInteractions(store);

  // Show placeholder
  showSequencePlaceholder();
}
