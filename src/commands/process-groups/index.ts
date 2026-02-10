import { Command } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, openDatabase } from '../_shared/index.js';
import { computeProcessGroups, getProcessGroupLabel } from '../llm/_shared/process-utils.js';

export default class ProcessGroupsCommand extends Command {
  static override description = 'List process groups (connected components in the import graph)';

  static override examples = [
    '<%= config.bin %> process-groups -d index.db',
    '<%= config.bin %> process-groups -d index.db --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(ProcessGroupsCommand);

    const db = await openDatabase(flags.database, this);
    const isJson = flags.json;

    try {
      const groups = computeProcessGroups(db);

      // Partition into major (2+ modules) and isolated (1 module)
      type ModSummary = { id: number; fullPath: string; name: string; description: string | null };
      const major: { label: string; modules: ModSummary[] }[] = [];
      const isolated: ModSummary[] = [];

      for (const [, modules] of groups.groupToModules) {
        if (modules.length >= 2) {
          major.push({
            label: getProcessGroupLabel(modules),
            modules: modules.map((m) => ({
              id: m.id,
              fullPath: m.fullPath,
              name: m.name,
              description: m.description,
            })),
          });
        } else {
          for (const m of modules) {
            isolated.push({
              id: m.id,
              fullPath: m.fullPath,
              name: m.name,
              description: m.description,
            });
          }
        }
      }

      // Sort major groups by size descending
      major.sort((a, b) => b.modules.length - a.modules.length);

      // Sort isolated alphabetically by fullPath
      isolated.sort((a, b) => a.fullPath.localeCompare(b.fullPath));

      // Sort modules within each major group alphabetically
      for (const group of major) {
        group.modules.sort((a, b) => a.fullPath.localeCompare(b.fullPath));
      }

      const totalModules = major.reduce((sum, g) => sum + g.modules.length, 0) + isolated.length;

      if (isJson) {
        this.log(
          JSON.stringify(
            {
              groups: major.map((g) => ({
                label: g.label,
                moduleCount: g.modules.length,
                modules: g.modules,
              })),
              isolated,
              stats: {
                totalGroups: major.length + isolated.length,
                majorGroups: major.length,
                isolatedGroups: isolated.length,
                totalModules,
              },
            },
            null,
            2
          )
        );
        return;
      }

      // Human-readable output
      this.log(chalk.bold(`Process Groups (${major.length} major, ${isolated.length} isolated)`));
      this.log('');

      for (let i = 0; i < major.length; i++) {
        const group = major[i];
        this.log(chalk.bold(`Group ${i + 1}: ${group.label} (${group.modules.length} modules)`));
        for (const mod of group.modules) {
          const desc = mod.description ? `  —  ${mod.description}` : '';
          this.log(`  ${mod.fullPath}${chalk.gray(desc)}`);
        }
        this.log('');
      }

      if (isolated.length > 0) {
        this.log(chalk.bold(`Isolated (${isolated.length} modules in singleton groups)`));
        for (const mod of isolated) {
          const desc = mod.description ? `  —  ${mod.description}` : '';
          this.log(`  ${mod.fullPath}${chalk.gray(desc)}`);
        }
        this.log('');
      }
    } finally {
      db.close();
    }
  }
}
