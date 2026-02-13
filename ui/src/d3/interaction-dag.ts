import * as d3 from 'd3';
import { coordSimplex, decrossOpt, graphConnect, sugiyama } from 'd3-dag';
import type { MutGraph } from 'd3-dag';
import type { AggregatedEdge } from './interaction-map';
import type { ModuleTreeNode } from './module-dag';
import { getBoxColors } from './module-dag';

// ─── Constants ───────────────────────────────────────────────────
const NODE_W = 160;
const NODE_H = 52;
const PAD = 40;
const SVG_NS = 'http://www.w3.org/2000/svg';

// ─── Types ───────────────────────────────────────────────────────
interface DagLinkDatum {
  source: string;
  target: string;
  edges: AggregatedEdge[];
  bidirectional: boolean;
  totalWeight: number;
  pattern: string;
}

export interface DagCallbacks {
  onNodeClick: (moduleId: number) => void;
  onLinkHover: (fromId: number | null, toId: number | null) => void;
}

// ─── Data transformation ─────────────────────────────────────────

function buildDagData(selectedId: number, allEdges: AggregatedEdge[], modules: ModuleTreeNode[]) {
  const connected = allEdges.filter((e) => e.fromId === selectedId || e.toId === selectedId);
  if (connected.length === 0) return null;

  // Group edges by peer module, merge bidirectional pairs
  const peerMap = new Map<number, { out: AggregatedEdge | null; in_: AggregatedEdge | null }>();

  for (const e of connected) {
    const peer = e.fromId === selectedId ? e.toId : e.fromId;
    let entry = peerMap.get(peer);
    if (!entry) {
      entry = { out: null, in_: null };
      peerMap.set(peer, entry);
    }
    if (e.fromId === selectedId) entry.out = e;
    else entry.in_ = e;
  }

  const links: DagLinkDatum[] = [];
  const nodeIds = new Set<number>([selectedId]);

  for (const [peer, { out, in_ }] of peerMap) {
    nodeIds.add(peer);
    if (out && in_) {
      // Bidirectional – keep higher-weight direction for the DAG edge
      const primary = out.weight >= in_.weight ? out : in_;
      links.push({
        source: String(primary.fromId),
        target: String(primary.toId),
        edges: [out, in_],
        bidirectional: true,
        totalWeight: out.weight + in_.weight,
        pattern: out.pattern === 'business' || in_.pattern === 'business' ? 'business' : 'utility',
      });
    } else {
      const e = (out ?? in_)!;
      links.push({
        source: String(e.fromId),
        target: String(e.toId),
        edges: [e],
        bidirectional: false,
        totalWeight: e.weight,
        pattern: e.pattern,
      });
    }
  }

  const modMap = new Map(modules.map((m) => [m.id, m]));
  const nodeInfoMap = new Map<number, ModuleTreeNode>();
  for (const id of nodeIds) {
    const m = modMap.get(id);
    if (m) nodeInfoMap.set(id, m);
  }

  // Interaction count per node
  const ixCounts = new Map<number, number>();
  for (const link of links) {
    const total = link.edges.reduce((s, e) => s + e.interactions.length, 0);
    const src = Number(link.source);
    const tgt = Number(link.target);
    ixCounts.set(src, (ixCounts.get(src) ?? 0) + total);
    ixCounts.set(tgt, (ixCounts.get(tgt) ?? 0) + total);
  }

  return { links, nodeInfoMap, ixCounts };
}

// ─── Path trimming ───────────────────────────────────────────────

function rectEdge(cx: number, cy: number, hw: number, hh: number, dx: number, dy: number): [number, number] {
  if (dx === 0 && dy === 0) return [cx, cy];
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const t = ax * hh > ay * hw ? hw / ax : hh / ay;
  return [cx + dx * t, cy + dy * t];
}

function trimPath(
  pts: [number, number][],
  srcCx: number,
  srcCy: number,
  tgtCx: number,
  tgtCy: number
): [number, number][] {
  if (pts.length < 2) return pts;
  const out = pts.map((p) => [p[0], p[1]] as [number, number]);
  // Trim source end
  const s1 = out[1];
  out[0] = rectEdge(srcCx, srcCy, NODE_W / 2, NODE_H / 2, s1[0] - srcCx, s1[1] - srcCy);
  // Trim target end
  const prev = out[out.length - 2];
  out[out.length - 1] = rectEdge(tgtCx, tgtCy, NODE_W / 2, NODE_H / 2, prev[0] - tgtCx, prev[1] - tgtCy);
  return out;
}

// ─── SVG helpers ─────────────────────────────────────────────────

function createMarkerDefs(): SVGDefsElement {
  const defs = document.createElementNS(SVG_NS, 'defs');

  // Forward arrowhead (at path end)
  const fwd = document.createElementNS(SVG_NS, 'marker');
  fwd.setAttribute('id', 'ixdag-arrow');
  fwd.setAttribute('viewBox', '0 -5 10 10');
  fwd.setAttribute('refX', '10');
  fwd.setAttribute('refY', '0');
  fwd.setAttribute('markerWidth', '4');
  fwd.setAttribute('markerHeight', '4');
  fwd.setAttribute('orient', 'auto');
  const fwdPath = document.createElementNS(SVG_NS, 'path');
  fwdPath.setAttribute('d', 'M0,-4L10,0L0,4');
  fwdPath.setAttribute('fill', 'context-stroke');
  fwd.appendChild(fwdPath);
  defs.appendChild(fwd);

  // Reverse arrowhead (at path start, for bidirectional links)
  const rev = document.createElementNS(SVG_NS, 'marker');
  rev.setAttribute('id', 'ixdag-arrow-rev');
  rev.setAttribute('viewBox', '0 -5 10 10');
  rev.setAttribute('refX', '0');
  rev.setAttribute('refY', '0');
  rev.setAttribute('markerWidth', '4');
  rev.setAttribute('markerHeight', '4');
  rev.setAttribute('orient', 'auto');
  const revPath = document.createElementNS(SVG_NS, 'path');
  revPath.setAttribute('d', 'M10,-4L0,0L10,4');
  revPath.setAttribute('fill', 'context-stroke');
  rev.appendChild(revPath);
  defs.appendChild(rev);

  return defs;
}

// ─── Main render ─────────────────────────────────────────────────

export function renderDagView(
  svgEl: SVGSVGElement,
  selectedId: number,
  edges: AggregatedEdge[],
  visibleModules: ModuleTreeNode[],
  containerEl: HTMLElement,
  callbacks: DagCallbacks
): void {
  clearDag(svgEl);

  const data = buildDagData(selectedId, edges, visibleModules);
  if (!data || data.links.length === 0) {
    renderEmpty(svgEl, containerEl);
    return;
  }

  const { links, nodeInfoMap, ixCounts } = data;

  // Build DAG via d3-dag
  let graph: MutGraph<string, DagLinkDatum>;
  try {
    graph = graphConnect()
      .sourceId(({ source }: DagLinkDatum) => source)
      .targetId(({ target }: DagLinkDatum) => target)(links);
  } catch {
    renderEmpty(svgEl, containerEl);
    return;
  }

  // Sugiyama layout (top-to-bottom; we swap x↔y later for left-to-right)
  // nodeSize: [within-layer (→rendered height), between-layer (→rendered width)]
  const layout = sugiyama()
    .nodeSize([NODE_H, NODE_W] as const)
    .gap([60, 80] as const)
    .decross(decrossOpt())
    .coord(coordSimplex());

  let lW: number;
  let lH: number;
  try {
    const result = layout(graph);
    lW = result.width;
    lH = result.height;
  } catch {
    renderEmpty(svgEl, containerEl);
    return;
  }

  // Swap for L→R: rendered width = layoutHeight, rendered height = layoutWidth
  const rW = lH + PAD * 2;
  const rH = lW + PAD * 2;

  svgEl.setAttribute('viewBox', `0 0 ${rW} ${rH}`);
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // Marker defs
  svgEl.appendChild(createMarkerDefs());

  // Layer groups (back → front: links, nodes, labels)
  const linkG = document.createElementNS(SVG_NS, 'g');
  const nodeG = document.createElementNS(SVG_NS, 'g');
  const labelG = document.createElementNS(SVG_NS, 'g');
  svgEl.appendChild(linkG);
  svgEl.appendChild(nodeG);
  svgEl.appendChild(labelG);

  // Node positions (after x↔y swap)
  const nodePos = new Map<string, { cx: number; cy: number }>();
  for (const node of graph.nodes()) {
    nodePos.set(node.data, {
      cx: node.y + PAD, // layout y → rendered x
      cy: node.x + PAD, // layout x → rendered y
    });
  }

  // Line generator with smooth curves
  const line = d3
    .line<[number, number]>()
    .x((d) => d[0])
    .y((d) => d[1])
    .curve(d3.curveBasis);

  // ── Render links ──
  for (const link of graph.links()) {
    const ld = link.data as DagLinkDatum;
    const srcNode = nodeInfoMap.get(Number(link.source.data));
    const srcPos = nodePos.get(link.source.data)!;
    const tgtPos = nodePos.get(link.target.data)!;
    const colors = srcNode ? getBoxColors(srcNode.depth ?? 1, srcNode.colorIndex ?? 0) : { stroke: '#888' };

    // Swap link points for L→R layout and trim to node boundaries
    const rawPts = link.points.map(([x, y]) => [y + PAD, x + PAD] as [number, number]);
    const pts = trimPath(rawPts, srcPos.cx, srcPos.cy, tgtPos.cx, tgtPos.cy);

    const strokeW = Math.max(2, Math.min(6, ld.totalWeight * 0.8));

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', line(pts) ?? '');
    path.setAttribute('class', `ixmap-dag-link${ld.pattern === 'utility' ? ' utility' : ''}`);
    path.setAttribute('stroke', colors.stroke);
    path.setAttribute('stroke-width', String(strokeW));
    path.setAttribute('marker-end', 'url(#ixdag-arrow)');
    if (ld.bidirectional) {
      path.setAttribute('marker-start', 'url(#ixdag-arrow-rev)');
    }
    // Store original from/to for sidebar highlighting
    path.setAttribute('data-from-id', String(ld.edges[0].fromId));
    path.setAttribute('data-to-id', String(ld.edges[0].toId));

    path.addEventListener('mouseenter', () => {
      callbacks.onLinkHover(ld.edges[0].fromId, ld.edges[0].toId);
    });
    path.addEventListener('mouseleave', () => {
      callbacks.onLinkHover(null, null);
    });

    linkG.appendChild(path);
  }

  // ── Render nodes ──
  for (const node of graph.nodes()) {
    const id = Number(node.data);
    const mod = nodeInfoMap.get(id);
    if (!mod) continue;
    const { cx, cy } = nodePos.get(node.data)!;
    const colors = getBoxColors(mod.depth ?? 1, mod.colorIndex ?? 0);
    const isSelected = id === selectedId;

    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `ixmap-dag-node${isSelected ? ' selected' : ''}`);
    g.setAttribute('data-module-id', String(id));

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', String(cx - NODE_W / 2));
    rect.setAttribute('y', String(cy - NODE_H / 2));
    rect.setAttribute('width', String(NODE_W));
    rect.setAttribute('height', String(NODE_H));
    rect.setAttribute('rx', '6');
    rect.setAttribute('fill', colors.fill);
    rect.setAttribute('stroke', colors.stroke);
    g.appendChild(rect);

    g.addEventListener('click', (e) => {
      e.stopPropagation();
      callbacks.onNodeClick(id);
    });

    nodeG.appendChild(g);
  }

  // ── Render labels ──
  for (const node of graph.nodes()) {
    const id = Number(node.data);
    const mod = nodeInfoMap.get(id);
    if (!mod) continue;
    const { cx, cy } = nodePos.get(node.data)!;
    const count = ixCounts.get(id) ?? 0;

    const name = document.createElementNS(SVG_NS, 'text');
    name.setAttribute('x', String(cx));
    name.setAttribute('y', String(cy - 6));
    name.setAttribute('text-anchor', 'middle');
    name.setAttribute('dominant-baseline', 'auto');
    name.setAttribute('class', 'ixmap-dag-label');
    name.textContent = mod.name.length > 18 ? `${mod.name.slice(0, 16)}\u2026` : mod.name;

    const sub = document.createElementNS(SVG_NS, 'text');
    sub.setAttribute('x', String(cx));
    sub.setAttribute('y', String(cy + 12));
    sub.setAttribute('text-anchor', 'middle');
    sub.setAttribute('dominant-baseline', 'auto');
    sub.setAttribute('class', 'ixmap-dag-sublabel');
    sub.textContent = `${count} interaction${count !== 1 ? 's' : ''}`;

    labelG.appendChild(name);
    labelG.appendChild(sub);
  }
}

// ─── Empty state ─────────────────────────────────────────────────

function renderEmpty(svgEl: SVGSVGElement, containerEl: HTMLElement) {
  const cw = containerEl.clientWidth || 400;
  const ch = containerEl.clientHeight || 300;
  svgEl.setAttribute('viewBox', `0 0 ${cw} ${ch}`);

  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', String(cw / 2));
  text.setAttribute('y', String(ch / 2));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.setAttribute('class', 'ixmap-dag-sublabel');
  text.textContent = 'No cross-module interactions';
  svgEl.appendChild(text);
}

// ─── Clear ───────────────────────────────────────────────────────

export function clearDag(svgEl: SVGSVGElement): void {
  while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
}

// ─── Highlight utilities ─────────────────────────────────────────

export function highlightDagLink(svgEl: SVGSVGElement, fromId: number, toId: number): void {
  for (const el of svgEl.querySelectorAll('.ixmap-dag-link')) {
    const f = Number(el.getAttribute('data-from-id'));
    const t = Number(el.getAttribute('data-to-id'));
    const match = (f === fromId && t === toId) || (f === toId && t === fromId);
    el.classList.toggle('highlighted', match);
    el.classList.toggle('dimmed', !match);
  }
}

export function clearDagHighlight(svgEl: SVGSVGElement): void {
  for (const el of svgEl.querySelectorAll('.ixmap-dag-link')) {
    el.classList.remove('highlighted', 'dimmed');
  }
}
