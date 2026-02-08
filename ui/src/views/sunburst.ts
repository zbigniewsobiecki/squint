import * as d3 from 'd3';
import type { ApiClient } from '../api/client';
import { getHierarchyColor, getNodeRadius, getStrokeColor } from '../d3/colors';
import { buildFileHierarchy, buildRelationshipHierarchy } from '../d3/hierarchy';
import type { Store } from '../state/store';
import type { HierarchyNode, RelationshipType } from '../types/api';
// import { setupZoom } from '../d3/zoom';

export function initSunburst(store: Store, _api: ApiClient) {
  const state = store.getState();
  const data = state.graphData;

  if (!data || data.nodes.length === 0) {
    showEmptyState();
    return;
  }

  hideLoading();
  renderSunburstGraph(store);
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

function renderSunburstGraph(store: Store) {
  const state = store.getState();
  const data = state.graphData;
  if (!data) return;

  const container = document.getElementById('graph-container');
  if (!container) return;

  const width = container.clientWidth;
  const height = container.clientHeight;

  const svg = d3.select<SVGSVGElement, unknown>('#graph-svg');
  svg.selectAll('*').remove();

  // Build hierarchy based on selected grouping
  const selectedGrouping = state.selectedGrouping as RelationshipType;
  const hierarchyData =
    selectedGrouping === 'structure'
      ? buildFileHierarchy(data.nodes)
      : buildRelationshipHierarchy(data.nodes, data.edges, selectedGrouping);

  const root = d3.hierarchy(hierarchyData);

  // Count descendants for sizing
  root.count();

  // Sort children by size
  root.sort((a, b) => (b.value || 0) - (a.value || 0));

  // Calculate tree dimensions
  const dx = 20;
  const dy = Math.max(120, width / (root.height + 1));

  // Create tree layout
  const treeLayout = d3
    .tree<HierarchyNode>()
    .nodeSize([dx, dy])
    .separation((a, b) => (a.parent === b.parent ? 1 : 1.5));

  treeLayout(root);

  // Calculate bounds
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;

  root.each((d) => {
    if (d.x !== undefined && d.y !== undefined) {
      if (d.x < x0) x0 = d.x;
      if (d.x > x1) x1 = d.x;
      if (d.y < y0) y0 = d.y;
      if (d.y > y1) y1 = d.y;
    }
  });

  const treeHeight = x1 - x0 + dx * 2;
  const treeWidth = y1 - y0 + dy;

  // Create main group with zoom
  const g = svg.append('g');

  // Set up zoom
  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.1, 4])
    .on('zoom', (event) => {
      g.attr('transform', event.transform.toString());
    });

  svg.call(zoom);

  // Initial transform to center and fit
  const scale = Math.min((width - 100) / treeWidth, (height - 100) / treeHeight, 1);
  const initialX = 50 - y0 * scale;
  const initialY = height / 2 - ((x0 + x1) / 2) * scale;

  svg.call(zoom.transform, d3.zoomIdentity.translate(initialX, initialY).scale(scale));

  // Draw links
  const linkGenerator = d3
    .linkHorizontal<d3.HierarchyLink<HierarchyNode>, d3.HierarchyPointNode<HierarchyNode>>()
    .x((d) => d.y!)
    .y((d) => d.x!);

  g.selectAll('.tree-link')
    .data(root.links())
    .enter()
    .append('path')
    .attr('class', 'tree-link')
    .attr('d', linkGenerator as any);

  // Draw nodes
  const node = g
    .selectAll('.tree-node')
    .data(root.descendants())
    .enter()
    .append('g')
    .attr('class', (d) => {
      let cls = 'tree-node';
      if (d.children && d.data.isDirectory) cls += ' has-children';
      return cls;
    })
    .attr('transform', (d) => `translate(${d.y},${d.x})`);

  // Node circles
  node
    .append('circle')
    .attr('r', (d) => {
      if (d.data.data) {
        const lines = d.data.data.lines || 1;
        return getNodeRadius(lines, 4, 12, 300);
      }
      if (d.data.isFile) {
        return 5;
      }
      if (d.data.isRoot) {
        return 8;
      }
      return 6;
    })
    .attr('fill', (d) => getHierarchyColor(d))
    .attr('stroke', (d) => getStrokeColor(d))
    .attr('stroke-width', (d) => (d.data.data?.hasAnnotations ? 2 : 1));

  // Node labels
  node
    .append('text')
    .attr('dy', '0.31em')
    .attr('x', (d) => (d.children ? -10 : 10))
    .attr('text-anchor', (d) => (d.children ? 'end' : 'start'))
    .text((d) => {
      const name = d.data.name;
      return name.length > 25 ? `${name.substring(0, 22)}...` : name;
    })
    .clone(true)
    .lower()
    .attr('stroke', '#1e1e1e')
    .attr('stroke-width', 3);

  // Tooltip
  const tooltip = d3.select('#tooltip');

  node
    .on('mouseover', (_event, d) => {
      if (d.data.data) {
        const sym = d.data.data;
        const domainHtml = sym.domain
          ? `<div class="domains">${sym.domain.map((dom) => `<span class="domain-tag">${dom}</span>`).join('')}</div>`
          : '';
        const pureHtml =
          sym.pure !== undefined
            ? `<div class="pure ${sym.pure ? 'is-pure' : 'has-side-effects'}">${sym.pure ? 'Pure function' : 'Has side effects'}</div>`
            : '';
        const purposeHtml = sym.purpose ? `<div class="purpose">${sym.purpose}</div>` : '';

        tooltip.style('display', 'block').html(`
          <div class="name">${sym.name}</div>
          <span class="kind kind-${sym.kind}">${sym.kind}</span>
          <span class="lines">${sym.lines} lines</span>
          ${domainHtml}
          ${pureHtml}
          ${purposeHtml}
          <div class="location">${sym.filePath.split('/').slice(-2).join('/')}</div>
        `);
      } else if (!d.data.isRoot) {
        const childCount = d.descendants().filter((c) => c.data.data).length;
        const totalLines = d
          .descendants()
          .filter((c) => c.data.data)
          .reduce((sum, c) => sum + (c.data.data?.lines || 0), 0);
        const type = d.data.isFile ? 'file' : 'directory';

        tooltip.style('display', 'block').html(`
          <div class="name">${d.data.name}</div>
          <span class="kind kind-type">${type}</span>
          <span class="lines">${totalLines} lines</span>
          <div class="location">${childCount} symbols</div>
        `);
      }
    })
    .on('mousemove', (event) => {
      tooltip.style('left', `${event.pageX + 10}px`).style('top', `${event.pageY - 10}px`);
    })
    .on('mouseout', () => {
      tooltip.style('display', 'none');
    });
}
