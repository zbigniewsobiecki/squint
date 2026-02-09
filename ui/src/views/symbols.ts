import * as d3 from 'd3';
import type { ApiClient } from '../api/client';
import { getKindColor, getNodeRadius } from '../d3/colors';
import { setupZoom } from '../d3/zoom';
import type { Store } from '../state/store';
import { selectSymbol, setSymbolSearch } from '../state/store';
import type { SymbolNode } from '../types/api';

interface SimulationNode extends SymbolNode, d3.SimulationNodeDatum {}

interface SimulationLink extends d3.SimulationLinkDatum<SimulationNode> {
  semantic: string;
}

let simulation: d3.Simulation<SimulationNode, SimulationLink> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

export function initSymbols(store: Store, _api: ApiClient) {
  const state = store.getState();
  const data = state.graphData;

  if (!data || data.nodes.length === 0) {
    showEmptyState();
    return;
  }

  hideLoading();
  renderSymbolsView(store);
}

function hideLoading() {
  const loading = document.getElementById('loading');
  if (loading) loading.style.display = 'none';
}

function showEmptyState() {
  const container = document.getElementById('graph-container');
  if (container) {
    container.innerHTML = `
      <div class="empty-state">
        <h2>No symbols found</h2>
        <p>Index a codebase to see the symbol graph</p>
      </div>
    `;
  }
}

function renderSymbolsView(store: Store) {
  const container = document.getElementById('graph-container');
  if (!container) return;

  const state = store.getState();

  container.innerHTML = `
    <div class="symbols-container">
      <div class="symbols-sidebar${state.sidebarCollapsed ? ' collapsed' : ''}" id="symbols-sidebar">
        <div class="symbols-sidebar-header">
          <h3>Symbols</h3>
          <button class="sidebar-toggle-btn" id="symbols-collapse-btn" title="Collapse sidebar">&#x25C0;</button>
        </div>
        <div class="symbols-search">
          <input type="text" id="symbols-search-input" placeholder="Search symbols..." value="${escapeHtml(state.symbolSearchQuery)}" />
        </div>
        <div class="symbols-sidebar-content" id="symbols-list"></div>
      </div>
      <div class="symbols-main">
        <button class="sidebar-expand-btn" id="symbols-expand-btn" title="Expand sidebar">&#x25B6;</button>
        <div class="symbols-detail" id="symbols-detail"></div>
        <svg id="symbols-force-svg"></svg>
      </div>
    </div>
  `;

  renderSidebarList(store);
  setupEventHandlers(store);

  // Restore selection if any
  if (state.selectedSymbolId !== null) {
    renderDetail(store, state.selectedSymbolId);
    renderNeighborhoodGraph(store, state.selectedSymbolId);
  } else {
    showPlaceholder();
  }
}

function renderSidebarList(store: Store) {
  const state = store.getState();
  const data = state.graphData;
  if (!data) return;

  const listEl = document.getElementById('symbols-list');
  if (!listEl) return;

  const query = state.symbolSearchQuery.toLowerCase();
  const filtered = query
    ? data.nodes.filter(
        (n) =>
          n.name.toLowerCase().includes(query) ||
          n.filePath.toLowerCase().includes(query) ||
          n.kind.toLowerCase().includes(query)
      )
    : data.nodes;

  // Group by kind
  const byKind = new Map<string, SymbolNode[]>();
  for (const node of filtered) {
    const kind = node.kind;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(node);
  }

  // Sort kinds and symbols within
  const sortedKinds = [...byKind.keys()].sort();

  let html = '';
  for (const kind of sortedKinds) {
    const nodes = byKind.get(kind)!;
    nodes.sort((a, b) => a.name.localeCompare(b.name));

    html += `<div class="symbol-kind-header">${kind} (${nodes.length})</div>`;
    for (const node of nodes) {
      const fileParts = node.filePath.split('/');
      const shortPath = fileParts.slice(-2).join('/');
      const isSelected = node.id === state.selectedSymbolId;
      html += `
        <div class="symbol-item${isSelected ? ' selected' : ''}" data-symbol-id="${node.id}">
          <span class="symbol-item-kind kind-${kind}" style="background: ${getKindColor(kind)}; color: #fff;">${kind}</span>
          <span class="symbol-item-name">${escapeHtml(node.name)}</span>
          <span class="symbol-item-file" title="${escapeHtml(node.filePath)}">${escapeHtml(shortPath)}</span>
        </div>
      `;
    }
  }

  if (filtered.length === 0) {
    html =
      '<div style="padding: 16px; color: var(--text-dimmed); text-align: center; font-size: 12px;">No symbols match your search</div>';
  }

  listEl.innerHTML = html;

  // Attach click handlers to symbol items
  listEl.querySelectorAll('.symbol-item').forEach((el) => {
    el.addEventListener('click', () => {
      const id = Number((el as HTMLElement).dataset.symbolId);
      selectSymbol(store, id);
      highlightSelected(id);
      renderDetail(store, id);
      renderNeighborhoodGraph(store, id);
    });
  });
}

function highlightSelected(id: number) {
  document.querySelectorAll('.symbol-item').forEach((el) => {
    el.classList.toggle('selected', Number((el as HTMLElement).dataset.symbolId) === id);
  });
}

function setupEventHandlers(store: Store) {
  // Search input with debounce
  const searchInput = document.getElementById('symbols-search-input') as HTMLInputElement | null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        setSymbolSearch(store, searchInput.value);
        renderSidebarList(store);
      }, 150);
    });
  }

  // Collapse button
  const collapseBtn = document.getElementById('symbols-collapse-btn');
  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      const sidebar = document.getElementById('symbols-sidebar');
      if (sidebar) {
        sidebar.classList.add('collapsed');
        store.setState({ sidebarCollapsed: true });
      }
    });
  }

  // Expand button
  const expandBtn = document.getElementById('symbols-expand-btn');
  if (expandBtn) {
    expandBtn.addEventListener('click', () => {
      const sidebar = document.getElementById('symbols-sidebar');
      if (sidebar) {
        sidebar.classList.remove('collapsed');
        store.setState({ sidebarCollapsed: false });
      }
    });
  }

  // Escape key to deselect
  const keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      selectSymbol(store, null);
      document.querySelectorAll('.symbol-item').forEach((el) => el.classList.remove('selected'));
      const detail = document.getElementById('symbols-detail');
      if (detail) detail.classList.remove('visible');
      stopSimulation();
      showPlaceholder();
    }
  };
  document.addEventListener('keydown', keyHandler);

  // Clean up on next view switch (MutationObserver on container removal)
  const container = document.getElementById('graph-container');
  if (container) {
    const observer = new MutationObserver(() => {
      if (!document.getElementById('symbols-sidebar')) {
        document.removeEventListener('keydown', keyHandler);
        stopSimulation();
        observer.disconnect();
      }
    });
    observer.observe(container, { childList: true });
  }
}

function renderDetail(store: Store, symbolId: number) {
  const state = store.getState();
  const data = state.graphData;
  if (!data) return;

  const node = data.nodes.find((n) => n.id === symbolId);
  if (!node) return;

  const detailEl = document.getElementById('symbols-detail');
  if (!detailEl) return;

  // Count connections
  const incoming = data.edges.filter((e) => e.target === symbolId).length;
  const outgoing = data.edges.filter((e) => e.source === symbolId).length;

  const fileParts = node.filePath.split('/');
  const shortPath = fileParts.slice(-2).join('/');

  let html = `
    <div class="symbol-detail-header">
      <span class="symbol-detail-name">${escapeHtml(node.name)}</span>
      <span class="symbol-detail-kind kind-${node.kind}" style="background: ${getKindColor(node.kind)}; color: #fff;">${node.kind}</span>
    </div>
    <div class="symbol-detail-meta">
      <span title="${escapeHtml(node.filePath)}">${escapeHtml(shortPath)}</span>
      <span>${node.lines} lines</span>
      ${node.moduleName ? `<span>Module: ${escapeHtml(node.moduleName)}</span>` : ''}
    </div>
  `;

  if (node.pure !== undefined) {
    html += `<span class="symbol-detail-badge ${node.pure ? 'is-pure' : 'has-side-effects'}">${node.pure ? 'Pure function' : 'Has side effects'}</span>`;
  }

  if (node.purpose) {
    html += `<div class="symbol-detail-purpose">${escapeHtml(node.purpose)}</div>`;
  }

  if (node.domain && node.domain.length > 0) {
    html += `<div class="symbol-detail-domains">${node.domain.map((d) => `<span class="domain-tag">${escapeHtml(d)}</span>`).join('')}</div>`;
  }

  html += `<div class="symbol-detail-connections"><span>${incoming}</span> incoming, <span>${outgoing}</span> outgoing connections</div>`;

  detailEl.innerHTML = html;
  detailEl.classList.add('visible');
}

function renderNeighborhoodGraph(store: Store, symbolId: number) {
  const state = store.getState();
  const data = state.graphData;
  if (!data) return;

  stopSimulation();

  // Remove placeholder if present
  const placeholder = document.querySelector('.symbols-placeholder');
  if (placeholder) placeholder.remove();

  const svg = d3.select<SVGSVGElement, unknown>('#symbols-force-svg');
  svg.selectAll('*').remove();

  const svgNode = svg.node();
  if (!svgNode) return;

  const rect = svgNode.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;

  if (width === 0 || height === 0) return;

  // Build ego-network
  const neighborEdges = data.edges.filter((e) => e.source === symbolId || e.target === symbolId);
  const neighborIds = new Set<number>();
  neighborIds.add(symbolId);
  for (const e of neighborEdges) {
    neighborIds.add(e.source);
    neighborIds.add(e.target);
  }

  const nodeById = new Map(data.nodes.map((n) => [n.id, n]));
  const simNodes: SimulationNode[] = [...neighborIds]
    .map((id) => nodeById.get(id))
    .filter((n): n is SymbolNode => n !== undefined)
    .map((n) => {
      const sn: SimulationNode = { ...n };
      // Pin selected node to center
      if (n.id === symbolId) {
        sn.fx = width / 2;
        sn.fy = height / 2;
      }
      return sn;
    });

  const simNodeIds = new Set(simNodes.map((n) => n.id));
  const simLinks: SimulationLink[] = neighborEdges
    .filter((e) => simNodeIds.has(e.source) && simNodeIds.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      semantic: e.semantic,
    }));

  if (simNodes.length === 0) return;

  // Arrow marker
  svg
    .append('defs')
    .append('marker')
    .attr('id', 'nb-arrowhead')
    .attr('viewBox', '-0 -5 10 10')
    .attr('refX', 20)
    .attr('refY', 0)
    .attr('orient', 'auto')
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .append('path')
    .attr('d', 'M 0,-5 L 10,0 L 0,5')
    .attr('fill', '#4a4a4a');

  // Create simulation
  simulation = d3
    .forceSimulation(simNodes)
    .force(
      'link',
      d3
        .forceLink<SimulationNode, SimulationLink>(simLinks)
        .id((d) => d.id)
        .distance(120)
    )
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force(
      'collision',
      d3.forceCollide<SimulationNode>().radius((d) => getNodeRadius(d.lines) + 10)
    );

  // Main group with zoom
  const g = svg.append('g');
  setupZoom(svg, g);

  // Draw links
  const link = g
    .append('g')
    .attr('class', 'links')
    .selectAll('line')
    .data(simLinks)
    .enter()
    .append('line')
    .attr('class', 'link')
    .attr('stroke', '#4a4a4a')
    .attr('stroke-width', 1.5)
    .attr('marker-end', 'url(#nb-arrowhead)');

  // Link labels
  const linkLabel = g
    .append('g')
    .attr('class', 'link-labels')
    .selectAll('text')
    .data(simLinks)
    .enter()
    .append('text')
    .attr('class', 'link-label')
    .text((d) => {
      const label = d.semantic || '';
      return label.length > 25 ? `${label.substring(0, 22)}...` : label;
    });

  // Draw nodes
  const node = g
    .append('g')
    .attr('class', 'nodes')
    .selectAll<SVGGElement, SimulationNode>('.node')
    .data(simNodes)
    .enter()
    .append('g')
    .attr('class', (d) => `node${d.hasAnnotations ? '' : ' greyed-out'}`)
    .call(d3.drag<SVGGElement, SimulationNode>().on('start', dragstarted).on('drag', dragged).on('end', dragended));

  // Node circles - selected node gets highlight
  node
    .append('circle')
    .attr('r', (d) => (d.id === symbolId ? getNodeRadius(d.lines) * 1.5 : getNodeRadius(d.lines)))
    .attr('fill', (d) => getKindColor(d.kind))
    .attr('stroke', (d) => (d.id === symbolId ? 'var(--accent-blue)' : d.hasAnnotations ? '#6a9955' : '#3c3c3c'))
    .attr('stroke-width', (d) => (d.id === symbolId ? 3 : d.hasAnnotations ? 2 : 1.5));

  // Node labels
  node
    .append('text')
    .attr('dx', (d) => (d.id === symbolId ? getNodeRadius(d.lines) * 1.5 + 4 : getNodeRadius(d.lines) + 4))
    .attr('dy', 4)
    .text((d) => d.name);

  // Tooltip
  const tooltip = d3.select('#tooltip');

  node
    .on('mouseover', (_event, d) => {
      const domainHtml = d.domain
        ? `<div class="domains">${d.domain.map((dom) => `<span class="domain-tag">${dom}</span>`).join('')}</div>`
        : '';
      const pureHtml =
        d.pure !== undefined
          ? `<div class="pure ${d.pure ? 'is-pure' : 'has-side-effects'}">${d.pure ? 'Pure function' : 'Has side effects'}</div>`
          : '';
      const purposeHtml = d.purpose ? `<div class="purpose">${d.purpose}</div>` : '';

      tooltip.style('display', 'block').html(`
        <div class="name">${d.name}</div>
        <span class="kind kind-${d.kind}">${d.kind}</span>
        <span class="lines">${d.lines} lines</span>
        ${domainHtml}
        ${pureHtml}
        ${purposeHtml}
        <div class="location">${d.filePath.split('/').slice(-2).join('/')}</div>
      `);
    })
    .on('mousemove', (event) => {
      tooltip.style('left', `${event.pageX + 10}px`).style('top', `${event.pageY - 10}px`);
    })
    .on('mouseout', () => {
      tooltip.style('display', 'none');
    });

  // Click on neighbor node to navigate
  node.on('click', (_event, d) => {
    if (d.id !== symbolId) {
      selectSymbol(store, d.id);
      highlightSelected(d.id);
      renderDetail(store, d.id);
      renderNeighborhoodGraph(store, d.id);
      // Scroll sidebar to selected
      const itemEl = document.querySelector(`.symbol-item[data-symbol-id="${d.id}"]`);
      if (itemEl) itemEl.scrollIntoView({ block: 'nearest' });
    }
  });

  // Link hover
  link
    .on('mouseover', (_event, d) => {
      const sourceNode = typeof d.source === 'object' ? d.source : nodeById.get(d.source as number);
      const targetNode = typeof d.target === 'object' ? d.target : nodeById.get(d.target as number);
      tooltip.style('display', 'block').html(`
        <div class="name">${sourceNode?.name || d.source} → ${targetNode?.name || d.target}</div>
        <div class="semantic">${d.semantic}</div>
      `);
    })
    .on('mousemove', (event) => {
      tooltip.style('left', `${event.pageX + 10}px`).style('top', `${event.pageY - 10}px`);
    })
    .on('mouseout', () => {
      tooltip.style('display', 'none');
    });

  // Inline legend at bottom-left
  const legend = g
    .append('g')
    .attr('class', 'legend-inline')
    .attr('transform', `translate(20, ${height - 20})`);

  const kinds = [...new Set(simNodes.map((n) => n.kind))].sort();
  kinds.forEach((kind, i) => {
    const lg = legend.append('g').attr('transform', `translate(${i * 90}, 0)`);
    lg.append('circle').attr('r', 5).attr('fill', getKindColor(kind)).attr('cy', -2);
    lg.append('text').attr('x', 10).attr('y', 2).attr('font-size', '10px').attr('fill', 'var(--text-muted)').text(kind);
  });

  // Tick
  simulation.on('tick', () => {
    link
      .attr('x1', (d) => (d.source as SimulationNode).x!)
      .attr('y1', (d) => (d.source as SimulationNode).y!)
      .attr('x2', (d) => (d.target as SimulationNode).x!)
      .attr('y2', (d) => (d.target as SimulationNode).y!);

    linkLabel
      .attr('x', (d) => ((d.source as SimulationNode).x! + (d.target as SimulationNode).x!) / 2)
      .attr('y', (d) => ((d.source as SimulationNode).y! + (d.target as SimulationNode).y!) / 2);

    node.attr('transform', (d) => `translate(${d.x},${d.y})`);
  });

  function dragstarted(event: d3.D3DragEvent<SVGGElement, SimulationNode, SimulationNode>) {
    if (!event.active) simulation?.alphaTarget(0.3).restart();
    event.subject.fx = event.subject.x;
    event.subject.fy = event.subject.y;
  }

  function dragged(event: d3.D3DragEvent<SVGGElement, SimulationNode, SimulationNode>) {
    event.subject.fx = event.x;
    event.subject.fy = event.y;
  }

  function dragended(event: d3.D3DragEvent<SVGGElement, SimulationNode, SimulationNode>) {
    if (!event.active) simulation?.alphaTarget(0);
    // Don't unpin the selected center node
    if (event.subject.id !== symbolId) {
      event.subject.fx = null;
      event.subject.fy = null;
    }
  }
}

function showPlaceholder() {
  const svg = d3.select<SVGSVGElement, unknown>('#symbols-force-svg');
  svg.selectAll('*').remove();

  const detail = document.getElementById('symbols-detail');
  if (detail) detail.classList.remove('visible');

  // Add placeholder text in the main area
  const mainEl = document.querySelector('.symbols-main');
  if (mainEl && !mainEl.querySelector('.symbols-placeholder')) {
    const ph = document.createElement('div');
    ph.className = 'symbols-placeholder';
    ph.textContent = 'Select a symbol to view its neighborhood graph';
    mainEl.insertBefore(ph, mainEl.querySelector('svg'));
  }
}

function stopSimulation() {
  if (simulation) {
    simulation.stop();
    simulation = null;
  }
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
