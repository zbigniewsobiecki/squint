import type * as d3 from 'd3';
import type { HierarchyNode } from '../types/api';

/**
 * Color scheme for different symbol kinds
 */
export const KIND_COLORS: Record<string, string> = {
  function: '#3d5a80',
  class: '#5a3d80',
  interface: '#3d8050',
  type: '#806a3d',
  variable: '#803d3d',
  const: '#803d3d',
  enum: '#3d6880',
  method: '#4a6670',
};

/**
 * Hierarchy level colors (for directories/files)
 */
export const HIERARCHY_COLORS = {
  directory: '#2d4a5a',
  file: '#3d4a5a',
};

/**
 * Layer colors for module visualization
 */
export const LAYER_COLORS: Record<string, { fill: string; stroke: string }> = {
  controller: { fill: '#3d5a80', stroke: '#5a7a9a' },
  service: { fill: '#5a3d80', stroke: '#7a5a9a' },
  repository: { fill: '#3d8050', stroke: '#5a9a6a' },
  adapter: { fill: '#806a3d', stroke: '#9a8a5a' },
  utility: { fill: '#4a6670', stroke: '#6a8690' },
  default: { fill: '#4a4a4a', stroke: '#6a6a6a' },
};

/**
 * Flow colors palette
 */
export const FLOW_COLORS = [
  '#4fc1ff',
  '#ce9178',
  '#6a9955',
  '#c586c0',
  '#dcdcaa',
  '#9cdcfe',
  '#d7ba7d',
  '#b5cea8',
];

/**
 * Get flow color by index
 */
export function getFlowColor(index: number): string {
  return FLOW_COLORS[index % FLOW_COLORS.length];
}

/**
 * Get color for a symbol node
 */
export function getKindColor(kind: string): string {
  return KIND_COLORS[kind] || '#666';
}

/**
 * Get color for hierarchy node (D3 hierarchy datum)
 */
export function getHierarchyColor(d: d3.HierarchyNode<HierarchyNode>): string {
  if (d.data.data) {
    // Symbol node - use kind color
    return KIND_COLORS[d.data.data.kind] || '#666';
  } else if (d.data.isFile) {
    return HIERARCHY_COLORS.file;
  } else if (d.data.isDirectory) {
    return HIERARCHY_COLORS.directory;
  }
  return '#2d2d2d';
}

/**
 * Get stroke color based on annotation status
 */
export function getStrokeColor(d: d3.HierarchyNode<HierarchyNode>): string {
  if (d.data.data?.hasAnnotations) {
    return '#6a9955';
  }
  return '#3c3c3c';
}

/**
 * Get layer color for a module path
 */
export function getLayerFromPath(path: string): keyof typeof LAYER_COLORS {
  const lowerPath = path.toLowerCase();

  if (lowerPath.includes('controller') || lowerPath.includes('handler') || lowerPath.includes('route')) {
    return 'controller';
  }
  if (lowerPath.includes('service') || lowerPath.includes('usecase')) {
    return 'service';
  }
  if (lowerPath.includes('repository') || lowerPath.includes('repo') || lowerPath.includes('dao')) {
    return 'repository';
  }
  if (lowerPath.includes('adapter') || lowerPath.includes('gateway') || lowerPath.includes('client')) {
    return 'adapter';
  }
  if (lowerPath.includes('util') || lowerPath.includes('helper') || lowerPath.includes('lib')) {
    return 'utility';
  }

  return 'default';
}

/**
 * Calculate node radius based on lines of code
 */
export function getNodeRadius(lines: number, minR = 5, maxR = 25, maxLines = 300): number {
  const normalized = Math.sqrt(Math.min(lines, maxLines)) / Math.sqrt(maxLines);
  return minR + normalized * (maxR - minR);
}
