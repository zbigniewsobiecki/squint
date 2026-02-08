import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withDatabase, SharedFlags, outputJsonOrPlain, tableSeparator } from '../_shared/index.js';
import type { ModuleWithMembers } from '../../db/database.js';

export default class ModulesShow extends Command {
  static override description = 'Show module details including members';

  static override examples = [
    '<%= config.bin %> modules show auth',
    '<%= config.bin %> modules show project.backend.services --json',
    '<%= config.bin %> modules show database -d ./my-index.db',
  ];

  static override args = {
    name: Args.string({ description: 'Module name or path to show', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ModulesShow);

    await withDatabase(flags.database, this, async (db) => {
      const allModules = db.getAllModulesWithMembers();

      // Try exact match on full path first
      let module = allModules.find(m => m.fullPath === args.name);

      // Try exact match on name
      if (!module) {
        module = allModules.find(m => m.name === args.name);
      }

      if (!module) {
        // Try partial match on path or name
        const matches = allModules.filter(m =>
          m.fullPath.toLowerCase().includes(args.name.toLowerCase()) ||
          m.name.toLowerCase().includes(args.name.toLowerCase())
        );

        if (matches.length === 1) {
          return this.displayModule(matches[0], flags.json);
        } else if (matches.length > 1) {
          this.log(chalk.yellow(`Multiple modules match "${args.name}":`));
          for (const m of matches) {
            this.log(`  ${chalk.cyan(m.fullPath)} (${m.members.length} members)`);
          }
          this.log('');
          this.log(chalk.gray('Please specify the exact module path.'));
          return;
        }

        this.error(chalk.red(`Module "${args.name}" not found.`));
      }

      return this.displayModule(module, flags.json);
    });
  }

  private displayModule(module: ModuleWithMembers, json: boolean): void {
    const jsonData = {
      id: module.id,
      parentId: module.parentId,
      slug: module.slug,
      fullPath: module.fullPath,
      name: module.name,
      description: module.description,
      depth: module.depth,
      memberCount: module.members.length,
      members: module.members.map(m => ({
        id: m.definitionId,
        name: m.name,
        kind: m.kind,
        filePath: m.filePath,
        line: m.line,
      })),
    };

    outputJsonOrPlain(this, json, jsonData, () => {
      this.log(`Module: ${chalk.cyan(module.name)}`);
      this.log(`Path: ${chalk.gray(module.fullPath)}`);
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
        const location = `${shortPath}:${m.line}`;

        this.log(`  ${chalk.cyan(name)}  ${chalk.yellow(kind)}  ${chalk.gray(location)}`);
      }
    });
  }
}
