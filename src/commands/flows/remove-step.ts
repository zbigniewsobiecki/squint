import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import type { Flow } from '../../db/schema.js';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class FlowsRemoveStep extends Command {
  static override description = 'Remove a step from a flow';

  static override examples = [
    '<%= config.bin %> flows remove-step user-login 2',
    '<%= config.bin %> flows remove-step 3 1',
  ];

  static override args = {
    'flow-id-or-slug': Args.string({ description: 'Flow ID or slug', required: true }),
    'step-order': Args.integer({ description: 'Step order to remove', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FlowsRemoveStep);

    await withDatabase(flags.database, this, async (db) => {
      const flow = this.findFlow(db, args['flow-id-or-slug']);
      if (!flow) {
        this.error(chalk.red(`Flow "${args['flow-id-or-slug']}" not found.`));
      }

      const removed = db.flows.removeStep(flow.id, args['step-order']);
      if (!removed) {
        this.error(chalk.red(`Step ${args['step-order']} not found in flow "${flow.name}".`));
      }

      this.log(`Removed step ${chalk.cyan(String(args['step-order']))} from flow ${chalk.cyan(flow.name)}`);
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
