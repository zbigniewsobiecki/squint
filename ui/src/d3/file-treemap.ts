import * as d3 from 'd3';
import type { SymbolNode } from '../types/api';

export interface FileTreeNode {
  name: string;
  children?: FileTreeNode[];
  value?: number;
  fullPath?: string;
  symbolCount?: number;
}

/** Find and strip the common directory prefix from all paths. */
function stripCommonPrefix(paths: string[]): { prefix: string; stripped: Map<string, string> } {
  if (paths.length === 0) return { prefix: '', stripped: new Map() };

  const splitPaths = paths.map((p) => p.split('/').filter(Boolean));
  const minLen = Math.min(...splitPaths.map((p) => p.length));

  let commonLen = 0;
  for (let i = 0; i < minLen - 1; i++) {
    const seg = splitPaths[0][i];
    if (splitPaths.every((p) => p[i] === seg)) {
      commonLen = i + 1;
    } else {
      break;
    }
  }

  const prefix = commonLen > 0 ? splitPaths[0].slice(0, commonLen).join('/') : '';
  const stripped = new Map<string, string>();
  for (const p of paths) {
    const parts = p.split('/').filter(Boolean);
    stripped.set(p, parts.slice(commonLen).join('/'));
  }
  return { prefix, stripped };
}

/** Aggregate lines & symbol counts per filePath, then build a nested directory tree. */
export function buildFileTree(nodes: SymbolNode[]): FileTreeNode {
  // Aggregate per file
  const fileMap = new Map<string, { lines: number; symbols: number }>();
  for (const n of nodes) {
    const existing = fileMap.get(n.filePath);
    if (existing) {
      existing.lines += n.lines;
      existing.symbols += 1;
    } else {
      fileMap.set(n.filePath, { lines: n.lines, symbols: 1 });
    }
  }

  // Strip common prefix so we get meaningful top-level groupings
  const { stripped } = stripCommonPrefix([...fileMap.keys()]);

  // Build raw tree
  const root: FileTreeNode = { name: 'root', children: [] };

  for (const [filePath, info] of fileMap) {
    const relativePath = stripped.get(filePath) ?? filePath;
    const parts = relativePath.split('/').filter(Boolean);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;
      if (isLeaf) {
        current.children!.push({
          name: part,
          value: info.lines || 1,
          fullPath: filePath,
          symbolCount: info.symbols,
        });
      } else {
        let child = current.children!.find((c) => c.children && c.name === part);
        if (!child) {
          child = { name: part, children: [] };
          current.children!.push(child);
        }
        current = child;
      }
    }
  }

  // Collapse single-child directory chains
  collapse(root);

  // Compute symbolCount for directories
  computeDirSymbolCount(root);

  return root;
}

function collapse(node: FileTreeNode): void {
  if (!node.children) return;
  for (const child of node.children) collapse(child);

  // Collapse: if this directory has exactly one child and that child is also a directory
  let children: FileTreeNode[] | undefined = node.children;
  while (children && children.length === 1 && children[0].children) {
    const only: FileTreeNode = children[0];
    node.name = node.name === 'root' ? only.name : `${node.name}/${only.name}`;
    node.children = only.children;
    children = node.children;
  }
}

function computeDirSymbolCount(node: FileTreeNode): number {
  if (!node.children) return node.symbolCount ?? 0;
  let total = 0;
  for (const child of node.children) {
    total += computeDirSymbolCount(child);
  }
  node.symbolCount = total;
  return total;
}

export interface FileTreemapControls {
  navigateTo(depth: number): void;
}

export function renderFileTreemap(
  svgSelector: string,
  containerSelector: string,
  data: FileTreeNode,
  onSelect?: (path: string[]) => void
): FileTreemapControls {
  const noop: FileTreemapControls = { navigateTo() {} };
  const mainContainer = document.querySelector(containerSelector);
  if (!mainContainer) return noop;

  const svgEl = document.querySelector(svgSelector) as SVGSVGElement;
  const width = svgEl.clientWidth;
  const height = svgEl.clientHeight;
  if (width === 0 || height === 0) return noop;

  const svg = d3.select<SVGSVGElement, unknown>(svgSelector);
  svg.selectAll('*').remove();
  svg.attr('viewBox', `0 0 ${width} ${height}`);

  const tooltip = d3.select('#tooltip');

  // HSL palette — distinct hues that look good on dark backgrounds, with moderate saturation
  const PALETTE_HUES = [
    { h: 210, s: 45 }, // Blue
    { h: 160, s: 38 }, // Teal
    { h: 280, s: 35 }, // Purple
    { h: 35, s: 45 }, // Amber
    { h: 120, s: 35 }, // Green
    { h: 350, s: 38 }, // Rose
    { h: 195, s: 40 }, // Cyan
    { h: 55, s: 42 }, // Gold
    { h: 310, s: 32 }, // Magenta
    { h: 85, s: 35 }, // Lime
  ];

  // Collect "color roots": expand root children that have sub-directories,
  // so their children each get a distinct hue. Container dirs (like "apps")
  // that just group sub-dirs get a neutral fill instead of one dominant color.
  function collectColorRoots(rootNode: FileTreeNode): FileTreeNode[] {
    const roots: FileTreeNode[] = [];
    for (const child of rootNode.children ?? []) {
      if (child.children?.some((c) => c.children)) {
        // This dir has sub-directories — expand: use its children as color roots
        for (const grandchild of child.children) {
          roots.push(grandchild);
        }
      } else {
        roots.push(child);
      }
    }
    return roots;
  }

  function buildColorIndex(rootNode: FileTreeNode): Map<string, number> {
    const map = new Map<string, number>();
    const colorRoots = collectColorRoots(rootNode);
    for (let i = 0; i < colorRoots.length; i++) {
      assignIndex(colorRoots[i], i % PALETTE_HUES.length, map);
    }
    return map;
  }

  function assignIndex(node: FileTreeNode, idx: number, map: Map<string, number>): void {
    map.set(node.name, idx);
    for (const child of node.children ?? []) {
      assignIndex(child, idx, map);
    }
  }

  function cellFillFromDepth(hueIdx: number, depth: number): string {
    const { h, s } = PALETTE_HUES[hueIdx % PALETTE_HUES.length];
    const l = Math.min(18 + (depth - 1) * 3, 30);
    return `hsl(${h}, ${s}%, ${l}%)`;
  }

  function cellStrokeFromDepth(hueIdx: number, depth: number): string {
    const { h, s } = PALETTE_HUES[hueIdx % PALETTE_HUES.length];
    const l = Math.min(32 + (depth - 1) * 3, 45);
    return `hsl(${h}, ${s}%, ${l}%)`;
  }

  // Zoom stack: track current root for drill-down
  // Each entry is the FileTreeNode data for that zoom level
  const zoomDataStack: FileTreeNode[] = [];
  const zoomBreadcrumb: string[] = [];

  function layout(rootNode: FileTreeNode): d3.HierarchyRectangularNode<FileTreeNode> {
    const hierarchy = d3
      .hierarchy(rootNode)
      .sum((d) => d.value ?? 0)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

    d3
      .treemap<FileTreeNode>()
      .tile(d3.treemapSquarify)
      .size([width, height])
      .paddingOuter(3)
      .paddingTop(19)
      .paddingInner(1)
      .round(true)(hierarchy);

    return hierarchy as d3.HierarchyRectangularNode<FileTreeNode>;
  }

  function renderCurrent() {
    const rootData = zoomDataStack.length > 0 ? zoomDataStack[zoomDataStack.length - 1] : data;

    svg.selectAll('*').remove();

    const colorIndex = buildColorIndex(rootData);

    function cellFill(d: d3.HierarchyRectangularNode<FileTreeNode>): string {
      if (d.depth === 0) return 'var(--bg-primary)';
      const idx = colorIndex.get(d.data.name);
      if (idx === undefined) return 'hsl(0, 0%, 14%)';
      return cellFillFromDepth(idx, d.depth);
    }

    function cellStroke(d: d3.HierarchyRectangularNode<FileTreeNode>): string {
      if (d.depth === 0) return 'var(--border-primary)';
      const idx = colorIndex.get(d.data.name);
      if (idx === undefined) return 'hsl(0, 0%, 28%)';
      return cellStrokeFromDepth(idx, d.depth);
    }

    const root = layout(rootData);
    const nodes = root.descendants();

    // Background rect for click-to-zoom-out
    svg
      .append('rect')
      .attr('width', width)
      .attr('height', height)
      .attr('fill', 'transparent')
      .on('click', () => {
        if (zoomDataStack.length > 0) {
          zoomDataStack.pop();
          zoomBreadcrumb.pop();
          renderCurrent();
          onSelect?.([...zoomBreadcrumb]);
        }
      });

    const cell = svg
      .selectAll<SVGGElement, d3.HierarchyRectangularNode<FileTreeNode>>('g.treemap-cell')
      .data(nodes.filter((d) => d.depth > 0))
      .join('g')
      .attr('class', (d) => (d.children ? 'treemap-cell treemap-dir' : 'treemap-cell treemap-file'))
      .attr('transform', (d) => `translate(${d.x0},${d.y0})`);

    // Rectangles
    cell
      .append('rect')
      .attr('width', (d) => Math.max(0, d.x1 - d.x0))
      .attr('height', (d) => Math.max(0, d.y1 - d.y0))
      .attr('fill', (d) => cellFill(d))
      .attr('stroke', (d) => cellStroke(d))
      .attr('stroke-width', (d) => (d.children ? 1 : 0.5))
      .attr('rx', 2);

    // Directory labels in the padding-top area
    cell
      .filter((d) => !!d.children && d.x1 - d.x0 > 40)
      .append('text')
      .attr('class', 'treemap-dir-label')
      .attr('x', 4)
      .attr('y', 13)
      .text((d) => d.data.name)
      .each(function (d) {
        // Clip text to cell width
        const maxW = d.x1 - d.x0 - 8;
        const el = this as SVGTextElement;
        if (el.getComputedTextLength() > maxW) {
          let txt = d.data.name;
          while (txt.length > 1 && el.getComputedTextLength() > maxW) {
            txt = txt.slice(0, -1);
            el.textContent = `${txt}\u2026`;
          }
        }
      });

    // File labels — name + line count
    const fileCells = cell.filter((d) => !d.children && d.x1 - d.x0 > 40 && d.y1 - d.y0 > 20);

    fileCells
      .append('text')
      .attr('class', 'treemap-file-label')
      .attr('x', 4)
      .attr('y', 13)
      .text((d) => d.data.name)
      .each(function (d) {
        const maxW = d.x1 - d.x0 - 8;
        const el = this as SVGTextElement;
        if (el.getComputedTextLength() > maxW) {
          let txt = d.data.name;
          while (txt.length > 1 && el.getComputedTextLength() > maxW) {
            txt = txt.slice(0, -1);
            el.textContent = `${txt}\u2026`;
          }
        }
      });

    fileCells
      .filter((d) => d.y1 - d.y0 > 32)
      .append('text')
      .attr('class', 'treemap-file-lines')
      .attr('x', 4)
      .attr('y', 25)
      .text((d) => `${d.data.value ?? 0} lines`);

    // Click on directories to zoom in
    cell
      .filter((d) => !!d.children)
      .style('cursor', 'pointer')
      .on('click', (event, d) => {
        event.stopPropagation();
        // Collect full ancestor chain from layout root down to clicked node
        const chain: d3.HierarchyRectangularNode<FileTreeNode>[] = [];
        let cur: d3.HierarchyRectangularNode<FileTreeNode> | null = d;
        while (cur && cur.depth > 0) {
          chain.unshift(cur);
          cur = cur.parent;
        }
        for (const node of chain) {
          zoomDataStack.push(node.data);
          zoomBreadcrumb.push(node.data.name);
        }
        renderCurrent();
        onSelect?.([...zoomBreadcrumb]);
      });

    // Tooltips on all visible cells
    cell
      .on('mouseover', (_event, d) => {
        const path = d.data.fullPath ?? d.data.name;
        const lines = d.value ?? 0;
        const symbols = d.data.symbolCount ?? 0;
        const type = d.children ? 'Directory' : 'File';
        tooltip.style('display', 'block').html(`
          <div class="name">${path}</div>
          <span class="kind">${type}</span>
          <span class="lines">${lines} lines</span>
          <div class="location">${symbols} symbol${symbols !== 1 ? 's' : ''}</div>
        `);
      })
      .on('mousemove', (event) => {
        tooltip.style('left', `${event.pageX + 10}px`).style('top', `${event.pageY - 10}px`);
      })
      .on('mouseout', () => {
        tooltip.style('display', 'none');
      });
  }

  function navigateTo(depth: number) {
    // depth 0 = root, depth 1 = first zoom level, etc.
    while (zoomDataStack.length > depth) {
      zoomDataStack.pop();
      zoomBreadcrumb.pop();
    }
    renderCurrent();
    onSelect?.([...zoomBreadcrumb]);
  }

  // Initial render
  renderCurrent();
  onSelect?.([]);

  return { navigateTo };
}
