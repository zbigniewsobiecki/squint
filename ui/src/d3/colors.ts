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
 * Flow colors palette
 */
export const FLOW_COLORS = ['#4fc1ff', '#ce9178', '#6a9955', '#c586c0', '#dcdcaa', '#9cdcfe', '#d7ba7d', '#b5cea8'];

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
  }
  if (d.data.isFile) {
    return HIERARCHY_COLORS.file;
  }
  if (d.data.isDirectory) {
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
 * Calculate node radius based on lines of code
 */
export function getNodeRadius(lines: number, minR = 5, maxR = 25, maxLines = 300): number {
  const normalized = Math.sqrt(Math.min(lines, maxLines)) / Math.sqrt(maxLines);
  return minR + normalized * (maxR - minR);
}
