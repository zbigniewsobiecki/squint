import * as d3 from 'd3';
import type { DagModule } from '../types/api';

export interface ModuleTreeNode extends DagModule {
  children: ModuleTreeNode[];
  _value?: number;
}

export interface ModuleDagResult {
  modulePositions: Map<number, { x: number; y: number; width: number; height: number }>;
  zoomGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
  svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, any>;
}

// Branch hue palette for depth-1 subtrees
const BRANCH_HUES: { hue: number; fillSat: number; strokeSat: number }[] = [
  { hue: 210, fillSat: 35, strokeSat: 45 }, // Blue
  { hue: 175, fillSat: 30, strokeSat: 40 }, // Teal
  { hue: 270, fillSat: 30, strokeSat: 40 }, // Purple
  { hue: 35, fillSat: 35, strokeSat: 45 }, // Amber
  { hue: 140, fillSat: 30, strokeSat: 40 }, // Green
  { hue: 350, fillSat: 30, strokeSat: 40 }, // Rose
];

export function getBoxColors(depth: number, branchIndex: number): { fill: string; stroke: string } {
  if (depth === 0) {
    return { fill: 'hsl(0, 0%, 12%)', stroke: 'hsl(0, 0%, 30%)' };
  }
  const palette = BRANCH_HUES[(branchIndex || 0) % BRANCH_HUES.length];
  const fillLightness = 14 + (depth - 1) * 3;
  const strokeLightness = 32 + (depth - 1) * 3;
  return {
    fill: `hsl(${palette.hue}, ${palette.fillSat}%, ${fillLightness}%)`,
    stroke: `hsl(${palette.hue}, ${palette.strokeSat}%, ${strokeLightness}%)`,
  };
}

function computeValue(node: ModuleTreeNode): number {
  const childrenSum = node.children.reduce((s, c) => s + computeValue(c), 0);
  node._value = node.memberCount + childrenSum;
  if (node._value === 0) node._value = 1;
  return node._value;
}

export function renderModuleDag(
  svgSelector: string,
  containerSelector: string,
  modules: DagModule[],
  onSelect?: (moduleId: number | null) => void
): ModuleDagResult | null {
  const modulePositions = new Map<number, { x: number; y: number; width: number; height: number }>();

  const mainContainer = document.querySelector(containerSelector);
  if (!mainContainer) return null;

  const svg = d3.select<SVGSVGElement, unknown>(svgSelector);
  const svgEl = document.querySelector(svgSelector) as SVGSVGElement;
  const width = svgEl.clientWidth;
  const height = svgEl.clientHeight;

  svg.selectAll('*').remove();

  if (modules.length === 0) return null;

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

  // Compute cumulative values
  computeValue(rootModule);

  // D3 pack layout
  const size = Math.min(width, height);
  const hierarchy = d3
    .hierarchy(rootModule)
    .sum((d) => (d.children.length === 0 ? (d._value ?? 1) : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  const pack = d3.pack<ModuleTreeNode>().size([size, size]).padding(3);

  const root = pack(hierarchy);

  // Color function for circles — all nodes use branch colors from data
  function getCircleColor(d: d3.HierarchyCircularNode<ModuleTreeNode>): string {
    return getBoxColors(d.depth, d.data.colorIndex ?? 0).fill;
  }

  function getCircleStroke(d: d3.HierarchyCircularNode<ModuleTreeNode>): string {
    return getBoxColors(d.depth, d.data.colorIndex ?? 0).stroke;
  }

  // Create zoom group
  const g = svg.append('g');

  // Populate modulePositions
  for (const d of root.descendants()) {
    modulePositions.set(d.data.id, {
      x: d.x - d.r,
      y: d.y - d.r,
      width: d.r * 2,
      height: d.r * 2,
    });
  }

  // Separate layers: circles below, labels above (so labels aren't covered by circles)
  const circleLayer = g.append('g').attr('class', 'circle-layer');
  const labelLayer = g.append('g').attr('class', 'label-layer').style('pointer-events', 'none');

  const descendants = root.descendants();

  // Circle nodes (clickable)
  const circleNode = circleLayer
    .selectAll<SVGGElement, d3.HierarchyCircularNode<ModuleTreeNode>>('g')
    .data(descendants)
    .join('g')
    .attr('class', (d) => {
      const classes = ['module-circle'];
      if (!d.children) classes.push('leaf');
      return classes.join(' ');
    })
    .attr('data-module-id', (d) => d.data.id);

  const circle = circleNode
    .append('circle')
    .attr('fill', (d) => getCircleColor(d))
    .attr('stroke', (d) => getCircleStroke(d));

  // Label nodes (non-interactive, rendered on top)
  const labelNode = labelLayer
    .selectAll<SVGGElement, d3.HierarchyCircularNode<ModuleTreeNode>>('g')
    .data(descendants)
    .join('g');

  const label = labelNode
    .append('text')
    .attr('class', 'module-circle-label')
    .style('display', (d) => (d.parent === root ? 'inline' : 'none'))
    .style('fill-opacity', (d) => (d.parent === root ? 1 : 0))
    .text((d) => d.data.name);

  // Count labels for all non-root circles with symbols
  const countLabel = labelNode
    .filter((d) => d !== root && (d.data._value ?? 0) > 0)
    .append('text')
    .attr('class', 'module-circle-count')
    .style('display', (d) => (d.parent === root ? 'inline' : 'none'))
    .style('fill-opacity', (d) => (d.parent === root ? 1 : 0))
    .attr('dy', '1.2em')
    .text((d) => `${d.data._value ?? 0} symbols`);

  // Click-to-zoom interaction
  let focus = root;
  let view: [number, number, number] = [root.x, root.y, root.r * 2];

  function zoomTo(v: [number, number, number]) {
    const k = size / v[2];
    view = v;
    const translate = (d: d3.HierarchyCircularNode<ModuleTreeNode>) =>
      `translate(${(d.x - v[0]) * k + width / 2},${(d.y - v[1]) * k + height / 2})`;
    circleNode.attr('transform', translate);
    labelNode.attr('transform', translate);
    circle.attr('r', (d) => d.r * k);
  }

  function zoom(_event: MouseEvent | null, d: d3.HierarchyCircularNode<ModuleTreeNode>) {
    focus = d;

    const transition = svg
      .transition()
      .duration(750)
      .tween('zoom', () => {
        const i = d3.interpolateZoom(view, [focus.x, focus.y, focus.r * 2]);
        return (t: number) => zoomTo(i(t));
      });

    label
      .filter(function (d) {
        return d.parent === focus || (this as SVGTextElement).style.display === 'inline';
      })
      .transition(transition as any)
      .style('fill-opacity', (d) => (d.parent === focus ? 1 : 0))
      .on('start', function (d) {
        if (d.parent === focus) (this as SVGTextElement).style.display = 'inline';
      })
      .on('end', function (d) {
        if (d.parent !== focus) (this as SVGTextElement).style.display = 'none';
      });

    countLabel
      .filter(function (d) {
        return d.parent === focus || (this as SVGTextElement).style.display === 'inline';
      })
      .transition(transition as any)
      .style('fill-opacity', (d) => (d.parent === focus ? 1 : 0))
      .on('start', function (d) {
        if (d.parent === focus) (this as SVGTextElement).style.display = 'inline';
      })
      .on('end', function (d) {
        if (d.parent !== focus) (this as SVGTextElement).style.display = 'none';
      });
  }

  // Selection highlight
  function setSelected(moduleId: number | null) {
    circleNode.classed('module-selected', (d) => d.data.id === moduleId);
  }

  // Click handlers
  circleNode.on('click', (event, d) => {
    if (d.children && focus !== d) {
      // Zoom into this node (it has children to reveal)
      zoom(event, d);
    } else if (!d.children && d.parent && d.parent !== focus) {
      // Leaf node: zoom to its parent so the intermediate level is shown
      zoom(event, d.parent);
    }
    setSelected(d.data.id);
    onSelect?.(d.data.id);
    event.stopPropagation();
  });

  svg.on('click', () => {
    zoom(null, root);
    setSelected(null);
    onSelect?.(null);
  });

  // Initial zoom
  zoomTo([root.x, root.y, root.r * 2]);

  return { modulePositions, zoomGroup: g, svg };
}
