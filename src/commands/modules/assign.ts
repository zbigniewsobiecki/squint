import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class ModulesAssign extends Command {
  static override description = 'Assign a symbol to a module';

  static override examples = [
    '<%= config.bin %> modules assign MyClass project.backend.auth',
    '<%= config.bin %> modules assign 42 project.backend.auth',
  ];

  static override args = {
    symbol: Args.string({ description: 'Definition name or ID', required: true }),
    'module-path': Args.string({ description: 'Module path', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ModulesAssign);

    await withDatabase(flags.database, this, async (db) => {
      // Resolve symbol: try as number first, then by name
      let defId: number;
      const parsed = Number.parseInt(args.symbol, 10);
      if (!Number.isNaN(parsed)) {
        const def = db.definitions.getById(parsed);
        if (!def) {
          this.error(chalk.red(`Definition with ID ${parsed} not found.`));
        }
        defId = parsed;
      } else {
        const defs = db.definitions.getAllByName(args.symbol);
        if (defs.length === 0) {
          this.error(chalk.red(`No definition found with name "${args.symbol}".`));
        }
        if (defs.length > 1) {
          this.log(chalk.yellow(`Multiple definitions match "${args.symbol}":`));
          for (const d of defs) {
            this.log(
              `  ${d.id}: ${chalk.cyan(d.name)} ${chalk.yellow(d.kind)} ${chalk.gray(`${d.filePath}:${d.line}`)}`
            );
          }
          this.error(chalk.red('Please specify the definition ID instead.'));
        }
        defId = defs[0].id;
      }

      // Find module
      const module = db.modules.getByPath(args['module-path']);
      if (!module) {
        this.error(chalk.red(`Module "${args['module-path']}" not found.`));
      }

      db.modules.assignSymbol(defId, module.id);
      this.log(`Assigned definition ${chalk.cyan(String(defId))} to module ${chalk.cyan(args['module-path'])}`);
    });
  }
}
