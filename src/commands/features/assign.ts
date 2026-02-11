import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import type { Feature, Flow } from '../../db/schema.js';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class FeaturesAssign extends Command {
  static override description = 'Assign a flow to a feature';

  static override examples = [
    '<%= config.bin %> features assign auth user-login',
    '<%= config.bin %> features assign 3 5',
  ];

  static override args = {
    'feature-id-or-slug': Args.string({ description: 'Feature ID or slug', required: true }),
    'flow-id-or-slug': Args.string({ description: 'Flow ID or slug', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FeaturesAssign);

    await withDatabase(flags.database, this, async (db) => {
      const feature = this.findFeature(db, args['feature-id-or-slug']);
      if (!feature) {
        this.error(chalk.red(`Feature "${args['feature-id-or-slug']}" not found.`));
      }

      const flow = this.findFlow(db, args['flow-id-or-slug']);
      if (!flow) {
        this.error(chalk.red(`Flow "${args['flow-id-or-slug']}" not found.`));
      }

      db.features.addFlows(feature.id, [flow.id]);

      this.log(`Assigned flow ${chalk.cyan(flow.name)} to feature ${chalk.cyan(feature.name)}`);
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
