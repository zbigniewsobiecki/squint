import type { HierarchyNode, RelationshipType, SymbolEdge, SymbolNode } from '../types/api';

/**
 * Classify relationship by semantic text
 */
export function classifyRelationship(semantic: string): RelationshipType {
  const s = (semantic || '').toLowerCase();
  if (s.includes('extend')) return 'extends';
  if (s.includes('implement')) return 'implements';
  if (s.includes('call')) return 'calls';
  if (s.includes('import')) return 'imports';
  if (s.includes('use')) return 'uses';
  return 'uses';
}

/**
 * Build hierarchy from file structure
 */
export function buildFileHierarchy(nodes: SymbolNode[]): HierarchyNode {
  const root: HierarchyNode = { name: 'root', children: [], isRoot: true };

  for (const node of nodes) {
    const parts = node.filePath.split('/').filter((p) => p);
    let current = root;

    // Navigate/create directory structure
    for (let i = 0; i < parts.length - 1; i++) {
      let child = current.children?.find((c) => c.name === parts[i] && !c.data);
      if (!child) {
        child = { name: parts[i], children: [], isDirectory: true, depth: i + 1 };
        current.children = current.children || [];
        current.children.push(child);
      }
      current = child;
    }

    // Add file level
    const fileName = parts[parts.length - 1];
    let fileNode = current.children?.find((c) => c.name === fileName && !c.data);
    if (!fileNode) {
      fileNode = { name: fileName, children: [], isFile: true, depth: parts.length };
      current.children = current.children || [];
      current.children.push(fileNode);
    }

    // Add symbol as leaf
    fileNode.children = fileNode.children || [];
    fileNode.children.push({
      name: node.name,
      value: Math.max(node.lines, 1),
      data: node,
    });
  }

  return root;
}

/**
 * Build hierarchy from relationship type (e.g., extends, calls)
 * If A extends B, then A is shown as a child of B
 */
export function buildRelationshipHierarchy(
  nodes: SymbolNode[],
  edges: SymbolEdge[],
  relationshipType: RelationshipType
): HierarchyNode {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // Filter edges to only include the selected relationship type
  const relevantEdges = edges.filter((e) => {
    const type = classifyRelationship(e.semantic);
    return type === relationshipType;
  });

  // Build parent-child map: source -> targets (source depends on/relates to targets)
  // In "A extends B", source=A, target=B, so A is child of B
  const childrenOf = new Map<number, number[]>();
  const hasParent = new Set<number>();

  for (const edge of relevantEdges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;

    if (!childrenOf.has(edge.target)) {
      childrenOf.set(edge.target, []);
    }
    childrenOf.get(edge.target)!.push(edge.source);
    hasParent.add(edge.source);
  }

  // Find root nodes (nodes that have children but no parent in this relationship)
  const involvedNodes = new Set<number>();
  for (const edge of relevantEdges) {
    if (nodeById.has(edge.source)) involvedNodes.add(edge.source);
    if (nodeById.has(edge.target)) involvedNodes.add(edge.target);
  }

  const rootIds = [...involvedNodes].filter((id) => !hasParent.has(id));

  // Build tree recursively
  const visited = new Set<number>();

  function buildNode(nodeId: number, depth = 0): HierarchyNode | null {
    if (visited.has(nodeId)) return null; // Prevent cycles
    visited.add(nodeId);

    const node = nodeById.get(nodeId);
    if (!node) return null;

    const children = (childrenOf.get(nodeId) || [])
      .map((childId) => buildNode(childId, depth + 1))
      .filter((c): c is HierarchyNode => c !== null);

    return {
      name: node.name,
      value: Math.max(node.lines, 1),
      data: node,
      children: children.length > 0 ? children : undefined,
    };
  }

  const rootChildren = rootIds.map((id) => buildNode(id)).filter((c): c is HierarchyNode => c !== null);

  // If no relationships of this type, show message
  if (rootChildren.length === 0) {
    return {
      name: 'root',
      children: [
        {
          name: `No "${relationshipType}" relationships found`,
          children: [],
        },
      ],
      isRoot: true,
    };
  }

  return {
    name: 'root',
    children: rootChildren,
    isRoot: true,
  };
}
