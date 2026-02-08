import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withDatabase, SymbolResolver, SharedFlags, outputJsonOrPlain } from '../_shared/index.js';

interface TraceNode {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
  depth: number;
  moduleId: number | null;
  moduleName: string | null;
  layer: string | null;
  children: TraceNode[];
}

export default class FlowsTrace extends Command {
  static override description = 'Trace execution path from entry point';

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
      const defDetails = db.getDefinitionById(definition.id);
      if (!defDetails) {
        this.error(chalk.red(`Definition with ID ${definition.id} not found`));
      }

      // Trace the flow from this entry point
      const trace = db.traceFlowFromEntry(definition.id, flags.depth);

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

  private buildTree(
    db: ReturnType<typeof import('../../db/database.js').IndexDatabase.prototype.getDefinitionById> extends infer T ? { getDefinitionById: (id: number) => T; getDefinitionModule: (id: number) => { module: { id: number; name: string; layer: string | null }; cohesion: number | null } | null; getCallGraph: () => Array<{ fromId: number; toId: number; weight: number }> } : never,
    rootId: number,
    trace: Array<{ definitionId: number; depth: number; moduleId: number | null; layer: string | null }>
  ): TraceNode {
    // Build adjacency list from call graph
    const edges = db.getCallGraph();
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

      const def = db.getDefinitionById(id);
      if (!def) return null;

      const moduleInfo = db.getDefinitionModule(id);
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
        layer: moduleInfo?.module.layer ?? null,
        children,
      };
    };

    return buildNode(rootId, 0) ?? {
      id: rootId,
      name: 'unknown',
      kind: 'unknown',
      filePath: '',
      line: 0,
      depth: 0,
      moduleId: null,
      moduleName: null,
      layer: null,
      children: [],
    };
  }

  private flattenTree(node: TraceNode): Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    line: number;
    depth: number;
    moduleName: string | null;
    layer: string | null;
  }> {
    const result: Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      depth: number;
      moduleName: string | null;
      layer: string | null;
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
        layer: n.layer,
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
    const layerLabel = node.layer ? chalk.yellow(` [${node.layer}]`) : '';

    if (node.depth === 0) {
      this.log(`${depthLabel}${chalk.cyan(node.name)}${moduleLabel}${layerLabel}`);
    } else {
      this.log(`${prefix}${connector}${depthLabel}${chalk.cyan(node.name)}${moduleLabel}${layerLabel}`);
    }

    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < node.children.length; i++) {
      const isChildLast = i === node.children.length - 1;
      this.printTree(node.children[i], childPrefix, isChildLast);
    }
  }
}
