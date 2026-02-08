import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { openDatabase, SharedFlags } from '../_shared/index.js';

export default class Interactions extends Command {
  static override description = 'List all detected module interactions';

  static override examples = [
    '<%= config.bin %> interactions',
    '<%= config.bin %> interactions --pattern business',
    '<%= config.bin %> interactions --pattern utility',
    '<%= config.bin %> interactions -d index.db --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    pattern: Flags.string({
      description: 'Filter by pattern type',
      options: ['business', 'utility'],
    }),
    module: Flags.string({
      description: 'Filter by module (from or to)',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Interactions);

    const db = await openDatabase(flags.database, this);
    const isJson = flags.json;

    try {
      let interactions = db.getAllInteractions();

      // Apply filters
      if (flags.pattern) {
        interactions = interactions.filter(i => i.pattern === flags.pattern);
      }

      if (flags.module) {
        const moduleFilter = flags.module.toLowerCase();
        interactions = interactions.filter(i =>
          i.fromModulePath.toLowerCase().includes(moduleFilter) ||
          i.toModulePath.toLowerCase().includes(moduleFilter)
        );
      }

      if (interactions.length === 0) {
        if (isJson) {
          this.log(JSON.stringify({ interactions: [], stats: { totalCount: 0 } }));
        } else {
          this.log(chalk.gray('No interactions detected yet.'));
          this.log(chalk.gray('Run `ats llm interactions` to detect interactions from module call graph.'));
        }
        return;
      }

      if (isJson) {
        const stats = db.getInteractionStats();
        this.log(JSON.stringify({ interactions, stats }, null, 2));
        return;
      }

      // Group by pattern
      const businessInteractions = interactions.filter(i => i.pattern === 'business');
      const utilityInteractions = interactions.filter(i => i.pattern === 'utility');
      const otherInteractions = interactions.filter(i => !i.pattern);

      this.log(chalk.bold(`Interactions (${interactions.length})`));
      this.log('');

      if (businessInteractions.length > 0) {
        this.log(chalk.bold.cyan('Business Logic'));
        for (const interaction of businessInteractions) {
          this.printInteraction(interaction);
        }
        this.log('');
      }

      if (utilityInteractions.length > 0) {
        this.log(chalk.bold.yellow('Utility/Infrastructure'));
        for (const interaction of utilityInteractions) {
          this.printInteraction(interaction);
        }
        this.log('');
      }

      if (otherInteractions.length > 0) {
        this.log(chalk.bold('Unclassified'));
        for (const interaction of otherInteractions) {
          this.printInteraction(interaction);
        }
        this.log('');
      }

      // Stats
      const stats = db.getInteractionStats();
      this.log(chalk.bold('Statistics'));
      this.log(`Total: ${stats.totalCount}`);
      this.log(`Business: ${stats.businessCount}`);
      this.log(`Utility: ${stats.utilityCount}`);
      this.log(`Bi-directional: ${stats.biDirectionalCount}`);
    } finally {
      db.close();
    }
  }

  private printInteraction(interaction: {
    fromModulePath: string;
    toModulePath: string;
    pattern: string | null;
    weight: number;
    symbols: string | null;
    semantic: string | null;
    direction: string;
  }): void {
    const arrow = interaction.direction === 'bi' ? '↔' : '→';
    const patternLabel = interaction.pattern === 'business'
      ? chalk.cyan('[business]')
      : interaction.pattern === 'utility'
        ? chalk.yellow('[utility]')
        : '';

    const fromShort = interaction.fromModulePath.split('.').slice(-2).join('.');
    const toShort = interaction.toModulePath.split('.').slice(-2).join('.');

    this.log(`  ${fromShort} ${arrow} ${toShort} ${patternLabel}`);

    if (interaction.semantic) {
      this.log(`    ${chalk.gray(`"${interaction.semantic}"`)}`);
    }

    if (interaction.symbols) {
      try {
        const symbols = JSON.parse(interaction.symbols) as string[];
        if (symbols.length > 0) {
          const symbolList = symbols.slice(0, 5).join(', ');
          const more = symbols.length > 5 ? ` (+${symbols.length - 5} more)` : '';
          this.log(`    ${chalk.gray(`Calls: ${symbolList}${more}`)}`);
        }
      } catch {
        // Ignore parse errors
      }
    }
  }
}
