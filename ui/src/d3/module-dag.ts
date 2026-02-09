import * as d3 from 'd3';
import type { DagModule } from '../types/api';

export interface ModuleTreeNode extends DagModule {
  children: ModuleTreeNode[];
  _width?: number;
  _height?: number;
  _isLeaf?: boolean;
  _rows?: { children: ModuleTreeNode[]; width: number }[];
  _x?: number;
  _y?: number;
}

export interface ModuleDagResult {
  modulePositions: Map<number, { x: number; y: number; width: number; height: number }>;
  zoomGroup: d3.Selection<SVGGElement, unknown, HTMLElement, any>;
  svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, any>;
}

// Layout constants
const HEADER_HEIGHT = 28;
const PADDING = 12;
const MIN_LEAF_WIDTH = 100;
const MIN_LEAF_HEIGHT = 50;
const GAP = 8;

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
  const palette = BRANCH_HUES[branchIndex % BRANCH_HUES.length];
  const fillLightness = 14 + (depth - 1) * 3;
  const strokeLightness = 32 + (depth - 1) * 3;
  return {
    fill: `hsl(${palette.hue}, ${palette.fillSat}%, ${fillLightness}%)`,
    stroke: `hsl(${palette.hue}, ${palette.strokeSat}%, ${strokeLightness}%)`,
  };
}

export function renderModuleDag(
  svgSelector: string,
  containerSelector: string,
  modules: DagModule[]
): ModuleDagResult | null {
  const modulePositions = new Map<number, { x: number; y: number; width: number; height: number }>();

  const mainContainer = document.querySelector(containerSelector);
  if (!mainContainer) return null;

  const svg = d3.select<SVGSVGElement, unknown>(svgSelector);
  const width = (mainContainer as HTMLElement).clientWidth;
  const height = (mainContainer as HTMLElement).clientHeight;

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

  // Calculate sizes recursively
  function calculateSize(node: ModuleTreeNode) {
    if (node.children.length === 0) {
      const textWidth = Math.max(MIN_LEAF_WIDTH, node.name.length * 7 + 20);
      node._width = textWidth;
      node._height = MIN_LEAF_HEIGHT;
      node._isLeaf = true;
      return;
    }

    for (const child of node.children) {
      calculateSize(child);
    }

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

  // Build branch index map: each depth-1 node gets a sibling index, propagated to descendants
  const branchIndexByModuleId = new Map<number, number>();
  function assignBranchIndex(node: ModuleTreeNode, branchIndex: number) {
    branchIndexByModuleId.set(node.id, branchIndex);
    for (const child of node.children) {
      assignBranchIndex(child, branchIndex);
    }
  }
  for (let i = 0; i < rootModule.children.length; i++) {
    assignBranchIndex(rootModule.children[i], i);
  }

  // Draw module boxes
  function drawModuleBoxes(node: ModuleTreeNode, depth = 0) {
    const isLeaf = node.children.length === 0;
    const branchIndex = branchIndexByModuleId.get(node.id) ?? 0;
    const colors = getBoxColors(depth, branchIndex);
    const group = g
      .append('g')
      .attr('class', `module-box depth-${depth}${isLeaf ? ' leaf' : ''}`)
      .attr('data-module-id', node.id);

    group
      .append('rect')
      .attr('x', node._x || 0)
      .attr('y', node._y || 0)
      .attr('width', node._width || 0)
      .attr('height', node._height || 0)
      .attr('fill', colors.fill)
      .attr('stroke', colors.stroke);

    group
      .append('text')
      .attr('class', `module-box-header depth-${depth}`)
      .attr('x', (node._x || 0) + PADDING)
      .attr('y', (node._y || 0) + 18)
      .text(node.name);

    if (node.memberCount > 0) {
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

  return { modulePositions, zoomGroup: g, svg };
}
