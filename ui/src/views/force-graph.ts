import * as d3 from 'd3';
import type { ApiClient } from '../api/client';
import { getKindColor, getNodeRadius } from '../d3/colors';
import { setupZoom } from '../d3/zoom';
import type { Store } from '../state/store';
import type { SymbolEdge, SymbolNode } from '../types/api';

interface SimulationNode extends SymbolNode, d3.SimulationNodeDatum {}

interface SimulationLink extends d3.SimulationLinkDatum<SimulationNode> {
  semantic: string;
}

let simulation: d3.Simulation<SimulationNode, SimulationLink> | null = null;

export function initForceGraph(store: Store, _api: ApiClient) {
  const state = store.getState();
  const data = state.graphData;

  if (!data || data.nodes.length === 0) {
    showEmptyState();
    return;
  }

  hideLoading();
  renderForceGraph(data.nodes, data.edges);
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

function renderForceGraph(nodes: SymbolNode[], edges: SymbolEdge[]) {
  const container = document.getElementById('graph-container');
  if (!container) return;

  const width = container.clientWidth;
  const height = container.clientHeight;

  const svg = d3.select<SVGSVGElement, unknown>('#graph-svg');
  svg.selectAll('*').remove();

  // Create node id lookup
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Create simulation nodes and links
  const simNodes: SimulationNode[] = nodes.map((n) => ({ ...n }));
  const simLinks: SimulationLink[] = edges
    .filter((e) => nodeById.has(e.source) && nodeById.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      semantic: e.semantic,
    }));

  // Define arrow marker
  svg
    .append('defs')
    .append('marker')
    .attr('id', 'arrowhead')
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
        .distance(150)
    )
    .force('charge', d3.forceManyBody().strength(-300))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force(
      'collision',
      d3.forceCollide<SimulationNode>().radius((d) => getNodeRadius(d.lines) + 15)
    );

  // Create main group with zoom
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
    .attr('marker-end', 'url(#arrowhead)');

  // Draw link labels
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

  // Node circles
  node
    .append('circle')
    .attr('r', (d) => getNodeRadius(d.lines))
    .attr('fill', (d) => getKindColor(d.kind))
    .attr('stroke', (d) => (d.hasAnnotations ? '#6a9955' : '#3c3c3c'))
    .attr('stroke-width', (d) => (d.hasAnnotations ? 2 : 1.5));

  // Node labels
  node
    .append('text')
    .attr('dx', (d) => getNodeRadius(d.lines) + 4)
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

  // Update positions on tick
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
    event.subject.fx = null;
    event.subject.fy = null;
  }
}

export function stopSimulation() {
  if (simulation) {
    simulation.stop();
    simulation = null;
  }
}
