import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { openDatabase, SharedFlags } from '../_shared/index.js';
import type { FlowTreeNode, Flow } from '../../db/schema.js';
import type { IndexDatabase } from '../../db/database.js';

export default class Flows extends Command {
  static override description = 'List all detected execution flows';

  static override examples = [
    '<%= config.bin %> flows',
    '<%= config.bin %> flows --tree',
    '<%= config.bin %> flows --leaf',
    '<%= config.bin %> flows -d car-dealership.db --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    tree: Flags.boolean({
      description: 'Show flow hierarchy as a tree',
      default: false,
    }),
    leaf: Flags.boolean({
      description: 'Show only leaf flows (module transitions)',
      default: false,
    }),
    domain: Flags.string({
      description: 'Filter by domain',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Flows);

    const db = await openDatabase(flags.database, this);
    const isJson = flags.json;

    try {
      if (flags.tree) {
        this.showTree(db, isJson);
      } else if (flags.leaf) {
        this.showLeafFlows(db, isJson, flags.domain);
      } else {
        this.showAllFlows(db, isJson, flags.domain);
      }
    } finally {
      db.close();
    }
  }

  private showTree(db: IndexDatabase, isJson: boolean): void {
    const trees = db.getFlowTree();

    if (trees.length === 0) {
      if (isJson) {
        this.log(JSON.stringify({ flows: [], stats: { flowCount: 0, leafFlowCount: 0, maxDepth: 0 } }));
      } else {
        this.log(chalk.gray('No flows detected yet.'));
        this.log(chalk.gray('Run `ats llm flows` to detect flows from module call graph.'));
      }
      return;
    }

    if (isJson) {
      const stats = db.getFlowStats();
      const coverage = db.getFlowCoverage();
      this.log(JSON.stringify({
        trees,
        stats,
        coverage,
      }, null, 2));
      return;
    }

    // Print tree structure
    this.log(chalk.bold('Flow Hierarchy'));
    this.log('');
    for (let i = 0; i < trees.length; i++) {
      this.printTreeNode(trees[i], '', i === trees.length - 1);
    }

    // Print stats
    const stats = db.getFlowStats();
    const coverage = db.getFlowCoverage();
    this.log('');
    this.log(chalk.bold('Statistics'));
    this.log(`Total flows: ${stats.flowCount}`);
    this.log(`Leaf flows: ${stats.leafFlowCount}`);
    this.log(`Max depth: ${stats.maxDepth}`);
    this.log(`Module edge coverage: ${coverage.coveredByFlows}/${coverage.totalModuleEdges} (${coverage.percentage.toFixed(1)}%)`);
  }

  private printTreeNode(node: FlowTreeNode, prefix: string, isLast: boolean): void {
    const connector = isLast ? '└── ' : '├── ';
    const nameColor = node.fromModuleId ? chalk.cyan : chalk.white;
    const flowType = node.fromModuleId ? chalk.gray('[leaf]') : '';

    // Main node line
    let line = `${prefix}${connector}${nameColor(node.name)}`;
    if (flowType) {
      line += ` ${flowType}`;
    }

    this.log(line);

    // Module transition info for leaf flows
    if (node.fromModuleName && node.toModuleName) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      this.log(`${childPrefix}${chalk.gray(`${node.fromModuleName} → ${node.toModuleName}`)}`);
      if (node.semantic) {
        this.log(`${childPrefix}${chalk.gray(`"${node.semantic}"`)}`);
      }
    } else if (node.description) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      this.log(`${childPrefix}${chalk.gray(node.description)}`);
    }

    // Print children
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    for (let i = 0; i < node.children.length; i++) {
      this.printTreeNode(node.children[i], childPrefix, i === node.children.length - 1);
    }
  }

  private showLeafFlows(db: IndexDatabase, isJson: boolean, domain?: string): void {
    let flows = db.getLeafFlows();

    if (domain) {
      flows = flows.filter(f => f.domain === domain);
    }

    if (flows.length === 0) {
      if (isJson) {
        this.log(JSON.stringify({ flows: [] }));
      } else {
        this.log(chalk.gray('No leaf flows found.'));
      }
      return;
    }

    if (isJson) {
      this.log(JSON.stringify({ flows }, null, 2));
      return;
    }

    // Table format
    this.log(chalk.bold(`Leaf Flows (${flows.length})`));
    this.log('');

    // Get module paths for enrichment
    const modules = db.getAllModules();
    const moduleMap = new Map(modules.map(m => [m.id, m.fullPath]));

    for (const flow of flows) {
      const fromPath = flow.fromModuleId ? moduleMap.get(flow.fromModuleId) : '?';
      const toPath = flow.toModuleId ? moduleMap.get(flow.toModuleId) : '?';

      this.log(`${chalk.bold(flow.name)} ${chalk.gray(`(${flow.slug})`)}`);
      this.log(`  ${chalk.cyan(fromPath ?? '?')} → ${chalk.cyan(toPath ?? '?')}`);
      if (flow.semantic) {
        this.log(`  ${chalk.gray(`"${flow.semantic}"`)}`);
      }
      if (flow.domain) {
        this.log(`  ${chalk.yellow(`domain: ${flow.domain}`)}`);
      }
      this.log('');
    }
  }

  private showAllFlows(db: IndexDatabase, isJson: boolean, domain?: string): void {
    let flows = db.getAllFlows();

    if (domain) {
      flows = flows.filter(f => f.domain === domain);
    }

    if (flows.length === 0) {
      if (isJson) {
        this.log(JSON.stringify({ flows: [], stats: { flowCount: 0, leafFlowCount: 0, maxDepth: 0 } }));
      } else {
        this.log(chalk.gray('No flows detected yet.'));
        this.log(chalk.gray('Run `ats llm flows` to detect flows from module call graph.'));
      }
      return;
    }

    if (isJson) {
      const stats = db.getFlowStats();
      const coverage = db.getFlowCoverage();
      this.log(JSON.stringify({ flows, stats, coverage }, null, 2));
      return;
    }

    // Group by depth
    const byDepth = new Map<number, Flow[]>();
    for (const flow of flows) {
      if (!byDepth.has(flow.depth)) {
        byDepth.set(flow.depth, []);
      }
      byDepth.get(flow.depth)!.push(flow);
    }

    const depths = Array.from(byDepth.keys()).sort((a, b) => a - b);

    for (const depth of depths) {
      const depthFlows = byDepth.get(depth)!;
      const label = depth === 0 ? 'Root Flows' : depth === 1 ? 'Parent Flows' : `Depth ${depth}`;
      this.log(chalk.bold(`${label} (${depthFlows.length})`));

      for (const flow of depthFlows) {
        const isLeaf = flow.fromModuleId !== null;
        const typeLabel = isLeaf ? chalk.cyan('[leaf]') : '';

        this.log(`  ${flow.name} ${chalk.gray(`(${flow.fullPath})`)} ${typeLabel}`);
        if (flow.description) {
          this.log(`    ${chalk.gray(flow.description)}`);
        }
      }
      this.log('');
    }

    // Stats
    const stats = db.getFlowStats();
    const coverage = db.getFlowCoverage();
    this.log(chalk.bold('Statistics'));
    this.log(`Total flows: ${stats.flowCount}`);
    this.log(`Leaf flows: ${stats.leafFlowCount}`);
    this.log(`Max depth: ${stats.maxDepth}`);
    this.log(`Module edge coverage: ${coverage.coveredByFlows}/${coverage.totalModuleEdges} (${coverage.percentage.toFixed(1)}%)`);
  }
}
