import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import type { InteractionWithPaths } from '../../db/schema.js';
import { SharedFlags, openDatabase } from '../_shared/index.js';

export default class InteractionsShow extends Command {
  static override description = 'Show details for a specific interaction';

  static override examples = ['<%= config.bin %> interactions show 5', '<%= config.bin %> interactions show 5 --json'];

  static override args = {
    id: Args.integer({ description: 'Interaction ID', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(InteractionsShow);

    const db = await openDatabase(flags.database, this);
    const isJson = flags.json;

    try {
      const interaction = db.interactions.getById(args.id);

      if (!interaction) {
        if (isJson) {
          this.log(JSON.stringify({ error: `Interaction ${args.id} not found` }));
        } else {
          this.log(chalk.red(`Interaction ${args.id} not found.`));
        }
        return;
      }

      // Get module paths
      const modules = db.modules.getAll();
      const moduleMap = new Map(modules.map((m) => [m.id, m.fullPath]));

      const interactionWithPaths: InteractionWithPaths = {
        ...interaction,
        fromModulePath: moduleMap.get(interaction.fromModuleId) ?? 'unknown',
        toModulePath: moduleMap.get(interaction.toModuleId) ?? 'unknown',
      };

      // Get flows that use this interaction
      const flows = db.flows.getFlowsWithInteraction(args.id);

      if (isJson) {
        this.log(
          JSON.stringify(
            {
              interaction: interactionWithPaths,
              flows: flows.map((f) => ({ id: f.id, name: f.name, slug: f.slug })),
            },
            null,
            2
          )
        );
        return;
      }

      // Display interaction details
      this.log(chalk.bold('Interaction Details'));
      this.log(`ID: ${interaction.id}`);
      this.log(`From: ${chalk.cyan(interactionWithPaths.fromModulePath)}`);
      this.log(`To: ${chalk.cyan(interactionWithPaths.toModulePath)}`);
      this.log(`Direction: ${interaction.direction === 'bi' ? 'Bi-directional' : 'Uni-directional'}`);
      this.log(`Pattern: ${interaction.pattern ?? 'unclassified'}`);
      this.log(`Source: ${interaction.source === 'llm-inferred' ? 'LLM-inferred' : 'AST-detected'}`);
      this.log(`Weight: ${interaction.weight} calls`);

      if (interaction.semantic) {
        this.log('');
        this.log(chalk.bold('Semantic'));
        this.log(`  "${interaction.semantic}"`);
      }

      if (interaction.symbols && Array.isArray(interaction.symbols) && interaction.symbols.length > 0) {
        this.log('');
        this.log(chalk.bold(`Symbols Called (${interaction.symbols.length})`));
        for (const symbol of interaction.symbols) {
          this.log(`  - ${symbol}`);
        }
      }

      if (flows.length > 0) {
        this.log('');
        this.log(chalk.bold(`Used in Flows (${flows.length})`));
        for (const flow of flows) {
          this.log(`  - ${flow.name} (${flow.slug})`);
        }
      }
    } finally {
      db.close();
    }
  }
}
