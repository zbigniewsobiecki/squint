import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, outputJsonOrPlain, withDatabase } from '../_shared/index.js';

export default class RelationshipsShow extends Command {
  static override description = 'Show relationship detail between two definitions';

  static override examples = [
    '<%= config.bin %> relationships show --from 10 --to 20',
    '<%= config.bin %> relationships show --from 10 --to 20 --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    from: Flags.integer({
      description: 'Source definition ID',
      required: true,
    }),
    to: Flags.integer({
      description: 'Target definition ID',
      required: true,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(RelationshipsShow);

    await withDatabase(flags.database, this, async (db) => {
      const relationship = db.relationships.get(flags.from, flags.to);

      if (!relationship) {
        this.error(chalk.red(`No relationship found from definition ${flags.from} to definition ${flags.to}.`));
      }

      // Get definition details for context
      const fromDef = db.definitions.getById(flags.from);
      const toDef = db.definitions.getById(flags.to);

      const jsonData = {
        relationship,
        from: fromDef,
        to: toDef,
      };

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        this.log(chalk.bold('Relationship Details'));
        this.log(`ID: ${relationship.id}`);
        this.log(`Type: ${relationship.relationshipType}`);
        this.log(`Semantic: ${relationship.semantic}`);
        this.log('');
        if (fromDef) {
          this.log(
            `From: ${chalk.cyan(fromDef.name)} (${fromDef.kind}) ${chalk.gray(`${fromDef.filePath}:${fromDef.line}`)}`
          );
        } else {
          this.log(`From: definition ${flags.from}`);
        }
        if (toDef) {
          this.log(`To: ${chalk.cyan(toDef.name)} (${toDef.kind}) ${chalk.gray(`${toDef.filePath}:${toDef.line}`)}`);
        } else {
          this.log(`To: definition ${flags.to}`);
        }
      });
    });
  }
}
