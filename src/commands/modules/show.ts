import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withDatabase, SharedFlags, outputJsonOrPlain, tableSeparator } from '../_shared/index.js';

export default class ModulesShow extends Command {
  static override description = 'Show module details including members';

  static override examples = [
    '<%= config.bin %> modules show auth',
    '<%= config.bin %> modules show user-api --json',
    '<%= config.bin %> modules show database -d ./my-index.db',
  ];

  static override args = {
    name: Args.string({ description: 'Module name to show', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ModulesShow);

    await withDatabase(flags.database, this, async (db) => {
      const allModules = db.getAllModulesWithMembers();
      const module = allModules.find(m => m.name === args.name);

      if (!module) {
        // Try partial match
        const matches = allModules.filter(m =>
          m.name.toLowerCase().includes(args.name.toLowerCase())
        );

        if (matches.length === 1) {
          // Use the single match
          return this.displayModule(matches[0], flags.json);
        } else if (matches.length > 1) {
          this.log(chalk.yellow(`Multiple modules match "${args.name}":`));
          for (const m of matches) {
            this.log(`  ${chalk.cyan(m.name)} (${m.members.length} members)`);
          }
          this.log('');
          this.log(chalk.gray('Please specify the exact module name.'));
          return;
        }

        this.error(chalk.red(`Module "${args.name}" not found.`));
      }

      return this.displayModule(module, flags.json);
    });
  }

  private displayModule(module: {
    id: number;
    name: string;
    description: string | null;
    layer: string | null;
    subsystem: string | null;
    members: Array<{
      definitionId: number;
      name: string;
      kind: string;
      filePath: string;
      cohesion: number | null;
    }>;
  }, json: boolean): void {
    const jsonData = {
      id: module.id,
      name: module.name,
      description: module.description,
      layer: module.layer,
      subsystem: module.subsystem,
      memberCount: module.members.length,
      members: module.members.map(m => ({
        id: m.definitionId,
        name: m.name,
        kind: m.kind,
        filePath: m.filePath,
        cohesion: m.cohesion,
      })),
    };

    outputJsonOrPlain(this, json, jsonData, () => {
      this.log(`Module: ${chalk.cyan(module.name)}`);
      this.log(`Layer: ${module.layer ? chalk.yellow(module.layer) : chalk.gray('not set')}`);
      if (module.subsystem) {
        this.log(`Subsystem: ${chalk.blue(module.subsystem)}`);
      }
      if (module.description) {
        this.log(`Description: ${module.description}`);
      }
      this.log('');
      this.log(`Members (${chalk.cyan(String(module.members.length))}):`);

      if (module.members.length === 0) {
        this.log(chalk.gray('  No members assigned to this module.'));
        return;
      }

      // Calculate column widths
      const nameWidth = Math.max(20, ...module.members.map(m => m.name.length));
      const kindWidth = 12;

      this.log('');
      this.log(
        '  ' + chalk.gray('Name'.padEnd(nameWidth)) + '  ' +
        chalk.gray('Kind'.padEnd(kindWidth)) + '  ' +
        chalk.gray('Location')
      );
      this.log('  ' + tableSeparator(nameWidth + kindWidth + 50));

      for (const m of module.members) {
        const name = m.name.padEnd(nameWidth);
        const kind = m.kind.padEnd(kindWidth);
        const shortPath = m.filePath.length > 45
          ? '...' + m.filePath.slice(-42)
          : m.filePath;

        this.log(`  ${chalk.cyan(name)}  ${chalk.yellow(kind)}  ${chalk.gray(shortPath)}`);
      }
    });
  }
}
