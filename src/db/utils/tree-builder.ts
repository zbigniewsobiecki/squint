/**
 * Generic tree building utilities used by ModuleRepository and FlowRepository.
 */

/**
 * Node with parent reference and children array
 */
export interface TreeNode {
  id: number;
  parentId: number | null;
}

/**
 * Build a tree structure from a flat list of nodes with parent references.
 * @returns The root node(s) with children attached
 */
export function buildTree<T extends TreeNode, R extends T & { children: R[] }>(
  nodes: T[],
  createNode: (node: T) => R
): R[] {
  const nodeMap = new Map<number, R>();

  // Create all nodes
  for (const node of nodes) {
    nodeMap.set(node.id, createNode(node));
  }

  // Build tree structure
  const roots: R[] = [];
  for (const node of nodes) {
    const treeNode = nodeMap.get(node.id)!;
    if (node.parentId === null) {
      roots.push(treeNode);
    } else {
      const parent = nodeMap.get(node.parentId);
      if (parent) {
        parent.children.push(treeNode);
      }
    }
  }

  return roots;
}

/**
 * Build a single-root tree structure from a flat list of nodes.
 * @returns The root node or null if no nodes
 */
export function buildSingleRootTree<T extends TreeNode, R extends T & { children: R[] }>(
  nodes: T[],
  createNode: (node: T) => R
): R | null {
  const roots = buildTree(nodes, createNode);
  return roots.length > 0 ? roots[0] : null;
}
