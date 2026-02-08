import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withDatabase, SharedFlags, outputJsonOrPlain, tableSeparator } from '../_shared/index.js';

export default class Modules extends Command {
  static override description = 'List all modules with member counts';

  static override examples = [
    '<%= config.bin %> modules',
    '<%= config.bin %> modules --layer service',
    '<%= config.bin %> modules --json',
    '<%= config.bin %> modules -d ./my-index.db',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    layer: Flags.string({
      description: 'Filter by layer (controller, service, repository, adapter, utility)',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Modules);

    await withDatabase(flags.database, this, async (db) => {
      const allModules = db.getAllModulesWithMembers();
      const stats = db.getModuleStats();

      // Filter by layer if specified
      const modules = flags.layer
        ? allModules.filter(m => m.layer === flags.layer)
        : allModules;

      const jsonData = {
        modules: modules.map(m => ({
          id: m.id,
          name: m.name,
          description: m.description,
          layer: m.layer,
          subsystem: m.subsystem,
          memberCount: m.members.length,
        })),
        stats: {
          moduleCount: stats.moduleCount,
          memberCount: stats.memberCount,
          avgMembersPerModule: Math.round(stats.avgMembersPerModule * 10) / 10,
          unassignedDefinitions: stats.unassignedDefinitions,
        },
      };

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        if (modules.length === 0) {
          if (flags.layer) {
            this.log(chalk.gray(`No modules found with layer "${flags.layer}".`));
          } else {
            this.log(chalk.gray('No modules found. Use `ats llm modules` to detect modules.'));
          }
          return;
        }

        this.log(`Modules (${chalk.cyan(String(modules.length))} total, ${chalk.cyan(String(stats.memberCount))} members)`);
        this.log('');

        // Calculate column widths
        const nameWidth = Math.max(16, ...modules.map(m => m.name.length));
        const layerWidth = 12;
        const membersWidth = 8;

        // Header
        this.log(
          chalk.gray('Name'.padEnd(nameWidth)) + '  ' +
          chalk.gray('Layer'.padEnd(layerWidth)) + '  ' +
          chalk.gray('Members'.padEnd(membersWidth)) + '  ' +
          chalk.gray('Description')
        );
        this.log(tableSeparator(nameWidth + layerWidth + membersWidth + 40));

        // Rows
        for (const m of modules) {
          const name = m.name.padEnd(nameWidth);
          const layer = (m.layer ?? '-').padEnd(layerWidth);
          const members = String(m.members.length).padStart(membersWidth - 1).padEnd(membersWidth);
          const desc = m.description ? (m.description.length > 40 ? m.description.slice(0, 37) + '...' : m.description) : '';

          this.log(`${chalk.cyan(name)}  ${chalk.yellow(layer)}  ${members}  ${chalk.gray(desc)}`);
        }

        // Summary
        this.log('');
        this.log(chalk.gray(`${stats.unassignedDefinitions} definitions not assigned to any module`));
      });
    });
  }
}
