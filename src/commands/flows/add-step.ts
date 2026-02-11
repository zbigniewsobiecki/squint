import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type { Flow } from '../../db/schema.js';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class FlowsAddStep extends Command {
  static override description = 'Add a step to a flow';

  static override examples = [
    '<%= config.bin %> flows add-step user-login 5',
    '<%= config.bin %> flows add-step 3 5 --order 2',
  ];

  static override args = {
    'flow-id-or-slug': Args.string({ description: 'Flow ID or slug', required: true }),
    'interaction-id': Args.integer({ description: 'Interaction ID to add as step', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    order: Flags.integer({
      description: 'Step order (auto-calculated if not provided)',
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FlowsAddStep);

    await withDatabase(flags.database, this, async (db) => {
      const flow = this.findFlow(db, args['flow-id-or-slug']);
      if (!flow) {
        this.error(chalk.red(`Flow "${args['flow-id-or-slug']}" not found.`));
      }

      // Verify interaction exists
      const interaction = db.interactions.getById(args['interaction-id']);
      if (!interaction) {
        this.error(chalk.red(`Interaction ${args['interaction-id']} not found.`));
      }

      db.flows.addStep(flow.id, args['interaction-id'], flags.order);

      this.log(
        `Added interaction ${chalk.cyan(String(args['interaction-id']))} as step to flow ${chalk.cyan(flow.name)}`
      );
    });
  }

  private findFlow(
    db: { flows: { getById(id: number): Flow | null; getBySlug(slug: string): Flow | null } },
    identifier: string
  ): Flow | null {
    const id = Number.parseInt(identifier, 10);
    if (!Number.isNaN(id)) {
      const flow = db.flows.getById(id);
      if (flow) return flow;
    }
    return db.flows.getBySlug(identifier);
  }
}
