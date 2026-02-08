import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, SymbolResolver, outputJsonOrPlain, withDatabase } from '../_shared/index.js';

type RelationshipType = 'extends' | 'implements' | 'calls' | 'imports' | 'uses';

interface HierarchyNode {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  children: HierarchyNode[];
}

export default class Hierarchy extends Command {
  static override description = 'Show class/interface inheritance tree';

  static override examples = [
    '<%= config.bin %> hierarchy',
    '<%= config.bin %> hierarchy --type extends',
    '<%= config.bin %> hierarchy --type implements',
    '<%= config.bin %> hierarchy --type calls --root main',
    '<%= config.bin %> hierarchy --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    type: Flags.string({
      description: 'Relationship type: extends, implements, calls, imports, uses',
      default: 'extends',
    }),
    root: Flags.string({
      description: 'Start from specific symbol (for call/import hierarchies)',
    }),
    file: Flags.string({
      char: 'f',
      description: 'Disambiguate root symbol by file path',
    }),
    depth: Flags.integer({
      description: 'Max depth for call/import hierarchies',
      default: 10,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Hierarchy);

    const validTypes: RelationshipType[] = ['extends', 'implements', 'calls', 'imports', 'uses'];
    if (!validTypes.includes(flags.type as RelationshipType)) {
      this.error(`Invalid type "${flags.type}". Valid types: ${validTypes.join(', ')}`);
    }

    const relType = flags.type as RelationshipType;

    await withDatabase(flags.database, this, async (db) => {
      if (relType === 'extends' || relType === 'implements') {
        // Class/interface hierarchy from parsed data
        return this.showInheritanceHierarchy(db, relType, flags.json);
      }
      if (relType === 'calls') {
        // Call hierarchy from a specific root
        if (!flags.root) {
          this.error('--root is required for call hierarchy. Specify a function name to trace from.');
        }
        return this.showCallHierarchy(db, flags.root, flags.file, flags.depth, flags.json);
      }
      // Uses/imports hierarchy from relationship annotations
      return this.showAnnotatedHierarchy(db, relType, flags.root, flags.json);
    });
  }

  private showInheritanceHierarchy(
    db: Parameters<Parameters<typeof import('../_shared/db-helper.js').withDatabase>[2]>[0],
    type: 'extends' | 'implements',
    json: boolean
  ): void {
    const hierarchy = db.getClassHierarchy();

    // Filter links by type
    const filteredLinks = hierarchy.links.filter((l) => l.type === type);

    // Build parent -> children map
    const childrenMap = new Map<number, number[]>();
    const hasParent = new Set<number>();

    for (const link of filteredLinks) {
      // For extends/implements: source extends/implements target
      // We want to show target -> source (parent -> child) in the tree
      const parent = link.target;
      const child = link.source;

      hasParent.add(child);
      if (!childrenMap.has(parent)) {
        childrenMap.set(parent, []);
      }
      childrenMap.get(parent)!.push(child);
    }

    // Find roots (nodes that have children but no parent in this relationship type)
    const nodeMap = new Map(hierarchy.nodes.map((n) => [n.id, n]));
    const roots: number[] = [];

    for (const [parentId] of childrenMap) {
      if (!hasParent.has(parentId)) {
        roots.push(parentId);
      }
    }

    // Build tree structures
    const trees: HierarchyNode[] = [];
    const visited = new Set<number>();

    const buildTree = (id: number): HierarchyNode | null => {
      if (visited.has(id)) return null;
      visited.add(id);

      const node = nodeMap.get(id);
      if (!node) return null;

      const childIds = childrenMap.get(id) ?? [];
      const children: HierarchyNode[] = [];

      for (const childId of childIds) {
        const childNode = buildTree(childId);
        if (childNode) {
          children.push(childNode);
        }
      }

      children.sort((a, b) => a.name.localeCompare(b.name));

      // Get file path from definition
      const def = db.getDefinitionById(id);

      return {
        id,
        name: node.name,
        kind: node.kind,
        filePath: def?.filePath ?? '',
        line: def?.line ?? 0,
        children,
      };
    };

    for (const rootId of roots.sort((a, b) => {
      const nodeA = nodeMap.get(a);
      const nodeB = nodeMap.get(b);
      return (nodeA?.name ?? '').localeCompare(nodeB?.name ?? '');
    })) {
      const tree = buildTree(rootId);
      if (tree) {
        trees.push(tree);
      }
    }

    // Count total nodes
    const countNodes = (node: HierarchyNode): number => {
      return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
    };
    const totalNodes = trees.reduce((sum, t) => sum + countNodes(t), 0);

    const jsonData = {
      type,
      roots: trees.length,
      totalNodes,
      trees: trees.map((t) => this.flattenTree(t)),
    };

    outputJsonOrPlain(this, json, jsonData, () => {
      const typeLabel = type === 'extends' ? 'Class Hierarchy (extends)' : 'Interface Implementations (implements)';
      this.log(chalk.bold(typeLabel));
      this.log('');

      if (trees.length === 0) {
        this.log(chalk.gray(`No ${type} relationships found.`));
        return;
      }

      for (const tree of trees) {
        this.printTree(tree, '', true);
        this.log('');
      }

      this.log(chalk.gray(`(${trees.length} roots, ${totalNodes} total nodes)`));
    });
  }

  private showCallHierarchy(
    db: Parameters<Parameters<typeof import('../_shared/db-helper.js').withDatabase>[2]>[0],
    rootName: string,
    rootFile: string | undefined,
    maxDepth: number,
    json: boolean
  ): void {
    const resolver = new SymbolResolver(db, this);
    const resolved = resolver.resolve(rootName, undefined, rootFile);

    if (!resolved) {
      return; // Disambiguation message already shown
    }

    // Get full definition details
    const rootDef = db.getDefinitionById(resolved.id);
    if (!rootDef) {
      this.error(`Definition with ID ${resolved.id} not found`);
    }

    // Build call graph adjacency list
    const edges = db.getCallGraph();
    const adjacency = new Map<number, number[]>();
    for (const edge of edges) {
      if (!adjacency.has(edge.fromId)) {
        adjacency.set(edge.fromId, []);
      }
      adjacency.get(edge.fromId)!.push(edge.toId);
    }

    // Trace the call graph from this point using BFS
    const depthMap = new Map<number, number>();
    const queue: Array<{ id: number; depth: number }> = [{ id: resolved.id, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;
      if (depthMap.has(id)) continue;
      if (depth > maxDepth) continue;
      depthMap.set(id, depth);

      const neighbors = adjacency.get(id) ?? [];
      for (const neighborId of neighbors) {
        if (!depthMap.has(neighborId)) {
          queue.push({ id: neighborId, depth: depth + 1 });
        }
      }
    }

    // Build tree
    const visited = new Set<number>();

    const buildTree = (id: number, depth: number): HierarchyNode | null => {
      if (visited.has(id)) return null;
      visited.add(id);

      const def = db.getDefinitionById(id);
      if (!def) return null;

      const children: HierarchyNode[] = [];
      const neighbors = adjacency.get(id) ?? [];

      for (const neighborId of neighbors) {
        if (depthMap.has(neighborId) && !visited.has(neighborId)) {
          const childNode = buildTree(neighborId, depth + 1);
          if (childNode) {
            children.push(childNode);
          }
        }
      }

      children.sort((a, b) => a.name.localeCompare(b.name));

      return {
        id,
        name: def.name,
        kind: def.kind,
        filePath: def.filePath,
        line: def.line,
        children,
      };
    };

    const tree = buildTree(resolved.id, 0);

    const countNodes = (node: HierarchyNode | null): number => {
      if (!node) return 0;
      return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
    };

    const jsonData = {
      type: 'calls',
      root: {
        id: rootDef.id,
        name: rootDef.name,
        kind: rootDef.kind,
        filePath: rootDef.filePath,
        line: rootDef.line,
      },
      maxDepth,
      totalNodes: countNodes(tree),
      tree: tree ? this.flattenTree(tree) : null,
    };

    outputJsonOrPlain(this, json, jsonData, () => {
      this.log(chalk.bold(`Call Hierarchy from: ${chalk.cyan(rootDef.name)}`));
      this.log('');

      if (!tree || tree.children.length === 0) {
        this.log(chalk.gray('No outgoing calls found.'));
        return;
      }

      this.printTree(tree, '', true);

      this.log('');
      this.log(chalk.gray(`(${countNodes(tree)} nodes, max depth: ${maxDepth})`));
    });
  }

  private showAnnotatedHierarchy(
    db: Parameters<Parameters<typeof import('../_shared/db-helper.js').withDatabase>[2]>[0],
    type: RelationshipType,
    _rootName: string | undefined,
    json: boolean
  ): void {
    const annotations = db.getAllRelationshipAnnotations({ limit: 1000 });

    // Filter by type if it maps to a relationship type
    const typeToRelType: Record<string, string> = {
      uses: 'uses',
      imports: 'uses', // treat imports as uses for now
    };
    const relType = typeToRelType[type] ?? type;
    const filtered = annotations.filter((a) => a.relationshipType === relType);

    // Build map of from -> to
    const childrenMap = new Map<number, number[]>();
    const allIds = new Set<number>();

    for (const ann of filtered) {
      allIds.add(ann.fromDefinitionId);
      allIds.add(ann.toDefinitionId);

      if (!childrenMap.has(ann.fromDefinitionId)) {
        childrenMap.set(ann.fromDefinitionId, []);
      }
      childrenMap.get(ann.fromDefinitionId)!.push(ann.toDefinitionId);
    }

    const jsonData = {
      type,
      annotationCount: filtered.length,
      annotations: filtered.slice(0, 100).map((a) => ({
        from: {
          id: a.fromDefinitionId,
          name: a.fromName,
          kind: a.fromKind,
        },
        to: {
          id: a.toDefinitionId,
          name: a.toName,
          kind: a.toKind,
        },
        semantic: a.semantic,
      })),
    };

    outputJsonOrPlain(this, json, jsonData, () => {
      this.log(chalk.bold(`${type.charAt(0).toUpperCase() + type.slice(1)} Relationships`));
      this.log('');

      if (filtered.length === 0) {
        this.log(chalk.gray(`No ${type} relationships annotated yet.`));
        return;
      }

      // Group by from symbol
      const byFrom = new Map<number, typeof filtered>();
      for (const ann of filtered) {
        if (!byFrom.has(ann.fromDefinitionId)) {
          byFrom.set(ann.fromDefinitionId, []);
        }
        byFrom.get(ann.fromDefinitionId)!.push(ann);
      }

      let shown = 0;
      const maxToShow = 20;

      for (const [, anns] of byFrom) {
        if (shown >= maxToShow) {
          this.log(chalk.gray(`... and ${byFrom.size - maxToShow} more symbols`));
          break;
        }

        const first = anns[0];
        this.log(`${chalk.cyan(first.fromName)} ${chalk.gray(`(${first.fromKind})`)}`);

        for (const ann of anns.slice(0, 5)) {
          const semanticStr =
            ann.semantic && ann.semantic !== 'PENDING_LLM_ANNOTATION' ? ` - ${chalk.gray(ann.semantic)}` : '';
          this.log(`  └── ${chalk.yellow(ann.toName)} ${chalk.gray(`(${ann.toKind})`)}${semanticStr}`);
        }

        if (anns.length > 5) {
          this.log(chalk.gray(`      ... and ${anns.length - 5} more`));
        }

        this.log('');
        shown++;
      }

      this.log(chalk.gray(`Total: ${filtered.length} ${type} relationships`));
    });
  }

  private flattenTree(node: HierarchyNode): HierarchyNode {
    return {
      id: node.id,
      name: node.name,
      kind: node.kind,
      filePath: node.filePath,
      line: node.line,
      children: node.children.map((c) => this.flattenTree(c)),
    };
  }

  private printTree(node: HierarchyNode, prefix: string, isLast: boolean, isRoot = true): void {
    const connector = isLast ? '└── ' : '├── ';
    const kindLabel = chalk.gray(` (${node.kind})`);

    if (isRoot) {
      this.log(`${chalk.cyan(node.name)}${kindLabel}`);
    } else {
      this.log(`${prefix}${connector}${chalk.cyan(node.name)}${kindLabel}`);
    }

    const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < node.children.length; i++) {
      const isChildLast = i === node.children.length - 1;
      this.printTree(node.children[i], childPrefix, isChildLast, false);
    }
  }
}
