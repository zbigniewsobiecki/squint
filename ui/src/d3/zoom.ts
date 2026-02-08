import * as d3 from 'd3';

/**
 * Setup zoom behavior for SVG
 */
export function setupZoom(
  svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, unknown>,
  g: d3.Selection<SVGGElement, unknown, HTMLElement, unknown>,
  options: {
    scaleExtent?: [number, number];
    onZoom?: (transform: d3.ZoomTransform) => void;
  } = {}
) {
  const { scaleExtent = [0.1, 4], onZoom } = options;

  const zoom = d3
    .zoom<SVGSVGElement, unknown>()
    .scaleExtent(scaleExtent)
    .on('zoom', (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
      g.attr('transform', event.transform.toString());
      onZoom?.(event.transform);
    });

  svg.call(zoom);

  return zoom;
}

/**
 * Reset zoom to identity transform
 */
export function resetZoom(
  svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, unknown>,
  zoom: d3.ZoomBehavior<SVGSVGElement, unknown>
) {
  svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity);
}

/**
 * Fit content to viewport
 */
export function fitToViewport(
  svg: d3.Selection<SVGSVGElement, unknown, HTMLElement, unknown>,
  zoom: d3.ZoomBehavior<SVGSVGElement, unknown>,
  contentBounds: { x: number; y: number; width: number; height: number },
  padding = 40
) {
  const svgNode = svg.node();
  if (!svgNode) return;

  const { width: svgWidth, height: svgHeight } = svgNode.getBoundingClientRect();

  const scale = Math.min(
    (svgWidth - padding * 2) / contentBounds.width,
    (svgHeight - padding * 2) / contentBounds.height,
    1
  );

  const translateX = svgWidth / 2 - (contentBounds.x + contentBounds.width / 2) * scale;
  const translateY = svgHeight / 2 - (contentBounds.y + contentBounds.height / 2) * scale;

  const transform = d3.zoomIdentity.translate(translateX, translateY).scale(scale);

  svg.transition().duration(500).call(zoom.transform, transform);
}
