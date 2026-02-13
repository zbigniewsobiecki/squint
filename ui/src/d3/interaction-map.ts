import type { Interaction } from '../types/api';

export interface AggregatedEdge {
  fromId: number;
  toId: number;
  weight: number;
  pattern: string; // 'business' | 'utility'
  interactions: Interaction[];
}

// Ray-box intersection: find exit point on rect boundary from center in direction (dx, dy)
function rayBoxIntersection(cx: number, cy: number, hw: number, hh: number, dx: number, dy: number): [number, number] {
  if (dx === 0 && dy === 0) return [cx, cy];

  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  let t: number;
  if (absDx * hh > absDy * hw) {
    t = hw / absDx;
  } else {
    t = hh / absDy;
  }

  return [cx + dx * t, cy + dy * t];
}

/**
 * Draw curved SVG arrows from the selected module's card to all connected cards.
 */
export function renderInteractionArrows(
  svgEl: SVGSVGElement,
  cardElements: Map<number, HTMLElement>,
  edges: AggregatedEdge[],
  selectedModuleId: number,
  containerEl: HTMLElement
): void {
  clearArrows(svgEl);

  // Size the SVG to cover the scrollable content area
  svgEl.setAttribute('width', String(containerEl.scrollWidth));
  svgEl.setAttribute('height', String(containerEl.scrollHeight));
  svgEl.setAttribute('viewBox', `0 0 ${containerEl.scrollWidth} ${containerEl.scrollHeight}`);

  // Arrowhead markers
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

  const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
  marker.setAttribute('id', 'ixmap-arrowhead');
  marker.setAttribute('viewBox', '0 -5 10 10');
  marker.setAttribute('refX', '10');
  marker.setAttribute('refY', '0');
  marker.setAttribute('markerWidth', '2');
  marker.setAttribute('markerHeight', '2');
  marker.setAttribute('orient', 'auto');
  const markerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  markerPath.setAttribute('d', 'M0,-4L10,0L0,4');
  markerPath.setAttribute('fill', 'var(--text-primary)');
  marker.appendChild(markerPath);
  defs.appendChild(marker);

  svgEl.appendChild(defs);

  const containerRect = containerEl.getBoundingClientRect();
  const scrollLeft = containerEl.scrollLeft;
  const scrollTop = containerEl.scrollTop;

  // Filter edges connected to the selected module
  const connectedEdges = edges.filter((e) => e.fromId === selectedModuleId || e.toId === selectedModuleId);

  for (let i = 0; i < connectedEdges.length; i++) {
    const edge = connectedEdges[i];
    const fromCard = cardElements.get(edge.fromId);
    const toCard = cardElements.get(edge.toId);
    if (!fromCard || !toCard) continue;

    const fromRect = fromCard.getBoundingClientRect();
    const toRect = toCard.getBoundingClientRect();

    // Convert to container-local coordinates (accounting for scroll)
    const fromCx = fromRect.left - containerRect.left + scrollLeft + fromRect.width / 2;
    const fromCy = fromRect.top - containerRect.top + scrollTop + fromRect.height / 2;
    const toCx = toRect.left - containerRect.left + scrollLeft + toRect.width / 2;
    const toCy = toRect.top - containerRect.top + scrollTop + toRect.height / 2;

    const dx = toCx - fromCx;
    const dy = toCy - fromCy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) continue;

    const fromHw = fromRect.width / 2;
    const fromHh = fromRect.height / 2;
    const toHw = toRect.width / 2;
    const toHh = toRect.height / 2;

    const [x1, y1] = rayBoxIntersection(fromCx, fromCy, fromHw, fromHh, dx, dy);
    const [x2, y2] = rayBoxIntersection(toCx, toCy, toHw, toHh, -dx, -dy);

    // Quadratic Bezier with perpendicular curvature offset
    const curvature = Math.min(dist * 0.15, 40);
    const sign = i % 2 === 0 ? 1 : -1;

    const ndx = dx / dist;
    const ndy = dy / dist;
    const px = -ndy * curvature * sign;
    const py = ndx * curvature * sign;

    const cpx = (x1 + x2) / 2 + px;
    const cpy = (y1 + y2) / 2 + py;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', `M${x1},${y1} Q${cpx},${cpy} ${x2},${y2}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'var(--text-muted)');
    path.setAttribute('stroke-width', String(Math.min(4, Math.max(1.5, edge.weight * 0.5))));
    path.setAttribute('stroke-opacity', '0.85');
    path.setAttribute('marker-end', 'url(#ixmap-arrowhead)');
    path.classList.add('ixmap-arrow');
    path.setAttribute('data-from-id', String(edge.fromId));
    path.setAttribute('data-to-id', String(edge.toId));

    if (edge.pattern === 'utility') {
      path.setAttribute('stroke-dasharray', '5,3');
    }

    svgEl.appendChild(path);

    // Add semantic label at the midpoint of the bezier curve
    const semantic = edge.interactions.find((ix) => ix.semantic)?.semantic;
    if (semantic) {
      // Quadratic bezier midpoint at t=0.5
      const mx = 0.25 * x1 + 0.5 * cpx + 0.25 * x2;
      const my = 0.25 * y1 + 0.5 * cpy + 0.25 * y2;

      const labelGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      labelGroup.classList.add('ixmap-arrow-label');
      labelGroup.setAttribute('data-from-id', String(edge.fromId));
      labelGroup.setAttribute('data-to-id', String(edge.toId));

      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', String(mx));
      text.setAttribute('y', String(my));
      text.textContent = semantic.length > 50 ? `${semantic.slice(0, 48)}\u2026` : semantic;

      // Measure text to create background rect
      // Append text first to measure, then prepend bg rect
      labelGroup.appendChild(text);
      svgEl.appendChild(labelGroup);

      const bbox = text.getBBox();
      const padX = 4;
      const padY = 2;
      const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      bg.setAttribute('x', String(bbox.x - padX));
      bg.setAttribute('y', String(bbox.y - padY));
      bg.setAttribute('width', String(bbox.width + padX * 2));
      bg.setAttribute('height', String(bbox.height + padY * 2));
      bg.setAttribute('rx', '3');
      labelGroup.insertBefore(bg, text);
    }
  }
}

/**
 * Remove all arrow paths and defs from the SVG overlay.
 */
export function clearArrows(svgEl: SVGSVGElement): void {
  while (svgEl.firstChild) {
    svgEl.removeChild(svgEl.firstChild);
  }
}
