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
 * Calculate node radius based on lines of code
 */
export function getNodeRadius(lines: number, minR = 5, maxR = 25, maxLines = 300): number {
  const normalized = Math.sqrt(Math.min(lines, maxLines)) / Math.sqrt(maxLines);
  return minR + normalized * (maxR - minR);
}
