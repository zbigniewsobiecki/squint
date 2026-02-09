import * as d3 from 'd3';
import type { ApiClient } from '../api/client';
import { getFlowColor } from '../d3/colors';
import { getBoxColors } from '../d3/module-dag';
import type { Store } from '../state/store';
import { selectFlow } from '../state/store';
import type { DagFlow, DagModule } from '../types/api';

let originalSidebarHtml: string | null = null;

// Sequence diagram layout constants
const PARTICIPANT_WIDTH = 130;
const PARTICIPANT_GAP = 40;
const PARTICIPANT_HEIGHT = 48;
const MESSAGE_ROW_HEIGHT = 60;
const TOP_PADDING = 80;
const SELF_CALL_WIDTH = 30;
const SELF_CALL_HEIGHT = 30;

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

  // Group flows by tier, then by stakeholder/domain
  const tierNames: Record<number, string> = { 0: 'Atomic', 1: 'Operations', 2: 'Journeys' };
  const tiers = [1, 2, 0]; // Show operations first, journeys, then atomics

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

    // Group by stakeholder within the tier
    const flowsByDomain = new Map<string, DagFlow[]>();
    for (const flow of tierFlows) {
      const domain = flow.stakeholder || 'Uncategorized';
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

    const sortedDomains = [...flowsByDomain.keys()].sort();
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

  // Build module lookup
  const moduleById = new Map<number, DagModule>();
  for (const m of flowsDagData.modules) {
    moduleById.set(m.id, m);
  }

  // Determine unique participants (modules involved in this flow), preserving first-appearance order
  const participantIds: number[] = [];
  const participantSet = new Set<number>();
  for (const step of flow.steps) {
    if (!participantSet.has(step.fromModuleId)) {
      participantSet.add(step.fromModuleId);
      participantIds.push(step.fromModuleId);
    }
    if (!participantSet.has(step.toModuleId)) {
      participantSet.add(step.toModuleId);
      participantIds.push(step.toModuleId);
    }
  }

  const participantIndexMap = new Map<number, number>();
  for (let i = 0; i < participantIds.length; i++) {
    participantIndexMap.set(participantIds[i], i);
  }

  // Calculate diagram dimensions
  const diagramWidth = participantIds.length * (PARTICIPANT_WIDTH + PARTICIPANT_GAP) - PARTICIPANT_GAP;

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

  // Center the diagram
  const containerWidth = mainContainer.clientWidth;
  const initialX = Math.max(20, (containerWidth - diagramWidth) / 2);
  const initialY = 20;
  svg.call(zoom.transform, d3.zoomIdentity.translate(initialX, initialY));

  // Get branch-colored fill/stroke for participant box using data-driven color index
  function getParticipantColors(moduleId: number): { fill: string; stroke: string } {
    const mod = moduleById.get(moduleId);
    const depth = mod?.depth ?? 1;
    const colorIndex = mod?.colorIndex || 0;
    return getBoxColors(depth, colorIndex);
  }

  // Flow title at top of diagram
  const titleGroup = g.append('g').attr('class', 'seq-title');
  titleGroup
    .append('text')
    .attr('class', 'seq-title-text')
    .attr('x', diagramWidth / 2)
    .attr('y', -20)
    .attr('text-anchor', 'middle')
    .text(flow.name);

  // Draw participant boxes and lifelines
  for (let i = 0; i < participantIds.length; i++) {
    const moduleId = participantIds[i];
    const mod = moduleById.get(moduleId);
    const name = mod?.name || `Module ${moduleId}`;
    const x = i * (PARTICIPANT_WIDTH + PARTICIPANT_GAP);

    const participantGroup = g.append('g').attr('class', 'seq-participant');

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

    // Lifeline
    const lifelineEnd = TOP_PADDING + flow.steps.length * MESSAGE_ROW_HEIGHT + 20;
    g.append('line')
      .attr('class', 'seq-lifeline')
      .attr('x1', x + PARTICIPANT_WIDTH / 2)
      .attr('y1', PARTICIPANT_HEIGHT)
      .attr('x2', x + PARTICIPANT_WIDTH / 2)
      .attr('y2', lifelineEnd);
  }

  // Draw message arrows
  for (let stepIdx = 0; stepIdx < flow.steps.length; stepIdx++) {
    const step = flow.steps[stepIdx];
    const fromIdx = participantIndexMap.get(step.fromModuleId);
    const toIdx = participantIndexMap.get(step.toModuleId);
    if (fromIdx === undefined || toIdx === undefined) continue;

    const y = TOP_PADDING + stepIdx * MESSAGE_ROW_HEIGHT;
    const fromX = fromIdx * (PARTICIPANT_WIDTH + PARTICIPANT_GAP) + PARTICIPANT_WIDTH / 2;
    const toX = toIdx * (PARTICIPANT_WIDTH + PARTICIPANT_GAP) + PARTICIPANT_WIDTH / 2;

    const messageGroup = g.append('g').attr('class', 'seq-message').attr('data-step-idx', stepIdx);

    const isSelfCall = step.fromModuleId === step.toModuleId;

    if (isSelfCall) {
      // Self-call: draw a loop arc
      const loopPath = `M${fromX},${y} h${SELF_CALL_WIDTH} v${SELF_CALL_HEIGHT} h${-SELF_CALL_WIDTH}`;
      messageGroup
        .append('path')
        .attr('d', loopPath)
        .attr('fill', 'none')
        .attr('stroke', flowColor)
        .attr('stroke-width', 2)
        .attr('marker-end', 'url(#seq-arrowhead)');

      // Label to the right of the loop
      messageGroup
        .append('text')
        .attr('class', 'seq-message-label')
        .attr('x', fromX + SELF_CALL_WIDTH + 8)
        .attr('y', y + SELF_CALL_HEIGHT / 2)
        .attr('dominant-baseline', 'central')
        .text(step.toDefName || step.semantic || `Step ${stepIdx + 1}`);
    } else {
      // Normal arrow between two lifelines
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
        .text(step.toDefName || step.semantic || `Step ${stepIdx + 1}`);
    }

    // Step number badge
    const badgeX = fromX + (isSelfCall ? -16 : -16);
    messageGroup.append('circle').attr('class', 'seq-step-badge-circle').attr('cx', badgeX).attr('cy', y).attr('r', 10);

    messageGroup
      .append('text')
      .attr('class', 'seq-step-badge')
      .attr('x', badgeX)
      .attr('y', y)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'central')
      .text(stepIdx + 1);
  }
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

function highlightStep(_store: Store, stepIdx: number) {
  // Dim all arrows except the hovered one
  d3.selectAll('.seq-message').classed('dimmed', function () {
    return Number.parseInt(d3.select(this).attr('data-step-idx') || '-1') !== stepIdx;
  });
}

function clearStepHighlight() {
  d3.selectAll('.seq-message').classed('dimmed', false);
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
            <span class="step-semantic">${step.toDefName || step.semantic || `Step ${idx + 1}`}</span>
          </div>
          <div class="step-tree-path">
            <span class="step-module from">${step.fromDefName || fromModule?.name || 'Unknown'}</span>
            <span class="step-arrow">→</span>
            <span class="step-module to">${step.toDefName || toModule?.name || 'Unknown'}</span>
          </div>
        </div>
      `;
    })
    .join('');

  sidebarContent.innerHTML = `
    <div class="steps-back-btn" id="steps-back-btn">
      <span class="back-icon">←</span>
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

  // Setup step hover handlers
  document.querySelectorAll('.step-item').forEach((item) => {
    item.addEventListener('mouseenter', () => {
      const stepIdx = Number.parseInt(item.getAttribute('data-step-idx') || '0');
      highlightStep(store, stepIdx);
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

  // Re-setup event handlers
  setupSidebarInteractions(store);

  // Show placeholder
  showSequencePlaceholder();
}
