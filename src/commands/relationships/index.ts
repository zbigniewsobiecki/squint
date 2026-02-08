import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class Relationships extends Command {
  static override description = 'List relationship annotations between symbols';

  static override examples = [
    '<%= config.bin %> relationships',
    '<%= config.bin %> relationships --from UserController',
    '<%= config.bin %> relationships --to AuthService',
    '<%= config.bin %> relationships --from-id 42',
    '<%= config.bin %> relationships --count',
  ];

  static override flags = {
    database: SharedFlags.database,
    from: Flags.string({
      description: 'Filter to relationships from this symbol name',
    }),
    to: Flags.string({
      description: 'Filter to relationships to this symbol name',
    }),
    'from-id': Flags.integer({
      description: 'Filter to relationships from this definition ID',
    }),
    'to-id': Flags.integer({
      description: 'Filter to relationships to this definition ID',
    }),
    count: Flags.boolean({
      description: 'Show only the count of relationship annotations',
      default: false,
    }),
    limit: Flags.integer({
      description: 'Maximum number of relationships to show',
      default: 100,
    }),
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Relationships);

    await withDatabase(flags.database, this, async (db) => {
      // Handle --count flag
      if (flags.count) {
        const count = db.getRelationshipAnnotationCount();
        this.log(`${count} relationship annotation${count !== 1 ? 's' : ''}`);
        return;
      }

      // Handle --from flag (name lookup)
      if (flags.from) {
        const matches = db.getDefinitionsByName(flags.from);
        if (matches.length === 0) {
          this.error(chalk.red(`No symbol found with name "${flags.from}"`));
        }
        if (matches.length > 1) {
          this.log(chalk.yellow(`Multiple symbols found with name "${flags.from}":`));
          for (const match of matches) {
            this.log(`  ${chalk.cyan('--from-id')} ${match.id}\t${match.kind}\t${match.filePath}:${match.line}`);
          }
          this.log('');
          this.log(chalk.gray('Use --from-id to disambiguate'));
          return;
        }
        const relationships = db.getRelationshipsFrom(matches[0].id);
        this.outputRelationships(relationships, `from ${flags.from}`);
        return;
      }

      // Handle --to flag (name lookup)
      if (flags.to) {
        const matches = db.getDefinitionsByName(flags.to);
        if (matches.length === 0) {
          this.error(chalk.red(`No symbol found with name "${flags.to}"`));
        }
        if (matches.length > 1) {
          this.log(chalk.yellow(`Multiple symbols found with name "${flags.to}":`));
          for (const match of matches) {
            this.log(`  ${chalk.cyan('--to-id')} ${match.id}\t${match.kind}\t${match.filePath}:${match.line}`);
          }
          this.log('');
          this.log(chalk.gray('Use --to-id to disambiguate'));
          return;
        }
        const relationships = db.getRelationshipsTo(matches[0].id);
        this.outputRelationships(relationships, `to ${flags.to}`);
        return;
      }

      // Handle --from-id flag
      if (flags['from-id'] !== undefined) {
        const def = db.getDefinitionById(flags['from-id']);
        if (!def) {
          this.error(chalk.red(`No definition found with ID ${flags['from-id']}`));
        }
        const relationships = db.getRelationshipsFrom(flags['from-id']);
        this.outputRelationships(relationships, `from ${def.name} (ID ${flags['from-id']})`);
        return;
      }

      // Handle --to-id flag
      if (flags['to-id'] !== undefined) {
        const def = db.getDefinitionById(flags['to-id']);
        if (!def) {
          this.error(chalk.red(`No definition found with ID ${flags['to-id']}`));
        }
        const relationships = db.getRelationshipsTo(flags['to-id']);
        this.outputRelationships(relationships, `to ${def.name} (ID ${flags['to-id']})`);
        return;
      }

      // Default: list all relationships
      const relationships = db.getAllRelationshipAnnotations({ limit: flags.limit });

      if (flags.json) {
        this.log(JSON.stringify({ relationships, count: relationships.length }, null, 2));
        return;
      }

      if (relationships.length === 0) {
        this.log(chalk.gray('No annotated relationships found.'));
        this.log(chalk.gray('Use `ats relationships set` to annotate relationships between symbols.'));
      } else {
        for (const rel of relationships) {
          this.log(`${chalk.yellow(rel.fromName)} ${chalk.gray('->')} ${chalk.cyan(rel.toName)}`);
          this.log(`  ${rel.semantic}`);
        }
        this.log('');
        const total = db.getRelationshipAnnotationCount();
        if (relationships.length < total) {
          this.log(
            chalk.gray(`Showing ${relationships.length} of ${total} relationship(s) (use --limit to show more)`)
          );
        } else {
          this.log(chalk.gray(`Found ${relationships.length} relationship annotation(s)`));
        }
      }
    });
  }

  private outputRelationships(
    relationships: Array<{
      fromName: string;
      toName: string;
      semantic: string;
      toFilePath: string;
      toLine: number;
    }>,
    context: string
  ): void {
    if (relationships.length === 0) {
      this.log(chalk.gray(`No relationship annotations found ${context}.`));
    } else {
      this.log(`Relationships ${context}:`);
      this.log('');
      for (const rel of relationships) {
        this.log(`${chalk.yellow(rel.fromName)} ${chalk.gray('->')} ${chalk.cyan(rel.toName)}`);
        this.log(`  ${rel.semantic}`);
        this.log(chalk.gray(`  ${rel.toFilePath}:${rel.toLine}`));
      }
      this.log('');
      this.log(chalk.gray(`Found ${relationships.length} relationship(s)`));
    }
  }
}
