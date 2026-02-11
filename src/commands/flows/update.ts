import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type { Flow, FlowStakeholder } from '../../db/schema.js';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class FlowsUpdate extends Command {
  static override description = 'Update a flow';

  static override examples = [
    '<%= config.bin %> flows update user-login --name "User Login V2"',
    '<%= config.bin %> flows update 5 --description "Updated description" --stakeholder admin',
  ];

  static override args = {
    'id-or-slug': Args.string({ description: 'Flow ID or slug', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    name: Flags.string({
      description: 'New flow name',
    }),
    description: Flags.string({
      description: 'New flow description',
    }),
    stakeholder: Flags.string({
      description: 'New flow stakeholder',
      options: ['user', 'admin', 'system', 'developer', 'external'],
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FlowsUpdate);

    if (!flags.name && !flags.description && !flags.stakeholder) {
      this.error(chalk.red('At least one of --name, --description, or --stakeholder is required.'));
    }

    await withDatabase(flags.database, this, async (db) => {
      const flow = this.findFlow(db, args['id-or-slug']);
      if (!flow) {
        this.error(chalk.red(`Flow "${args['id-or-slug']}" not found.`));
      }

      const updates: { name?: string; description?: string; stakeholder?: FlowStakeholder } = {};
      if (flags.name) updates.name = flags.name;
      if (flags.description) updates.description = flags.description;
      if (flags.stakeholder) updates.stakeholder = flags.stakeholder as FlowStakeholder;

      const updated = db.flows.update(flow.id, updates);
      if (!updated) {
        this.error(chalk.red(`Failed to update flow "${args['id-or-slug']}".`));
      }

      this.log(`Updated flow ${chalk.cyan(flow.name)} (${chalk.gray(flow.slug)})`);
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
