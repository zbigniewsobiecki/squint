import * as d3 from 'd3';
import type { DagModule, Interaction } from '../types/api';
import { getBoxColors } from './module-dag';
import type { ModuleTreeNode } from './module-dag';

export interface InteractionMapModule {
  id: number;
  name: string;
  fullPath: string;
}

export interface InteractionMapModuleSelect {
  kind: 'module';
  module: InteractionMapModule;
  interactions: Interaction[];
}

export interface InteractionMapArrowSelect {
  kind: 'arrow';
  from: InteractionMapModule;
  to: InteractionMapModule;
  interactions: Interaction[];
}

export type InteractionMapSelectEvent = InteractionMapModuleSelect | InteractionMapArrowSelect | null;

interface AggregatedArrow {
  fromId: number;
  toId: number;
  weight: number;
  pattern: string; // 'business' | 'utility'
  interactions: Interaction[];
}

// Build module tree from flat DagModule[] (same pattern as module-dag.ts:66-87)
function buildModuleTree(modules: DagModule[]): ModuleTreeNode | null {
  const moduleById = new Map<number, ModuleTreeNode>();
  for (const m of modules) {
    moduleById.set(m.id, { ...m, children: [], _value: undefined, colorIndex: m.colorIndex ?? 0 });
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

  if (!rootModule && modules.length > 0) {
    rootModule = moduleById.get(modules[0].id)!;
  }

  if (rootModule) computeValue(rootModule);
  return rootModule;
}

function computeValue(node: ModuleTreeNode): number {
  const childrenSum = node.children.reduce((s, c) => s + computeValue(c), 0);
  node._value = node.memberCount + childrenSum;
  if (node._value === 0) node._value = 1;
  return node._value;
}

// Aggregate interactions by (fromModuleId, toModuleId) pair
function aggregateInteractions(interactions: Interaction[]): AggregatedArrow[] {
  const map = new Map<string, AggregatedArrow>();
  for (const ix of interactions) {
    if (ix.fromModuleId === ix.toModuleId) continue;
    if (ix.weight <= 0) continue;

    const key = `${ix.fromModuleId}->${ix.toModuleId}`;
    const existing = map.get(key);
    if (existing) {
      existing.weight += ix.weight;
      existing.interactions.push(ix);
      // If any interaction is business, the arrow is business
      if (ix.pattern === 'business') existing.pattern = 'business';
    } else {
      map.set(key, {
        fromId: ix.fromModuleId,
        toId: ix.toModuleId,
        weight: ix.weight,
        pattern: ix.pattern === 'business' ? 'business' : 'utility',
        interactions: [ix],
      });
    }
  }
  return [...map.values()];
}

// Ray-box intersection: find exit point on rect boundary from center in direction (dx, dy)
function rayBoxIntersection(cx: number, cy: number, hw: number, hh: number, dx: number, dy: number): [number, number] {
  // hw = half-width, hh = half-height
  if (dx === 0 && dy === 0) return [cx, cy];

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  let t: number;
  if (absDx * hh > absDy * hw) {
    // Hits left or right edge
    t = hw / absDx;
  } else {
    // Hits top or bottom edge
    t = hh / absDy;
  }

  return [cx + dx * t, cy + dy * t];
}

export function renderInteractionMap(
  svgSelector: string,
  containerSelector: string,
  modules: DagModule[],
  interactions: Interaction[],
  onSelect?: (event: InteractionMapSelectEvent) => void
): void {
  const mainContainer = document.querySelector(containerSelector);
  if (!mainContainer) return;

  const svgEl = document.querySelector(svgSelector) as SVGSVGElement;
  if (!svgEl) return;
  const width = svgEl.clientWidth;
  const height = svgEl.clientHeight;
  if (width === 0 || height === 0) return;

  const rootModule = buildModuleTree(modules);
  if (!rootModule) return;

  const svg = d3.select<SVGSVGElement, unknown>(svgSelector);
  svg.selectAll('*').remove();
  svg.attr('viewBox', `0 0 ${width} ${height}`);

  const tooltip = d3.select('#tooltip');

  // Build treemap layout
  const hierarchy = d3
    .hierarchy(rootModule)
    .sum((d) => (d.children.length === 0 ? (d._value ?? 1) : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  d3
    .treemap<ModuleTreeNode>()
    .tile(d3.treemapSquarify)
    .size([width, height])
    .paddingTop(22)
    .paddingOuter(6)
    .paddingInner(3)
    .round(true)(hierarchy);

  const root = hierarchy as d3.HierarchyRectangularNode<ModuleTreeNode>;
  const nodes = root.descendants();

  // Build position lookup by module id
  const rectById = new Map<number, { x0: number; y0: number; x1: number; y1: number; cx: number; cy: number }>();
  for (const d of nodes) {
    const rd = d as d3.HierarchyRectangularNode<ModuleTreeNode>;
    rectById.set(rd.data.id, {
      x0: rd.x0,
      y0: rd.y0,
      x1: rd.x1,
      y1: rd.y1,
      cx: (rd.x0 + rd.x1) / 2,
      cy: (rd.y0 + rd.y1) / 2,
    });
  }

  // Build module info lookup
  const moduleInfoById = new Map<number, InteractionMapModule>();
  for (const d of nodes) {
    moduleInfoById.set(d.data.id, {
      id: d.data.id,
      name: d.data.name,
      fullPath: d.data.fullPath,
    });
  }

  // Aggregate arrows
  const allAggregated = aggregateInteractions(interactions);

  // Filter to only arrows between modules that exist in the treemap
  let arrows = allAggregated.filter((a) => rectById.has(a.fromId) && rectById.has(a.toId));

  // If >15 arrow pairs, keep top 15 by weight
  const MAX_ARROWS = 15;
  const arrowCountExceeded = arrows.length > MAX_ARROWS;
  if (arrowCountExceeded) {
    arrows.sort((a, b) => b.weight - a.weight);
    arrows = arrows.slice(0, MAX_ARROWS);
  }

  // Track active selection for sticky highlight
  let activeSelection: { kind: 'module'; id: number } | { kind: 'arrow'; fromId: number; toId: number } | null = null;

  // Create zoom group
  const g = svg.append('g');

  // Background rect (click to deselect)
  g.append('rect')
    .attr('width', width)
    .attr('height', height)
    .attr('fill', 'transparent')
    .on('click', () => {
      activeSelection = null;
      clearHighlight();
      onSelect?.(null);
    });

  // Define arrowhead markers
  const defs = svg.append('defs');

  defs
    .append('marker')
    .attr('id', 'imap-arrowhead')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 10)
    .attr('refY', 0)
    .attr('markerWidth', 7)
    .attr('markerHeight', 7)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-4L10,0L0,4')
    .attr('fill', 'var(--text-muted)');

  defs
    .append('marker')
    .attr('id', 'imap-arrowhead-highlight')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 10)
    .attr('refY', 0)
    .attr('markerWidth', 7)
    .attr('markerHeight', 7)
    .attr('orient', 'auto')
    .append('path')
    .attr('d', 'M0,-4L10,0L0,4')
    .attr('fill', 'var(--text-primary)');

  // Module rectangles layer
  const cellsLayer = g.append('g').attr('class', 'imap-cells');

  // Module labels layer
  const labelsLayer = g.append('g').attr('class', 'imap-labels').style('pointer-events', 'none');

  // Arrows layer (on top)
  const arrowsLayer = g.append('g').attr('class', 'imap-arrows');

  // Render rectangles
  const visibleNodes = nodes.filter((d) => d.depth > 0);
  const cells = cellsLayer
    .selectAll<SVGRectElement, d3.HierarchyRectangularNode<ModuleTreeNode>>('rect')
    .data(visibleNodes)
    .join('rect')
    .attr('class', 'imap-cell')
    .attr('x', (d) => (d as d3.HierarchyRectangularNode<ModuleTreeNode>).x0)
    .attr('y', (d) => (d as d3.HierarchyRectangularNode<ModuleTreeNode>).y0)
    .attr('width', (d) => {
      const rd = d as d3.HierarchyRectangularNode<ModuleTreeNode>;
      return Math.max(0, rd.x1 - rd.x0);
    })
    .attr('height', (d) => {
      const rd = d as d3.HierarchyRectangularNode<ModuleTreeNode>;
      return Math.max(0, rd.y1 - rd.y0);
    })
    .attr('fill', (d) => getBoxColors(d.depth, d.data.colorIndex ?? 0).fill)
    .attr('stroke', (d) => getBoxColors(d.depth, d.data.colorIndex ?? 0).stroke)
    .attr('stroke-width', (d) => (d.children ? 1 : 0.5))
    .attr('rx', 2)
    .style('cursor', 'pointer');

  // Render labels
  labelsLayer
    .selectAll<SVGTextElement, d3.HierarchyRectangularNode<ModuleTreeNode>>('text')
    .data(
      visibleNodes.filter((d) => {
        const rd = d as d3.HierarchyRectangularNode<ModuleTreeNode>;
        return rd.x1 - rd.x0 > 50;
      })
    )
    .join('text')
    .attr('class', 'imap-label')
    .attr('x', (d) => (d as d3.HierarchyRectangularNode<ModuleTreeNode>).x0 + 4)
    .attr('y', (d) => (d as d3.HierarchyRectangularNode<ModuleTreeNode>).y0 + 14)
    .text((d) => d.data.name)
    .each(function (d) {
      const rd = d as d3.HierarchyRectangularNode<ModuleTreeNode>;
      const maxW = rd.x1 - rd.x0 - 8;
      const el = this as SVGTextElement;
      if (el.getComputedTextLength() > maxW) {
        let txt = d.data.name;
        while (txt.length > 1 && el.getComputedTextLength() > maxW) {
          txt = txt.slice(0, -1);
          el.textContent = `${txt}\u2026`;
        }
      }
    });

  // Compute arrow paths
  function computeArrowPath(arrow: AggregatedArrow, index: number): string | null {
    const fromRect = rectById.get(arrow.fromId);
    const toRect = rectById.get(arrow.toId);
    if (!fromRect || !toRect) return null;

    const dx = toRect.cx - fromRect.cx;
    const dy = toRect.cy - fromRect.cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return null;

    const fromHw = (fromRect.x1 - fromRect.x0) / 2;
    const fromHh = (fromRect.y1 - fromRect.y0) / 2;
    const toHw = (toRect.x1 - toRect.x0) / 2;
    const toHh = (toRect.y1 - toRect.y0) / 2;

    const [x1, y1] = rayBoxIntersection(fromRect.cx, fromRect.cy, fromHw, fromHh, dx, dy);
    const [x2, y2] = rayBoxIntersection(toRect.cx, toRect.cy, toHw, toHh, -dx, -dy);

    // Quadratic Bezier with perpendicular offset
    const curvature = Math.min(dist * 0.15, 40);
    // Alternate sign for parallel arrows
    const sign = index % 2 === 0 ? 1 : -1;

    // Perpendicular unit vector
    const ndx = dx / dist;
    const ndy = dy / dist;
    const px = -ndy * curvature * sign;
    const py = ndx * curvature * sign;

    const cx = (x1 + x2) / 2 + px;
    const cy2 = (y1 + y2) / 2 + py;

    return `M${x1},${y1} Q${cx},${cy2} ${x2},${y2}`;
  }

  // Render arrows
  const arrowPaths = arrowsLayer
    .selectAll<SVGPathElement, AggregatedArrow>('path')
    .data(arrows)
    .join('path')
    .attr('class', (d) => `imap-arrow imap-arrow-${d.pattern}`)
    .attr('d', (d, i) => computeArrowPath(d, i))
    .attr('fill', 'none')
    .attr('stroke', 'var(--text-muted)')
    .attr('stroke-width', (d) => Math.min(5, Math.max(1.5, d.weight * 0.8)))
    .attr('stroke-opacity', (d) => (d.pattern === 'business' ? 0.25 : 0.2))
    .attr('stroke-dasharray', (d) => (d.pattern === 'utility' ? '5,3' : null))
    .attr('marker-end', 'url(#imap-arrowhead)')
    .style('pointer-events', 'stroke')
    .style('cursor', 'pointer');

  // Arrow count indicator
  if (arrowCountExceeded) {
    g.append('text')
      .attr('class', 'imap-arrow-count')
      .attr('x', width - 10)
      .attr('y', height - 10)
      .attr('text-anchor', 'end')
      .attr('fill', 'var(--text-muted)')
      .attr('font-size', '11px')
      .text(`Showing top ${MAX_ARROWS} of ${allAggregated.length} interactions`);
  }

  // Build interactions-by-module index for sidebar
  function interactionsForModule(moduleId: number): Interaction[] {
    const seen = new Set<number>();
    const result: Interaction[] = [];
    for (const a of allAggregated) {
      if (a.fromId === moduleId || a.toId === moduleId) {
        for (const ix of a.interactions) {
          if (!seen.has(ix.id)) {
            seen.add(ix.id);
            result.push(ix);
          }
        }
      }
    }
    return result;
  }

  // Find connected module IDs for a given module
  function connectedModuleIds(moduleId: number): Set<number> {
    const ids = new Set<number>();
    for (const a of arrows) {
      if (a.fromId === moduleId) ids.add(a.toId);
      if (a.toId === moduleId) ids.add(a.fromId);
    }
    return ids;
  }

  // Highlight functions
  function applyModuleHighlight(moduleId: number) {
    const connected = connectedModuleIds(moduleId);

    cells.style('opacity', (d) => {
      if (d.data.id === moduleId) return 1;
      if (connected.has(d.data.id)) return 1;
      return 0.3;
    });

    arrowPaths
      .attr('stroke-opacity', (d) => {
        if (d.fromId === moduleId || d.toId === moduleId) return 0.9;
        return 0.06;
      })
      .attr('marker-end', (d) => {
        if (d.fromId === moduleId || d.toId === moduleId) return 'url(#imap-arrowhead-highlight)';
        return 'url(#imap-arrowhead)';
      });
  }

  function applyArrowHighlight(fromId: number, toId: number) {
    const involvedIds = new Set([fromId, toId]);

    cells.style('opacity', (d) => {
      return involvedIds.has(d.data.id) ? 1 : 0.3;
    });

    arrowPaths
      .attr('stroke-opacity', (d) => {
        if (d.fromId === fromId && d.toId === toId) return 0.9;
        return 0.06;
      })
      .attr('marker-end', (d) => {
        if (d.fromId === fromId && d.toId === toId) return 'url(#imap-arrowhead-highlight)';
        return 'url(#imap-arrowhead)';
      });
  }

  function clearHighlight() {
    cells.style('opacity', null);
    arrowPaths
      .attr('stroke-opacity', (d) => (d.pattern === 'business' ? 0.25 : 0.2))
      .attr('marker-end', 'url(#imap-arrowhead)');
  }

  // Cell hover + click
  cells
    .on('mouseover', (_event, d) => {
      if (activeSelection) return;
      applyModuleHighlight(d.data.id);

      const ixs = interactionsForModule(d.data.id);
      const outgoing = allAggregated.filter((a) => a.fromId === d.data.id).reduce((s, a) => s + a.weight, 0);
      const incoming = allAggregated.filter((a) => a.toId === d.data.id).reduce((s, a) => s + a.weight, 0);

      tooltip.style('display', 'block').html(`
        <div class="name">${d.data.name}</div>
        <div class="location">${d.data.fullPath}</div>
        <span class="kind">outgoing: ${outgoing}</span>
        <span class="lines">incoming: ${incoming}</span>
        <div class="location">${ixs.length} interaction${ixs.length !== 1 ? 's' : ''}</div>
      `);
    })
    .on('mousemove', (event) => {
      tooltip.style('left', `${event.pageX + 10}px`).style('top', `${event.pageY - 10}px`);
    })
    .on('mouseout', () => {
      tooltip.style('display', 'none');
      if (!activeSelection) clearHighlight();
    })
    .on('click', (event, d) => {
      event.stopPropagation();
      activeSelection = { kind: 'module', id: d.data.id };
      applyModuleHighlight(d.data.id);
      const mod = moduleInfoById.get(d.data.id);
      if (mod) {
        onSelect?.({
          kind: 'module',
          module: mod,
          interactions: interactionsForModule(d.data.id),
        });
      }
    });

  // Arrow hover + click
  arrowPaths
    .on('mouseover', (_event, d) => {
      if (activeSelection) return;
      applyArrowHighlight(d.fromId, d.toId);

      const fromMod = moduleInfoById.get(d.fromId);
      const toMod = moduleInfoById.get(d.toId);
      const semantic = d.interactions[0]?.semantic ?? '';

      tooltip.style('display', 'block').html(`
        <div class="name">${fromMod?.name ?? '?'} &rarr; ${toMod?.name ?? '?'}</div>
        <div class="location">${fromMod?.fullPath ?? ''} &rarr; ${toMod?.fullPath ?? ''}</div>
        <span class="kind">${d.pattern}</span>
        <span class="lines">weight: ${d.weight}</span>
        ${semantic ? `<div class="location" style="margin-top: 4px; font-style: italic;">${semantic}</div>` : ''}
      `);
    })
    .on('mousemove', (event) => {
      tooltip.style('left', `${event.pageX + 10}px`).style('top', `${event.pageY - 10}px`);
    })
    .on('mouseout', () => {
      tooltip.style('display', 'none');
      if (!activeSelection) clearHighlight();
    })
    .on('click', (event, d) => {
      event.stopPropagation();
      activeSelection = { kind: 'arrow', fromId: d.fromId, toId: d.toId };
      applyArrowHighlight(d.fromId, d.toId);
      const fromMod = moduleInfoById.get(d.fromId);
      const toMod = moduleInfoById.get(d.toId);
      if (fromMod && toMod) {
        onSelect?.({
          kind: 'arrow',
          from: fromMod,
          to: toMod,
          interactions: d.interactions,
        });
      }
    });

  // Zoom
  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent([0.3, 4])
    .on('zoom', (event) => {
      g.attr('transform', event.transform.toString());
    });

  svg.call(zoom);
}
