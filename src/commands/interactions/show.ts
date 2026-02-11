import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import type { InteractionWithPaths } from '../../db/schema.js';
import { SharedFlags, collectFeaturesForFlows, outputJsonOrPlain, withDatabase } from '../_shared/index.js';

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

    await withDatabase(flags.database, this, async (db) => {
      const interaction = db.interactions.getById(args.id);

      if (!interaction) {
        this.error(chalk.red(`Interaction ${args.id} not found.`));
      }

      // Get module details (with descriptions)
      const fromModule = db.modules.getById(interaction.fromModuleId);
      const toModule = db.modules.getById(interaction.toModuleId);

      const interactionWithPaths: InteractionWithPaths = {
        ...interaction,
        fromModulePath: fromModule?.fullPath ?? 'unknown',
        toModulePath: toModule?.fullPath ?? 'unknown',
      };

      // Get flows that use this interaction
      const flows = db.flows.getFlowsWithInteraction(args.id);

      // Get features for each flow (deduplicated)
      const features = collectFeaturesForFlows(flows, db);

      // Resolve symbols: match symbol names against target module's definitions
      const resolvedSymbols: Array<{ name: string; kind: string; filePath: string; line: number }> = [];
      if (interaction.symbols && Array.isArray(interaction.symbols) && interaction.symbols.length > 0 && toModule) {
        const toModuleSymbols = db.modules.getSymbols(toModule.id);
        const symbolMap = new Map(toModuleSymbols.map((s) => [s.name, s]));
        for (const symbolName of interaction.symbols) {
          const resolved = symbolMap.get(symbolName);
          if (resolved) {
            resolvedSymbols.push({
              name: resolved.name,
              kind: resolved.kind,
              filePath: resolved.filePath,
              line: resolved.line,
            });
          }
        }
      }

      // Related interactions from same source module (excluding current)
      const relatedInteractions = fromModule
        ? db.interactions
            .getFromModule(fromModule.id)
            .filter((i) => i.id !== args.id)
            .slice(0, 5)
            .map((i) => ({
              id: i.id,
              toModulePath: i.toModulePath,
              pattern: i.pattern,
              semantic: i.semantic,
              weight: i.weight,
            }))
        : [];

      const jsonData = {
        interaction: interactionWithPaths,
        fromModuleDescription: fromModule?.description ?? null,
        toModuleDescription: toModule?.description ?? null,
        resolvedSymbols,
        relatedInteractions,
        flows: flows.map((f) => ({ id: f.id, name: f.name, slug: f.slug })),
        features,
      };

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        // Display interaction details
        this.log(chalk.bold('Interaction Details'));
        this.log(`ID: ${interaction.id}`);
        this.log(`From: ${chalk.cyan(interactionWithPaths.fromModulePath)}`);
        if (fromModule?.description) {
          this.log(`  ${chalk.gray(fromModule.description)}`);
        }
        this.log(`To: ${chalk.cyan(interactionWithPaths.toModulePath)}`);
        if (toModule?.description) {
          this.log(`  ${chalk.gray(toModule.description)}`);
        }
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
          const resolvedCount = resolvedSymbols.length;
          if (resolvedCount > 0) {
            this.log(chalk.bold(`Symbols (${resolvedCount}/${interaction.symbols.length} resolved)`));
          } else {
            this.log(chalk.bold(`Symbols Called (${interaction.symbols.length})`));
          }
          for (const symbolName of interaction.symbols) {
            const resolved = resolvedSymbols.find((s) => s.name === symbolName);
            if (resolved) {
              this.log(
                `  ${chalk.cyan(resolved.name)} (${resolved.kind}) ${chalk.gray(`${resolved.filePath}:${resolved.line}`)}`
              );
            } else {
              this.log(`  - ${symbolName}`);
            }
          }
        }

        if (flows.length > 0) {
          this.log('');
          this.log(chalk.bold(`Used in Flows (${flows.length})`));
          for (const flow of flows) {
            this.log(`  - ${flow.name} (${flow.slug})`);
          }
        }

        if (features.length > 0) {
          this.log('');
          this.log(chalk.bold(`Features (${features.length})`));
          for (const f of features) {
            this.log(`  ${chalk.cyan(f.name)} (${f.slug})`);
          }
        }

        if (relatedInteractions.length > 0) {
          this.log('');
          this.log(
            chalk.bold(
              `Related Interactions from ${interactionWithPaths.fromModulePath} (${relatedInteractions.length})`
            )
          );
          for (const ri of relatedInteractions) {
            const pattern = ri.pattern ? ` [${ri.pattern}]` : '';
            const semantic = ri.semantic ? ` "${ri.semantic}"` : '';
            this.log(`  -> ${chalk.cyan(ri.toModulePath)}${pattern}${chalk.gray(semantic)} (${ri.weight} calls)`);
          }
        }
      });
    });
  }
}
