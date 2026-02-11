import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import type { Feature, Flow } from '../../db/schema.js';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class FeaturesUnassign extends Command {
  static override description = 'Remove a flow from a feature';

  static override examples = [
    '<%= config.bin %> features unassign auth user-login',
    '<%= config.bin %> features unassign 3 5',
  ];

  static override args = {
    'feature-id-or-slug': Args.string({ description: 'Feature ID or slug', required: true }),
    'flow-id-or-slug': Args.string({ description: 'Flow ID or slug', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FeaturesUnassign);

    await withDatabase(flags.database, this, async (db) => {
      const feature = this.findFeature(db, args['feature-id-or-slug']);
      if (!feature) {
        this.error(chalk.red(`Feature "${args['feature-id-or-slug']}" not found.`));
      }

      const flow = this.findFlow(db, args['flow-id-or-slug']);
      if (!flow) {
        this.error(chalk.red(`Flow "${args['flow-id-or-slug']}" not found.`));
      }

      const removed = db.features.removeFlow(feature.id, flow.id);
      if (!removed) {
        this.log(chalk.yellow(`Flow "${flow.name}" is not assigned to feature "${feature.name}".`));
        return;
      }

      this.log(`Removed flow ${chalk.cyan(flow.name)} from feature ${chalk.cyan(feature.name)}`);
    });
  }

  private findFeature(
    db: { features: { getById(id: number): Feature | null; getBySlug(slug: string): Feature | null } },
    identifier: string
  ): Feature | null {
    const id = Number.parseInt(identifier, 10);
    if (!Number.isNaN(id)) {
      const feature = db.features.getById(id);
      if (feature) return feature;
    }
    return db.features.getBySlug(identifier);
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
