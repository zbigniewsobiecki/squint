import { Command, Flags } from '@oclif/core';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class Files extends Command {
  static override description = 'List all indexed files';

  static override examples = [
    '<%= config.bin %> files',
    '<%= config.bin %> files --stats',
    '<%= config.bin %> files -d ./my-index.db',
  ];

  static override flags = {
    database: SharedFlags.database,
    stats: Flags.boolean({
      description: 'Include import statistics (imported-by count, imports count)',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Files);

    await withDatabase(flags.database, this, async (db) => {
      if (flags.stats) {
        const files = db.files.getAllWithStats();
        for (const file of files) {
          this.log(`${file.path}\t${file.importedByCount}\t${file.importsCount}`);
        }
      } else {
        const files = db.files.getAll();
        for (const file of files) {
          this.log(file.path);
        }
      }
    });
  }
}
