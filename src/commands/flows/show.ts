import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { openDatabase, SharedFlags } from '../_shared/index.js';
import type { Flow } from '../../db/schema.js';
import type { IndexDatabase } from '../../db/database.js';

export default class FlowsShow extends Command {
  static override description = 'Show flow details with children or expanded leaf flows';

  static override examples = [
    '<%= config.bin %> flows show user-registration',
    '<%= config.bin %> flows show authentication --expand',
    '<%= config.bin %> flows show login --json',
    '<%= config.bin %> flows show checkout -d ./my-index.db',
  ];

  static override args = {
    identifier: Args.string({ description: 'Flow name, slug, or path to show', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    expand: Flags.boolean({
      description: 'Expand to show all leaf flows in order',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FlowsShow);

    const db = await openDatabase(flags.database, this);
    const isJson = flags.json;

    try {
      const flow = this.findFlow(db, args.identifier);

      if (!flow) {
        // Try partial match
        const allFlows = db.getAllFlows();
        const matches = allFlows.filter(f =>
          f.name.toLowerCase().includes(args.identifier.toLowerCase()) ||
          f.slug.toLowerCase().includes(args.identifier.toLowerCase()) ||
          f.fullPath.toLowerCase().includes(args.identifier.toLowerCase())
        );

        if (matches.length === 1) {
          this.displayFlow(db, matches[0], isJson, flags.expand);
          return;
        } else if (matches.length > 1) {
          if (isJson) {
            this.log(JSON.stringify({
              error: 'Multiple matches',
              matches: matches.map(f => ({ name: f.name, fullPath: f.fullPath })),
            }));
          } else {
            this.log(chalk.yellow(`Multiple flows match "${args.identifier}":`));
            for (const f of matches) {
              const isLeaf = f.fromModuleId !== null;
              const typeLabel = isLeaf ? chalk.cyan('[leaf]') : '';
              this.log(`  ${chalk.cyan(f.name)} ${chalk.gray(f.fullPath)} ${typeLabel}`);
            }
            this.log('');
            this.log(chalk.gray('Please specify the exact name or path.'));
          }
          return;
        }

        if (isJson) {
          this.log(JSON.stringify({ error: `Flow "${args.identifier}" not found.` }));
        } else {
          this.log(chalk.red(`Flow "${args.identifier}" not found.`));
        }
        return;
      }

      this.displayFlow(db, flow, isJson, flags.expand);
    } finally {
      db.close();
    }
  }

  private findFlow(db: IndexDatabase, identifier: string): Flow | null {
    // Try exact path match
    let flow = db.getFlowByPath(identifier);
    if (flow) return flow;

    // Try by ID
    const id = parseInt(identifier, 10);
    if (!isNaN(id)) {
      flow = db.getFlowById(id);
      if (flow) return flow;
    }

    // Try by name or slug
    const allFlows = db.getAllFlows();
    flow = allFlows.find(f => f.name === identifier || f.slug === identifier) ?? null;

    return flow;
  }

  private displayFlow(db: IndexDatabase, flow: Flow, isJson: boolean, expand: boolean): void {
    const children = db.getFlowChildren(flow.id);
    const isLeaf = flow.fromModuleId !== null && flow.toModuleId !== null;

    // Get module names for enrichment
    const modules = db.getAllModules();
    const moduleMap = new Map(modules.map(m => [m.id, m.fullPath]));

    const fromModuleName = flow.fromModuleId ? moduleMap.get(flow.fromModuleId) : null;
    const toModuleName = flow.toModuleId ? moduleMap.get(flow.toModuleId) : null;

    if (isJson) {
      const expandedLeafFlows = expand ? db.expandFlow(flow.id).map(f => ({
        ...f,
        fromModuleName: f.fromModuleId ? moduleMap.get(f.fromModuleId) : null,
        toModuleName: f.toModuleId ? moduleMap.get(f.toModuleId) : null,
      })) : [];

      const jsonData = {
        flow: {
          ...flow,
          fromModuleName,
          toModuleName,
        },
        children: children.map(c => ({
          ...c,
          fromModuleName: c.fromModuleId ? moduleMap.get(c.fromModuleId) : null,
          toModuleName: c.toModuleId ? moduleMap.get(c.toModuleId) : null,
        })),
        isLeaf,
        ...(expand && { expandedLeafFlows }),
      };

      this.log(JSON.stringify(jsonData, null, 2));
      return;
    }

    // Flow header
    this.log(chalk.bold(`Flow: ${flow.name}`));
    this.log(`Path: ${chalk.gray(flow.fullPath)}`);
    this.log(`Depth: ${flow.depth}${isLeaf ? chalk.cyan(' [leaf]') : ''}`);

    if (flow.description) {
      this.log(`Description: ${flow.description}`);
    }
    if (flow.domain) {
      this.log(`Domain: ${chalk.yellow(flow.domain)}`);
    }

    // Module transition for leaf flows
    if (isLeaf && fromModuleName && toModuleName) {
      this.log('');
      this.log(chalk.bold('Module Transition:'));
      this.log(`  ${chalk.cyan(fromModuleName)} → ${chalk.cyan(toModuleName)}`);
      if (flow.semantic) {
        this.log(`  ${chalk.gray(`"${flow.semantic}"`)}`);
      }
    }

    // Children
    if (children.length > 0) {
      this.log('');
      this.log(chalk.bold(`Children (${children.length}):`));

      for (const child of children) {
        const childIsLeaf = child.fromModuleId !== null;
        const typeLabel = childIsLeaf ? chalk.cyan('[leaf]') : '';

        this.log(`  ${child.stepOrder}. ${child.name} ${typeLabel}`);
        if (childIsLeaf) {
          const childFromName = child.fromModuleId ? moduleMap.get(child.fromModuleId) : '?';
          const childToName = child.toModuleId ? moduleMap.get(child.toModuleId) : '?';
          this.log(`     ${chalk.gray(`${childFromName} → ${childToName}`)}`);
        }
        if (child.description) {
          this.log(`     ${chalk.gray(child.description)}`);
        }
      }
    }

    // Expanded leaf flows
    if (expand && !isLeaf) {
      const leafFlows = db.expandFlow(flow.id);

      this.log('');
      this.log(chalk.bold(`Expanded Leaf Flows (${leafFlows.length}):`));

      for (let i = 0; i < leafFlows.length; i++) {
        const leaf = leafFlows[i];
        const leafFromName = leaf.fromModuleId ? moduleMap.get(leaf.fromModuleId) : '?';
        const leafToName = leaf.toModuleId ? moduleMap.get(leaf.toModuleId) : '?';

        this.log(`  ${i + 1}. ${chalk.cyan(leaf.name)}`);
        this.log(`     ${leafFromName} → ${leafToName}`);
        if (leaf.semantic) {
          this.log(`     ${chalk.gray(`"${leaf.semantic}"`)}`);
        }
      }
    }
  }
}
