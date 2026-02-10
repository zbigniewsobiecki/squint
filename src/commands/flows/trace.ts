import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../db/database.js';
import { SharedFlags, SymbolResolver, outputJsonOrPlain, withDatabase } from '../_shared/index.js';

interface TraceNode {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  depth: number;
  moduleId: number | null;
  moduleName: string | null;
  children: TraceNode[];
}

export default class FlowsTrace extends Command {
  static override description = 'Trace call graph from a symbol';

  static override examples = [
    '<%= config.bin %> flows trace --name handleRegister',
    '<%= config.bin %> flows trace --id 42',
    '<%= config.bin %> flows trace --name processPayment --depth 5',
    '<%= config.bin %> flows trace --name login --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    name: Flags.string({
      char: 'n',
      description: 'Symbol name to trace from',
    }),
    id: Flags.integer({
      description: 'Definition ID to trace from',
    }),
    depth: Flags.integer({
      description: 'Max depth to trace',
      default: 10,
    }),
    file: Flags.string({
      char: 'f',
      description: 'Disambiguate by file path',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(FlowsTrace);

    if (!flags.name && flags.id === undefined) {
      this.error('Either provide --name or --id');
    }

    await withDatabase(flags.database, this, async (db) => {
      const resolver = new SymbolResolver(db, this);
      const definition = resolver.resolve(flags.name, flags.id, flags.file);

      if (!definition) {
        return; // Disambiguation message already shown
      }

      // Get full definition details
      const defDetails = db.definitions.getById(definition.id);
      if (!defDetails) {
        this.error(chalk.red(`Definition with ID ${definition.id} not found`));
      }

      // Trace the call graph from this entry point
      const trace = this.traceFromEntry(db, definition.id, flags.depth);

      // Build a tree structure for display
      const tree = this.buildTree(db, definition.id, trace);

      const jsonData = {
        entryPoint: {
          id: defDetails.id,
          name: defDetails.name,
          kind: defDetails.kind,
          filePath: defDetails.filePath,
          line: defDetails.line,
        },
        maxDepth: flags.depth,
        nodeCount: trace.length,
        trace: this.flattenTree(tree),
      };

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        this.log(`Trace from: ${chalk.cyan(defDetails.name)} (${defDetails.filePath}:${defDetails.line})`);
        this.log('');

        if (trace.length <= 1) {
          this.log(chalk.gray('No outgoing calls found from this symbol.'));
          return;
        }

        this.printTree(tree, '', true);

        this.log('');
        this.log(chalk.gray(`${trace.length} nodes traced (max depth: ${flags.depth})`));
      });
    });
  }

  /**
   * Trace reachable symbols from an entry point using call graph (BFS).
   */
  private traceFromEntry(
    db: IndexDatabase,
    entryId: number,
    maxDepth: number
  ): Array<{ definitionId: number; depth: number; moduleId: number | null }> {
    // Build call graph adjacency list
    const edges = db.modules.getCallGraph();
    const adjacency = new Map<number, number[]>();
    for (const edge of edges) {
      if (!adjacency.has(edge.fromId)) {
        adjacency.set(edge.fromId, []);
      }
      adjacency.get(edge.fromId)!.push(edge.toId);
    }

    // BFS traversal
    const visited = new Map<number, number>(); // defId -> depth
    const queue: Array<{ id: number; depth: number }> = [{ id: entryId, depth: 0 }];

    while (queue.length > 0) {
      const { id, depth } = queue.shift()!;

      if (visited.has(id)) continue;
      if (depth > maxDepth) continue;

      visited.set(id, depth);

      const neighbors = adjacency.get(id) ?? [];
      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          queue.push({ id: neighborId, depth: depth + 1 });
        }
      }
    }

    // Get module info for each visited definition
    const result: Array<{ definitionId: number; depth: number; moduleId: number | null }> = [];

    for (const [definitionId, depth] of visited) {
      const moduleInfo = db.modules.getDefinitionModule(definitionId);
      result.push({
        definitionId,
        depth,
        moduleId: moduleInfo?.module.id ?? null,
      });
    }

    // Sort by depth
    result.sort((a, b) => a.depth - b.depth);

    return result;
  }

  private buildTree(
    db: IndexDatabase,
    rootId: number,
    trace: Array<{ definitionId: number; depth: number; moduleId: number | null }>
  ): TraceNode {
    // Build adjacency list from call graph
    const edges = db.modules.getCallGraph();
    const adjacency = new Map<number, number[]>();
    for (const edge of edges) {
      if (!adjacency.has(edge.fromId)) {
        adjacency.set(edge.fromId, []);
      }
      adjacency.get(edge.fromId)!.push(edge.toId);
    }

    // Build depth map for quick lookup
    const depthMap = new Map<number, number>();
    for (const t of trace) {
      depthMap.set(t.definitionId, t.depth);
    }

    // Build tree recursively
    const visited = new Set<number>();

    const buildNode = (id: number, depth: number): TraceNode | null => {
      if (visited.has(id)) return null;
      visited.add(id);

      const def = db.definitions.getById(id);
      if (!def) return null;

      const moduleInfo = db.modules.getDefinitionModule(id);
      const children: TraceNode[] = [];

      const neighbors = adjacency.get(id) ?? [];
      for (const neighborId of neighbors) {
        if (depthMap.has(neighborId) && !visited.has(neighborId)) {
          const childNode = buildNode(neighborId, depth + 1);
          if (childNode) {
            children.push(childNode);
          }
        }
      }

      // Sort children by name for consistent output
      children.sort((a, b) => a.name.localeCompare(b.name));

      return {
        id,
        name: def.name,
        kind: def.kind,
        filePath: def.filePath,
        line: def.line,
        depth,
        moduleId: moduleInfo?.module.id ?? null,
        moduleName: moduleInfo?.module.name ?? null,
        children,
      };
    };

    return (
      buildNode(rootId, 0) ?? {
        id: rootId,
        name: 'unknown',
        kind: 'unknown',
        filePath: '',
        line: 0,
        depth: 0,
        moduleId: null,
        moduleName: null,
        children: [],
      }
    );
  }

  private flattenTree(node: TraceNode): Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    depth: number;
    moduleName: string | null;
  }> {
    const result: Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      depth: number;
      moduleName: string | null;
    }> = [];

    const visit = (n: TraceNode) => {
      result.push({
        id: n.id,
        name: n.name,
        kind: n.kind,
        filePath: n.filePath,
        line: n.line,
        depth: n.depth,
        moduleName: n.moduleName,
      });
      for (const child of n.children) {
        visit(child);
      }
    };

    visit(node);
    return result;
  }

  private printTree(node: TraceNode, prefix: string, isLast: boolean): void {
    const connector = isLast ? '└── ' : '├── ';
    const depthLabel = node.depth === 0 ? '' : `${chalk.gray(`[${node.depth}]`)} `;
    const moduleLabel = node.moduleName ? chalk.magenta(` (${node.moduleName})`) : '';

    if (node.depth === 0) {
      this.log(`${depthLabel}${chalk.cyan(node.name)}${moduleLabel}`);
    } else {
      this.log(`${prefix}${connector}${depthLabel}${chalk.cyan(node.name)}${moduleLabel}`);
    }

    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < node.children.length; i++) {
      const isChildLast = i === node.children.length - 1;
      this.printTree(node.children[i], childPrefix, isChildLast);
    }
  }
}
