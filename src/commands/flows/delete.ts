import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import type { Flow } from '../../db/schema.js';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class FlowsDelete extends Command {
  static override description = 'Delete a flow';

  static override examples = ['<%= config.bin %> flows delete user-login', '<%= config.bin %> flows delete 5'];

  static override args = {
    'id-or-slug': Args.string({ description: 'Flow ID or slug', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FlowsDelete);

    await withDatabase(flags.database, this, async (db) => {
      const flow = this.findFlow(db, args['id-or-slug']);
      if (!flow) {
        this.error(chalk.red(`Flow "${args['id-or-slug']}" not found.`));
      }

      const deleted = db.flows.delete(flow.id);
      if (!deleted) {
        this.error(chalk.red(`Failed to delete flow "${args['id-or-slug']}".`));
      }

      this.log(`Deleted flow ${chalk.cyan(flow.name)} (${chalk.gray(flow.slug)})`);
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
