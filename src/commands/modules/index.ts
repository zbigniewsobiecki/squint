import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, outputJsonOrPlain, tableSeparator, withDatabase } from '../_shared/index.js';

export default class Modules extends Command {
  static override description = 'List all modules with member counts';

  static override examples = [
    '<%= config.bin %> modules',
    '<%= config.bin %> modules --tree',
    '<%= config.bin %> modules --json',
    '<%= config.bin %> modules -d ./my-index.db',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    tree: Flags.boolean({
      description: 'Show modules as a tree structure',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Modules);

    await withDatabase(flags.database, this, async (db) => {
      const allModules = db.modules.getAllWithMembers();
      const stats = db.modules.getStats();

      const jsonData = {
        modules: allModules.map((m) => ({
          id: m.id,
          parentId: m.parentId,
          slug: m.slug,
          fullPath: m.fullPath,
          name: m.name,
          description: m.description,
          depth: m.depth,
          memberCount: m.members.length,
        })),
        stats: {
          moduleCount: stats.moduleCount,
          assignedSymbols: stats.assigned,
          unassignedSymbols: stats.unassigned,
        },
      };

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        if (allModules.length === 0) {
          this.log(chalk.gray('No modules found. Use `squint llm modules` to create modules.'));
          return;
        }

        this.log(
          `Modules (${chalk.cyan(String(allModules.length))} total, ${chalk.cyan(String(stats.assigned))} symbols assigned)`
        );
        this.log('');

        if (flags.tree) {
          // Tree display
          const tree = db.modules.getTree();
          if (tree) {
            this.printTree(tree, '', true);
          }
        } else {
          // Table display
          const pathWidth = Math.max(30, ...allModules.map((m) => m.fullPath.length));
          const nameWidth = Math.max(16, ...allModules.map((m) => m.name.length));
          const membersWidth = 8;

          // Header
          this.log(
            `${chalk.gray('Path'.padEnd(pathWidth))}  ${chalk.gray('Name'.padEnd(nameWidth))}  ${chalk.gray('Members'.padEnd(membersWidth))}`
          );
          this.log(tableSeparator(pathWidth + nameWidth + membersWidth + 10));

          // Rows
          for (const m of allModules) {
            const path = m.fullPath.padEnd(pathWidth);
            const name = m.name.padEnd(nameWidth);
            const members = String(m.members.length)
              .padStart(membersWidth - 1)
              .padEnd(membersWidth);

            this.log(`${chalk.cyan(path)}  ${name}  ${members}`);
          }
        }

        // Summary
        this.log('');
        this.log(chalk.gray(`${stats.unassigned} symbols not assigned to any module`));
      });
    });
  }

  private printTree(
    node: { fullPath: string; name: string; description: string | null; children: unknown[] },
    prefix: string,
    isLast: boolean
  ): void {
    const connector = isLast ? '└── ' : '├── ';
    const line = prefix + connector + chalk.cyan(node.name);
    const desc = node.description ? chalk.gray(` - ${node.description}`) : '';
    this.log(line + desc);

    const children = node.children as (typeof node)[];
    const newPrefix = prefix + (isLast ? '    ' : '│   ');

    for (let i = 0; i < children.length; i++) {
      this.printTree(children[i], newPrefix, i === children.length - 1);
    }
  }
}
