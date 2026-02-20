import type { Interaction } from '../types/api';
import type { ModuleTreeNode } from './module-dag';
import { getBoxColors } from './module-dag';

const SVG_NS = 'http://www.w3.org/2000/svg';
const NODE_W = 120;
const NODE_PAD_X = 110;
const NODE_GAP = 6;
const MIN_NODE_H = 20;
const TOP_PAD = 50; // Space for sankey header

// ─── Types ───────────────────────────────────────────────────────

export interface SankeyCallbacks {
  onBandHover: (fromModuleId: number | null, toModuleId: number | null) => void;
  onBandClick: (leftMod: ModuleTreeNode, rightMod: ModuleTreeNode, interactions: Interaction[]) => void;
}

export interface OverviewSankeyCallbacks {
  onBandHover: (subModuleId: number | null, peerModuleId: number | null) => void;
  onBandClick: (peerModule: ModuleTreeNode, allInteractionsWithPeer: Interaction[]) => void;
  onNodeClick: (moduleId: number) => void;
}

export interface SankeyRenderResult {
  highlightBand(fromModuleId: number, toModuleId: number): void;
  clearHighlight(): void;
}

interface BandDatum {
  leftSubId: number;
  rightSubId: number;
  weight: number;
  interactions: Interaction[];
  pattern: string;
}

interface SankeyNode {
  id: number;
  mod: ModuleTreeNode;
  totalWeight: number;
  bands: BandDatum[];
  y: number;
  height: number;
}

// ─── Sub-ancestor utilities ──────────────────────────────────────

function getSubmodulesAtDepth(root: ModuleTreeNode, relDepth: number): ModuleTreeNode[] {
  if (root.children.length === 0) return [root];
  const result: ModuleTreeNode[] = [];
  function walk(node: ModuleTreeNode, d: number) {
    if (d === relDepth || node.children.length === 0) {
      result.push(node);
      return;
    }
    for (const child of node.children) walk(child, d + 1);
  }
  for (const child of root.children) walk(child, 1);
  return result;
}

function buildSubAncestorMap(root: ModuleTreeNode, relDepth: number): Map<number, number> {
  const nodes = getSubmodulesAtDepth(root, relDepth);
  const map = new Map<number, number>();
  function mapDesc(node: ModuleTreeNode, visId: number) {
    map.set(node.id, visId);
    for (const child of node.children) mapDesc(child, visId);
  }
  for (const n of nodes) mapDesc(n, n.id);
  return map;
}

// ─── Exported depth utility ──────────────────────────────────────

export function getMaxRelativeDepth(root: ModuleTreeNode): number {
  if (root.children.length === 0) return 0;
  let maxD = 0;
  function walk(node: ModuleTreeNode, d: number) {
    if (node.children.length === 0) {
      maxD = Math.max(maxD, d);
      return;
    }
    for (const child of node.children) walk(child, d + 1);
  }
  for (const child of root.children) walk(child, 1);
  return maxD;
}

// ─── Band path generation ────────────────────────────────────────

function bandPath(x0: number, y0: number, h0: number, x1: number, y1: number, h1: number): string {
  const cp = (x1 - x0) * 0.4;
  return (
    `M${x0},${y0} C${x0 + cp},${y0} ${x1 - cp},${y1} ${x1},${y1}` +
    `L${x1},${y1 + h1} C${x1 - cp},${y1 + h1} ${x0 + cp},${y0 + h0} ${x0},${y0 + h0} Z`
  );
}

// ─── Main render ─────────────────────────────────────────────────

export function renderSankeyView(
  svgEl: SVGSVGElement,
  moduleA: ModuleTreeNode,
  moduleB: ModuleTreeNode,
  interactions: Interaction[],
  sankeyDepth: number,
  containerEl: HTMLElement,
  callbacks: SankeyCallbacks
): SankeyRenderResult {
  clearSankey(svgEl);

  const cw = containerEl.clientWidth || 600;
  const ch = containerEl.clientHeight || 400;
  const availH = ch - TOP_PAD - 20; // bottom padding

  svgEl.setAttribute('viewBox', `0 0 ${cw} ${ch}`);
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Build sub-ancestor maps
  const mapA = buildSubAncestorMap(moduleA, sankeyDepth);
  const mapB = buildSubAncestorMap(moduleB, sankeyDepth);

  const submodsA = getSubmodulesAtDepth(moduleA, sankeyDepth);
  const submodsB = getSubmodulesAtDepth(moduleB, sankeyDepth);

  const subModMapA = new Map(submodsA.map((m) => [m.id, m]));
  const subModMapB = new Map(submodsB.map((m) => [m.id, m]));

  // Determine which side each interaction endpoint falls on
  // A is always left, B is always right
  const bandMap = new Map<string, BandDatum>();

  for (const ix of interactions) {
    let leftSubId: number | undefined;
    let rightSubId: number | undefined;

    const fromInA = mapA.get(ix.fromModuleId);
    const fromInB = mapB.get(ix.fromModuleId);
    const toInA = mapA.get(ix.toModuleId);
    const toInB = mapB.get(ix.toModuleId);

    if (fromInA !== undefined && toInB !== undefined) {
      leftSubId = fromInA;
      rightSubId = toInB;
    } else if (fromInB !== undefined && toInA !== undefined) {
      leftSubId = toInA;
      rightSubId = fromInB;
    }

    if (leftSubId === undefined || rightSubId === undefined) continue;

    const key = `${leftSubId}->${rightSubId}`;
    const existing = bandMap.get(key);
    if (existing) {
      existing.weight += ix.weight;
      existing.interactions.push(ix);
      if (ix.pattern === 'business') existing.pattern = 'business';
    } else {
      bandMap.set(key, {
        leftSubId,
        rightSubId,
        weight: ix.weight,
        interactions: [ix],
        pattern: ix.pattern === 'business' ? 'business' : 'utility',
      });
    }
  }

  const bands = [...bandMap.values()];
  if (bands.length === 0) {
    renderEmptySankey(svgEl, cw, ch);
    return { highlightBand() {}, clearHighlight() {} };
  }

  // Build node data for each column
  const leftNodeMap = new Map<number, SankeyNode>();
  const rightNodeMap = new Map<number, SankeyNode>();

  for (const b of bands) {
    if (!leftNodeMap.has(b.leftSubId)) {
      const mod = subModMapA.get(b.leftSubId);
      if (!mod) continue;
      leftNodeMap.set(b.leftSubId, { id: b.leftSubId, mod, totalWeight: 0, bands: [], y: 0, height: 0 });
    }
    if (!rightNodeMap.has(b.rightSubId)) {
      const mod = subModMapB.get(b.rightSubId);
      if (!mod) continue;
      rightNodeMap.set(b.rightSubId, { id: b.rightSubId, mod, totalWeight: 0, bands: [], y: 0, height: 0 });
    }
    leftNodeMap.get(b.leftSubId)!.totalWeight += b.weight;
    leftNodeMap.get(b.leftSubId)!.bands.push(b);
    rightNodeMap.get(b.rightSubId)!.totalWeight += b.weight;
    rightNodeMap.get(b.rightSubId)!.bands.push(b);
  }

  const leftNodes = [...leftNodeMap.values()].sort((a, b) => b.totalWeight - a.totalWeight);
  const rightNodes = [...rightNodeMap.values()].sort((a, b) => b.totalWeight - a.totalWeight);

  // Layout columns
  layoutColumn(leftNodes, availH, TOP_PAD + 10);
  layoutColumn(rightNodes, availH, TOP_PAD + 10);

  const leftX = NODE_PAD_X + NODE_W; // right edge of left rects
  const rightX = cw - NODE_PAD_X - NODE_W; // left edge of right rects

  // Create defs for gradients
  const defs = document.createElementNS(SVG_NS, 'defs');
  svgEl.appendChild(defs);

  // Create layer groups
  const bandG = document.createElementNS(SVG_NS, 'g');
  bandG.setAttribute('class', 'sankey-bands');
  const nodeG = document.createElementNS(SVG_NS, 'g');
  nodeG.setAttribute('class', 'sankey-nodes');
  const labelG = document.createElementNS(SVG_NS, 'g');
  labelG.setAttribute('class', 'sankey-labels');
  svgEl.appendChild(bandG);
  svgEl.appendChild(nodeG);
  svgEl.appendChild(labelG);

  // Compute band slot positions within each node
  // For each node, bands are stacked; we need to track the "consumed" height
  const leftSlots = new Map<number, number>(); // nodeId -> next y offset within node
  const rightSlots = new Map<number, number>();
  for (const n of leftNodes) leftSlots.set(n.id, 0);
  for (const n of rightNodes) rightSlots.set(n.id, 0);

  // Sort bands within each node by the connected node on the other side (by weight desc)
  for (const n of leftNodes) {
    n.bands.sort((a, b) => {
      const rA = rightNodeMap.get(a.rightSubId);
      const rB = rightNodeMap.get(b.rightSubId);
      return (rB?.totalWeight ?? 0) - (rA?.totalWeight ?? 0);
    });
  }
  for (const n of rightNodes) {
    n.bands.sort((a, b) => {
      const lA = leftNodeMap.get(a.leftSubId);
      const lB = leftNodeMap.get(b.leftSubId);
      return (lB?.totalWeight ?? 0) - (lA?.totalWeight ?? 0);
    });
  }

  // Pre-compute band heights for left-side ordering
  const bandLeftY = new Map<string, { y: number; h: number }>();
  for (const n of leftNodes) {
    let offset = 0;
    for (const b of n.bands) {
      const h = n.totalWeight > 0 ? (b.weight / n.totalWeight) * n.height : 0;
      const key = `${b.leftSubId}->${b.rightSubId}`;
      bandLeftY.set(key, { y: n.y + offset, h });
      offset += h;
    }
  }

  // Pre-compute band heights for right-side ordering
  const bandRightY = new Map<string, { y: number; h: number }>();
  for (const n of rightNodes) {
    let offset = 0;
    for (const b of n.bands) {
      const h = n.totalWeight > 0 ? (b.weight / n.totalWeight) * n.height : 0;
      const key = `${b.leftSubId}->${b.rightSubId}`;
      bandRightY.set(key, { y: n.y + offset, h });
      offset += h;
    }
  }

  // Render bands
  const bandElements: SVGPathElement[] = [];

  // Tooltip label group — rendered above bands so it's always visible
  const tooltipG = document.createElementNS(SVG_NS, 'g');
  tooltipG.setAttribute('class', 'sankey-tooltip-group');
  // Will be appended after bandG so it renders on top

  let activeBandLabel: SVGGElement | null = null;

  function showBandLabel(b: BandDatum, lInfo: { y: number; h: number }, rInfo: { y: number; h: number }) {
    hideBandLabel();

    const lMod = subModMapA.get(b.leftSubId);
    const rMod = subModMapB.get(b.rightSubId);
    if (!lMod || !rMod) return;

    const midX = (leftX + rightX) / 2;
    const midY = (lInfo.y + lInfo.h / 2 + rInfo.y + rInfo.h / 2) / 2;

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'sankey-band-label');

    // Header line: "ModuleA ↔ ModuleB"
    const LINE_H = 16;
    const MAX_LINES = 8;
    const maxChar = 48;

    const header = document.createElementNS(SVG_NS, 'text');
    header.setAttribute('x', String(midX));
    header.setAttribute('text-anchor', 'middle');
    header.setAttribute('class', 'sankey-band-label-header');
    header.textContent = `${lMod.name} \u2194 ${rMod.name}`;

    // Interaction lines
    const lines: SVGTextElement[] = [header];
    const shown = b.interactions.slice(0, MAX_LINES);
    for (const ix of shown) {
      const fromName = ix.fromModulePath.split('.').pop() || ix.fromModulePath;
      const toName = ix.toModulePath.split('.').pop() || ix.toModulePath;
      const dir = ix.direction === 'bi' ? '\u2194' : '\u2192';
      let desc = ix.semantic || `${fromName} ${dir} ${toName}`;
      if (desc.length > maxChar) desc = `${desc.slice(0, maxChar - 1)}\u2026`;

      const line = document.createElementNS(SVG_NS, 'text');
      line.setAttribute('x', String(midX));
      line.setAttribute('text-anchor', 'middle');
      line.setAttribute('class', 'sankey-band-label-line');
      line.textContent = desc;
      lines.push(line);
    }

    if (b.interactions.length > MAX_LINES) {
      const more = document.createElementNS(SVG_NS, 'text');
      more.setAttribute('x', String(midX));
      more.setAttribute('text-anchor', 'middle');
      more.setAttribute('class', 'sankey-band-label-line');
      more.textContent = `+${b.interactions.length - MAX_LINES} more`;
      lines.push(more);
    }

    // Temporarily append all lines to measure widths
    for (const line of lines) tooltipG.appendChild(line);
    let maxW = 0;
    for (const line of lines) {
      const w = line.getBBox().width;
      if (w > maxW) maxW = w;
    }
    for (const line of lines) tooltipG.removeChild(line);

    // Position lines vertically centered around midY
    const totalH = lines.length * LINE_H;
    const startY = midY - totalH / 2 + LINE_H / 2;
    for (let i = 0; i < lines.length; i++) {
      lines[i].setAttribute('y', String(startY + i * LINE_H));
      lines[i].setAttribute('dominant-baseline', 'central');
    }

    // Background rect
    const padX = 10;
    const padY = 8;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(midX - maxW / 2 - padX));
    rect.setAttribute('y', String(startY - LINE_H / 2 - padY));
    rect.setAttribute('width', String(maxW + padX * 2));
    rect.setAttribute('height', String(totalH + padY * 2));
    rect.setAttribute('rx', '4');

    g.appendChild(rect);
    for (const line of lines) g.appendChild(line);
    tooltipG.appendChild(g);
    activeBandLabel = g;
  }

  function hideBandLabel() {
    if (activeBandLabel) {
      activeBandLabel.remove();
      activeBandLabel = null;
    }
  }

  for (const b of bands) {
    const key = `${b.leftSubId}->${b.rightSubId}`;
    const leftInfo = bandLeftY.get(key);
    const rightInfo = bandRightY.get(key);
    if (!leftInfo || !rightInfo) continue;

    const leftMod = subModMapA.get(b.leftSubId);
    const rightMod = subModMapB.get(b.rightSubId);
    if (!leftMod || !rightMod) continue;

    // Create gradient
    const gradId = `sankey-grad-${b.leftSubId}-${b.rightSubId}`;
    const grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', gradId);
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');
    grad.setAttribute('x1', String(leftX));
    grad.setAttribute('x2', String(rightX));
    const stop1 = document.createElementNS(SVG_NS, 'stop');
    stop1.setAttribute('offset', '0%');
    stop1.setAttribute('stop-color', getBoxColors(leftMod.depth, leftMod.colorIndex ?? 0).stroke);
    const stop2 = document.createElementNS(SVG_NS, 'stop');
    stop2.setAttribute('offset', '100%');
    stop2.setAttribute('stop-color', getBoxColors(rightMod.depth, rightMod.colorIndex ?? 0).stroke);
    grad.appendChild(stop1);
    grad.appendChild(stop2);
    defs.appendChild(grad);

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', bandPath(leftX, leftInfo.y, leftInfo.h, rightX, rightInfo.y, rightInfo.h));
    path.setAttribute('fill', `url(#${gradId})`);
    path.setAttribute('class', `sankey-band${b.pattern === 'utility' ? ' utility' : ''}`);
    path.setAttribute('data-left-id', String(b.leftSubId));
    path.setAttribute('data-right-id', String(b.rightSubId));

    // Capture refs for closure
    const lInfo = leftInfo;
    const rInfo = rightInfo;

    path.addEventListener('mouseenter', () => {
      callbacks.onBandHover(b.leftSubId, b.rightSubId);
      for (const el of bandElements) {
        const isThis = el === path;
        el.classList.toggle('highlighted', isThis);
        el.classList.toggle('dimmed', !isThis);
      }
      showBandLabel(b, lInfo, rInfo);
    });
    path.addEventListener('mouseleave', () => {
      callbacks.onBandHover(null, null);
      for (const el of bandElements) {
        el.classList.remove('highlighted', 'dimmed');
      }
      hideBandLabel();
    });
    path.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onBandClick(leftMod, rightMod, b.interactions);
    });

    bandG.appendChild(path);
    bandElements.push(path);
  }

  // Append tooltip group after bands so labels render on top
  svgEl.appendChild(tooltipG);

  // Render nodes — labels face inward (toward bands) so they never clip outside the SVG
  function renderColumnNodes(nodes: SankeyNode[], x: number, labelSide: 'left' | 'right') {
    for (const n of nodes) {
      const colors = getBoxColors(n.mod.depth, n.mod.colorIndex ?? 0);
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(n.y));
      rect.setAttribute('width', String(NODE_W));
      rect.setAttribute('height', String(Math.max(n.height, 2)));
      rect.setAttribute('rx', '4');
      rect.setAttribute('fill', colors.fill);
      rect.setAttribute('stroke', colors.stroke);
      rect.setAttribute('class', 'sankey-node');

      const g = document.createElementNS(SVG_NS, 'g');
      g.appendChild(rect);
      nodeG.appendChild(g);

      // Label — placed on the inner side (between columns, facing the bands)
      const hasDesc = n.mod.description != null && n.mod.description.length > 0;
      const ixCount = n.bands.reduce((s, b) => s + b.interactions.length, 0);
      const midY = n.y + n.height / 2;

      const name = document.createElementNS(SVG_NS, 'text');
      name.textContent = n.mod.name;
      name.setAttribute('class', 'sankey-label');

      let desc: SVGTextElement | null = null;
      if (hasDesc) {
        desc = document.createElementNS(SVG_NS, 'text');
        desc.textContent = n.mod.description!;
        desc.setAttribute('class', 'sankey-sublabel');
      }

      const sub = document.createElementNS(SVG_NS, 'text');
      sub.textContent = `${ixCount} ix`;
      sub.setAttribute('class', 'sankey-sublabel');

      const nameY = hasDesc ? midY - 10 : midY - 4;
      const descY = midY + 3;
      const subY = hasDesc ? midY + 16 : midY + 10;

      if (labelSide === 'left') {
        const lx = String(x + NODE_W + 8);
        name.setAttribute('x', lx);
        name.setAttribute('y', String(nameY));
        name.setAttribute('text-anchor', 'start');
        if (desc) {
          desc.setAttribute('x', lx);
          desc.setAttribute('y', String(descY));
          desc.setAttribute('text-anchor', 'start');
        }
        sub.setAttribute('x', lx);
        sub.setAttribute('y', String(subY));
        sub.setAttribute('text-anchor', 'start');
      } else {
        const rx = String(x - 8);
        name.setAttribute('x', rx);
        name.setAttribute('y', String(nameY));
        name.setAttribute('text-anchor', 'end');
        if (desc) {
          desc.setAttribute('x', rx);
          desc.setAttribute('y', String(descY));
          desc.setAttribute('text-anchor', 'end');
        }
        sub.setAttribute('x', rx);
        sub.setAttribute('y', String(subY));
        sub.setAttribute('text-anchor', 'end');
      }

      labelG.appendChild(name);
      if (desc) labelG.appendChild(desc);
      labelG.appendChild(sub);
    }
  }

  renderColumnNodes(leftNodes, leftX - NODE_W, 'left');
  renderColumnNodes(rightNodes, rightX, 'right');

  // Return result for external highlighting
  return {
    highlightBand(fromModuleId: number, toModuleId: number) {
      // Try both directions since "from" in the interaction might map to either side
      for (const el of bandElements) {
        const lId = Number(el.getAttribute('data-left-id'));
        const rId = Number(el.getAttribute('data-right-id'));
        const match = (lId === fromModuleId && rId === toModuleId) || (lId === toModuleId && rId === fromModuleId);
        el.classList.toggle('highlighted', match);
        el.classList.toggle('dimmed', !match);
      }
    },
    clearHighlight() {
      for (const el of bandElements) {
        el.classList.remove('highlighted', 'dimmed');
      }
    },
  };
}

// ─── Layout helper ───────────────────────────────────────────────

function layoutColumn(nodes: SankeyNode[], availH: number, topY: number) {
  const totalWeight = nodes.reduce((s, n) => s + n.totalWeight, 0);
  const totalGap = (nodes.length - 1) * NODE_GAP;
  const usableH = Math.max(availH - totalGap, nodes.length * MIN_NODE_H);

  let y = topY;
  for (const n of nodes) {
    const proportion = totalWeight > 0 ? n.totalWeight / totalWeight : 1 / nodes.length;
    n.height = Math.max(MIN_NODE_H, proportion * usableH);
    n.y = y;
    y += n.height + NODE_GAP;
  }
}

// ─── Empty state ─────────────────────────────────────────────────

function renderEmptySankey(svgEl: SVGSVGElement, cw: number, ch: number) {
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', String(cw / 2));
  text.setAttribute('y', String(ch / 2));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.setAttribute('class', 'sankey-label');
  text.textContent = 'No cross-module interactions at this depth';
  svgEl.appendChild(text);
}

// ─── Overview Sankey (selected module submodules ↔ peer modules) ─

export function renderOverviewSankey(
  svgEl: SVGSVGElement,
  selectedModule: ModuleTreeNode,
  interactions: Interaction[],
  peerModules: ModuleTreeNode[],
  ancestorMap: Map<number, number>,
  containerEl: HTMLElement,
  callbacks: OverviewSankeyCallbacks
): SankeyRenderResult {
  clearSankey(svgEl);

  const cw = containerEl.clientWidth || 600;
  const ch = containerEl.clientHeight || 400;
  const availH = ch - TOP_PAD - 20;

  svgEl.setAttribute('viewBox', `0 0 ${cw} ${ch}`);
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Left column is the selected module itself (single node)
  const leftId = selectedModule.id;

  // Peer module lookup
  const peerModMap = new Map(peerModules.map((m) => [m.id, m]));

  // Aggregate one band per peer, group all interactions by peer
  const bandMap = new Map<number, BandDatum>();
  const interactionsByPeer = new Map<number, Interaction[]>();

  for (const ix of interactions) {
    const fromVis = ancestorMap.get(ix.fromModuleId);
    const toVis = ancestorMap.get(ix.toModuleId);
    if (fromVis === undefined || toVis === undefined) continue;

    let rightPeerId: number | undefined;

    if (fromVis === leftId && toVis !== leftId) {
      rightPeerId = toVis;
    } else if (toVis === leftId && fromVis !== leftId) {
      rightPeerId = fromVis;
    } else {
      continue;
    }

    if (!peerModMap.has(rightPeerId)) continue;

    // Group all interactions by peer
    let peerList = interactionsByPeer.get(rightPeerId);
    if (!peerList) {
      peerList = [];
      interactionsByPeer.set(rightPeerId, peerList);
    }
    peerList.push(ix);

    // Aggregate by peer (one band per peer)
    const existing = bandMap.get(rightPeerId);
    if (existing) {
      existing.weight += ix.weight;
      existing.interactions.push(ix);
      if (ix.pattern === 'business') existing.pattern = 'business';
    } else {
      bandMap.set(rightPeerId, {
        leftSubId: leftId,
        rightSubId: rightPeerId,
        weight: ix.weight,
        interactions: [ix],
        pattern: ix.pattern === 'business' ? 'business' : 'utility',
      });
    }
  }

  const bands = [...bandMap.values()];
  if (bands.length === 0) {
    renderEmptySankey(svgEl, cw, ch);
    return { highlightBand() {}, clearHighlight() {} };
  }

  // Build node data — left is a single node (the selected module)
  const leftNode: SankeyNode = { id: leftId, mod: selectedModule, totalWeight: 0, bands: [], y: 0, height: 0 };
  const rightNodeMap = new Map<number, SankeyNode>();

  for (const b of bands) {
    leftNode.totalWeight += b.weight;
    leftNode.bands.push(b);

    if (!rightNodeMap.has(b.rightSubId)) {
      const mod = peerModMap.get(b.rightSubId);
      if (!mod) continue;
      rightNodeMap.set(b.rightSubId, { id: b.rightSubId, mod, totalWeight: 0, bands: [], y: 0, height: 0 });
    }
    rightNodeMap.get(b.rightSubId)!.totalWeight += b.weight;
    rightNodeMap.get(b.rightSubId)!.bands.push(b);
  }

  const leftNodes = [leftNode];
  const rightNodes = [...rightNodeMap.values()].sort((a, b) => b.totalWeight - a.totalWeight);

  // Layout columns
  layoutColumn(leftNodes, availH, TOP_PAD + 10);
  layoutColumn(rightNodes, availH, TOP_PAD + 10);

  const leftX = NODE_PAD_X + NODE_W;
  const rightX = cw - NODE_PAD_X - NODE_W;

  // Create defs for gradients
  const defs = document.createElementNS(SVG_NS, 'defs');
  svgEl.appendChild(defs);

  // Create layer groups
  const bandG = document.createElementNS(SVG_NS, 'g');
  bandG.setAttribute('class', 'sankey-bands');
  const nodeG = document.createElementNS(SVG_NS, 'g');
  nodeG.setAttribute('class', 'sankey-nodes');
  const labelG = document.createElementNS(SVG_NS, 'g');
  labelG.setAttribute('class', 'sankey-labels');
  svgEl.appendChild(bandG);
  svgEl.appendChild(nodeG);
  svgEl.appendChild(labelG);

  // Sort bands by right-side weight (single left node, so only sort its bands)
  leftNode.bands.sort((a, b) => {
    const rA = rightNodeMap.get(a.rightSubId);
    const rB = rightNodeMap.get(b.rightSubId);
    return (rB?.totalWeight ?? 0) - (rA?.totalWeight ?? 0);
  });
  // Right nodes each have a single band (one per peer), no sorting needed

  // Pre-compute band heights on left side (all stacked in one node)
  const bandLeftY = new Map<string, { y: number; h: number }>();
  {
    let offset = 0;
    for (const b of leftNode.bands) {
      const h = leftNode.totalWeight > 0 ? (b.weight / leftNode.totalWeight) * leftNode.height : 0;
      const key = `${b.leftSubId}->${b.rightSubId}`;
      bandLeftY.set(key, { y: leftNode.y + offset, h });
      offset += h;
    }
  }

  // Right side: each peer node has exactly one band, so band fills the full node
  const bandRightY = new Map<string, { y: number; h: number }>();
  for (const n of rightNodes) {
    for (const b of n.bands) {
      const key = `${b.leftSubId}->${b.rightSubId}`;
      bandRightY.set(key, { y: n.y, h: n.height });
    }
  }

  // Render bands
  const bandElements: SVGPathElement[] = [];

  // Tooltip label group
  const tooltipG = document.createElementNS(SVG_NS, 'g');
  tooltipG.setAttribute('class', 'sankey-tooltip-group');

  let activeBandLabel: SVGGElement | null = null;

  function showBandLabel(b: BandDatum, lInfo: { y: number; h: number }, rInfo: { y: number; h: number }) {
    hideBandLabel();

    const lMod = selectedModule;
    const rMod = peerModMap.get(b.rightSubId);
    if (!rMod) return;

    const midX = (leftX + rightX) / 2;
    const midY = (lInfo.y + lInfo.h / 2 + rInfo.y + rInfo.h / 2) / 2;

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'sankey-band-label');

    const LINE_H = 16;
    const MAX_LINES = 8;
    const maxChar = 48;

    const header = document.createElementNS(SVG_NS, 'text');
    header.setAttribute('x', String(midX));
    header.setAttribute('text-anchor', 'middle');
    header.setAttribute('class', 'sankey-band-label-header');
    header.textContent = `${lMod.name} \u2194 ${rMod.name}`;

    const lines: SVGTextElement[] = [header];
    const shown = b.interactions.slice(0, MAX_LINES);
    for (const ix of shown) {
      const fromName = ix.fromModulePath.split('.').pop() || ix.fromModulePath;
      const toName = ix.toModulePath.split('.').pop() || ix.toModulePath;
      const dir = ix.direction === 'bi' ? '\u2194' : '\u2192';
      let desc = ix.semantic || `${fromName} ${dir} ${toName}`;
      if (desc.length > maxChar) desc = `${desc.slice(0, maxChar - 1)}\u2026`;

      const line = document.createElementNS(SVG_NS, 'text');
      line.setAttribute('x', String(midX));
      line.setAttribute('text-anchor', 'middle');
      line.setAttribute('class', 'sankey-band-label-line');
      line.textContent = desc;
      lines.push(line);
    }

    if (b.interactions.length > MAX_LINES) {
      const more = document.createElementNS(SVG_NS, 'text');
      more.setAttribute('x', String(midX));
      more.setAttribute('text-anchor', 'middle');
      more.setAttribute('class', 'sankey-band-label-line');
      more.textContent = `+${b.interactions.length - MAX_LINES} more`;
      lines.push(more);
    }

    for (const line of lines) tooltipG.appendChild(line);
    let maxW = 0;
    for (const line of lines) {
      const w = line.getBBox().width;
      if (w > maxW) maxW = w;
    }
    for (const line of lines) tooltipG.removeChild(line);

    const totalH = lines.length * LINE_H;
    const startY = midY - totalH / 2 + LINE_H / 2;
    for (let i = 0; i < lines.length; i++) {
      lines[i].setAttribute('y', String(startY + i * LINE_H));
      lines[i].setAttribute('dominant-baseline', 'central');
    }

    const padX = 10;
    const padY = 8;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(midX - maxW / 2 - padX));
    rect.setAttribute('y', String(startY - LINE_H / 2 - padY));
    rect.setAttribute('width', String(maxW + padX * 2));
    rect.setAttribute('height', String(totalH + padY * 2));
    rect.setAttribute('rx', '4');

    g.appendChild(rect);
    for (const line of lines) g.appendChild(line);
    tooltipG.appendChild(g);
    activeBandLabel = g;
  }

  function hideBandLabel() {
    if (activeBandLabel) {
      activeBandLabel.remove();
      activeBandLabel = null;
    }
  }

  for (const b of bands) {
    const key = `${b.leftSubId}->${b.rightSubId}`;
    const leftInfo = bandLeftY.get(key);
    const rightInfo = bandRightY.get(key);
    if (!leftInfo || !rightInfo) continue;

    const leftMod = selectedModule;
    const rightMod = peerModMap.get(b.rightSubId);
    if (!rightMod) continue;

    // Create gradient
    const gradId = `sankey-ov-grad-${b.leftSubId}-${b.rightSubId}`;
    const grad = document.createElementNS(SVG_NS, 'linearGradient');
    grad.setAttribute('id', gradId);
    grad.setAttribute('gradientUnits', 'userSpaceOnUse');
    grad.setAttribute('x1', String(leftX));
    grad.setAttribute('x2', String(rightX));
    const stop1 = document.createElementNS(SVG_NS, 'stop');
    stop1.setAttribute('offset', '0%');
    stop1.setAttribute('stop-color', getBoxColors(leftMod.depth, leftMod.colorIndex ?? 0).stroke);
    const stop2 = document.createElementNS(SVG_NS, 'stop');
    stop2.setAttribute('offset', '100%');
    stop2.setAttribute('stop-color', getBoxColors(rightMod.depth, rightMod.colorIndex ?? 0).stroke);
    grad.appendChild(stop1);
    grad.appendChild(stop2);
    defs.appendChild(grad);

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', bandPath(leftX, leftInfo.y, leftInfo.h, rightX, rightInfo.y, rightInfo.h));
    path.setAttribute('fill', `url(#${gradId})`);
    path.setAttribute('class', `sankey-band${b.pattern === 'utility' ? ' utility' : ''}`);
    path.setAttribute('data-left-id', String(b.leftSubId));
    path.setAttribute('data-right-id', String(b.rightSubId));

    const lInfo = leftInfo;
    const rInfo = rightInfo;

    path.addEventListener('mouseenter', () => {
      callbacks.onBandHover(b.leftSubId, b.rightSubId);
      for (const el of bandElements) {
        const isThis = el === path;
        el.classList.toggle('highlighted', isThis);
        el.classList.toggle('dimmed', !isThis);
      }
      showBandLabel(b, lInfo, rInfo);
    });
    path.addEventListener('mouseleave', () => {
      callbacks.onBandHover(null, null);
      for (const el of bandElements) {
        el.classList.remove('highlighted', 'dimmed');
      }
      hideBandLabel();
    });
    path.addEventListener('click', (e) => {
      e.stopPropagation();
      const allIxs = interactionsByPeer.get(b.rightSubId) ?? b.interactions;
      callbacks.onBandClick(rightMod, allIxs);
    });

    bandG.appendChild(path);
    bandElements.push(path);
  }

  // Append tooltip group after bands
  svgEl.appendChild(tooltipG);

  // Render nodes
  function renderColumnNodes(nodes: SankeyNode[], x: number, labelSide: 'left' | 'right') {
    for (const n of nodes) {
      const colors = getBoxColors(n.mod.depth, n.mod.colorIndex ?? 0);
      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(n.y));
      rect.setAttribute('width', String(NODE_W));
      rect.setAttribute('height', String(Math.max(n.height, 2)));
      rect.setAttribute('rx', '4');
      rect.setAttribute('fill', colors.fill);
      rect.setAttribute('stroke', colors.stroke);
      rect.setAttribute('class', 'sankey-node clickable');
      rect.style.cursor = 'pointer';

      const g = document.createElementNS(SVG_NS, 'g');
      g.appendChild(rect);

      g.addEventListener('click', (e) => {
        e.stopPropagation();
        callbacks.onNodeClick(n.mod.id);
      });

      nodeG.appendChild(g);

      const hasDesc = n.mod.description != null && n.mod.description.length > 0;
      const ixCount = n.bands.reduce((s, b) => s + b.interactions.length, 0);
      const midY = n.y + n.height / 2;

      const name = document.createElementNS(SVG_NS, 'text');
      name.textContent = n.mod.name;
      name.setAttribute('class', 'sankey-label');

      let desc: SVGTextElement | null = null;
      if (hasDesc) {
        desc = document.createElementNS(SVG_NS, 'text');
        desc.textContent = n.mod.description!;
        desc.setAttribute('class', 'sankey-sublabel');
      }

      const sub = document.createElementNS(SVG_NS, 'text');
      sub.textContent = `${ixCount} ix`;
      sub.setAttribute('class', 'sankey-sublabel');

      const nameY = hasDesc ? midY - 10 : midY - 4;
      const descY = midY + 3;
      const subY = hasDesc ? midY + 16 : midY + 10;

      if (labelSide === 'left') {
        const lx = String(x + NODE_W + 8);
        name.setAttribute('x', lx);
        name.setAttribute('y', String(nameY));
        name.setAttribute('text-anchor', 'start');
        if (desc) {
          desc.setAttribute('x', lx);
          desc.setAttribute('y', String(descY));
          desc.setAttribute('text-anchor', 'start');
        }
        sub.setAttribute('x', lx);
        sub.setAttribute('y', String(subY));
        sub.setAttribute('text-anchor', 'start');
      } else {
        const rx = String(x - 8);
        name.setAttribute('x', rx);
        name.setAttribute('y', String(nameY));
        name.setAttribute('text-anchor', 'end');
        if (desc) {
          desc.setAttribute('x', rx);
          desc.setAttribute('y', String(descY));
          desc.setAttribute('text-anchor', 'end');
        }
        sub.setAttribute('x', rx);
        sub.setAttribute('y', String(subY));
        sub.setAttribute('text-anchor', 'end');
      }

      labelG.appendChild(name);
      if (desc) labelG.appendChild(desc);
      labelG.appendChild(sub);
    }
  }

  renderColumnNodes(leftNodes, leftX - NODE_W, 'left');
  renderColumnNodes(rightNodes, rightX, 'right');

  // Return result for external highlighting
  return {
    highlightBand(fromId: number, toId: number) {
      // For overview, highlight all bands connected to the peer module ID
      for (const el of bandElements) {
        const rId = Number(el.getAttribute('data-right-id'));
        const match = rId === fromId || rId === toId;
        el.classList.toggle('highlighted', match);
        el.classList.toggle('dimmed', !match);
      }
    },
    clearHighlight() {
      for (const el of bandElements) {
        el.classList.remove('highlighted', 'dimmed');
      }
    },
  };
}

// ─── Clear ───────────────────────────────────────────────────────

export function clearSankey(svgEl: SVGSVGElement): void {
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
}
