import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { openDatabase, SharedFlags } from '../_shared/index.js';
import type { Flow } from '../../db/schema.js';
import type { IndexDatabase } from '../../db/database.js';

export default class FlowsShow extends Command {
  static override description = 'Show flow details with interaction steps';

  static override examples = [
    '<%= config.bin %> flows show login-flow',
    '<%= config.bin %> flows show 5',
    '<%= config.bin %> flows show user-registration --json',
  ];

  static override args = {
    identifier: Args.string({ description: 'Flow name, slug, or ID', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
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
          f.slug.toLowerCase().includes(args.identifier.toLowerCase())
        );

        if (matches.length === 1) {
          this.displayFlow(db, matches[0], isJson);
          return;
        } else if (matches.length > 1) {
          if (isJson) {
            this.log(JSON.stringify({
              error: 'Multiple matches',
              matches: matches.map(f => ({ id: f.id, name: f.name, slug: f.slug })),
            }));
          } else {
            this.log(chalk.yellow(`Multiple flows match "${args.identifier}":`));
            for (const f of matches) {
              this.log(`  ${chalk.cyan(f.name)} ${chalk.gray(`(${f.slug})`)}`);
            }
            this.log('');
            this.log(chalk.gray('Please specify the exact slug or ID.'));
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

      this.displayFlow(db, flow, isJson);
    } finally {
      db.close();
    }
  }

  private findFlow(db: IndexDatabase, identifier: string): Flow | null {
    // Try by ID
    const id = parseInt(identifier, 10);
    if (!isNaN(id)) {
      const flow = db.getFlowById(id);
      if (flow) return flow;
    }

    // Try by slug
    const bySlug = db.getFlowBySlug(identifier);
    if (bySlug) return bySlug;

    // Try exact name match
    const allFlows = db.getAllFlows();
    const byName = allFlows.find(f => f.name === identifier);
    return byName ?? null;
  }

  private displayFlow(db: IndexDatabase, flow: Flow, isJson: boolean): void {
    // Get flow with steps
    const flowWithSteps = db.getFlowWithSteps(flow.id);

    if (isJson) {
      this.log(JSON.stringify(flowWithSteps, null, 2));
      return;
    }

    // Flow header
    this.log(chalk.bold(`Flow: ${flow.name}`));
    this.log(`Slug: ${chalk.gray(flow.slug)}`);
    if (flow.stakeholder) {
      this.log(`Stakeholder: ${this.getStakeholderDisplay(flow.stakeholder)}`);
    }
    if (flow.entryPath) {
      this.log(`Entry: ${flow.entryPath}`);
    }
    if (flow.description) {
      this.log(`Description: ${flow.description}`);
    }

    // Steps
    if (flowWithSteps && flowWithSteps.steps.length > 0) {
      this.log('');
      this.log(chalk.bold(`Steps (${flowWithSteps.steps.length})`));

      for (const step of flowWithSteps.steps) {
        const i = step.interaction;
        const fromShort = i.fromModulePath.split('.').slice(-2).join('.');
        const toShort = i.toModulePath.split('.').slice(-2).join('.');
        const patternLabel = i.pattern === 'business'
          ? chalk.cyan('[business]')
          : i.pattern === 'utility'
            ? chalk.yellow('[utility]')
            : '';

        this.log(`  ${step.stepOrder}. ${fromShort} → ${toShort} ${patternLabel}`);
        if (i.semantic) {
          this.log(`     ${chalk.gray(`"${i.semantic}"`)}`);
        }
      }
    } else {
      this.log('');
      this.log(chalk.gray('No steps recorded for this flow.'));
    }
  }

  private getStakeholderDisplay(stakeholder: string): string {
    const colors: Record<string, (s: string) => string> = {
      user: chalk.green,
      admin: chalk.red,
      system: chalk.blue,
      developer: chalk.yellow,
      external: chalk.magenta,
    };
    const colorFn = colors[stakeholder] ?? chalk.white;
    return colorFn(stakeholder);
  }
}
