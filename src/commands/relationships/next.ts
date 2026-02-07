import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase, EnhancedRelationshipContext } from '../../db/database.js';

interface EnhancedRelationshipWithSource extends EnhancedRelationshipContext {
  fromSourceCode: string;
  toSourceCode: string;
}

export default class Next extends Command {
  static override description = 'Show the next relationship that needs annotation with rich context';

  static override examples = [
    '<%= config.bin %> relationships next',
    '<%= config.bin %> relationships next --from UserController',
    '<%= config.bin %> relationships next --count 3',
    '<%= config.bin %> relationships next --json',
  ];

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    from: Flags.string({
      description: 'Filter to relationships from this symbol name',
    }),
    'from-id': Flags.integer({
      description: 'Filter to relationships from this definition ID',
    }),
    count: Flags.integer({
      char: 'c',
      description: 'Number of relationships to show',
      default: 1,
    }),
    json: Flags.boolean({
      description: 'Output as JSON',
      default: false,
    }),
    'max-lines': Flags.integer({
      char: 'm',
      description: 'Maximum lines of source code to show (0 = unlimited)',
      default: 30,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Next);

    const dbPath = path.resolve(flags.database);

    // Check if database exists
    try {
      await fs.access(dbPath);
    } catch {
      this.error(chalk.red(`Database file "${dbPath}" does not exist.\nRun 'ats parse <directory>' first to create an index.`));
    }

    // Open database
    let db: IndexDatabase;
    try {
      db = new IndexDatabase(dbPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(chalk.red(`Failed to open database: ${message}`));
    }

    try {
      // Resolve from-id if from is provided
      let fromDefinitionId: number | undefined;
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
        fromDefinitionId = matches[0].id;
      } else if (flags['from-id'] !== undefined) {
        fromDefinitionId = flags['from-id'];
      }

      // Get unannotated relationships with enhanced context
      const relationships = db.getNextRelationshipToAnnotate({
        limit: flags.count,
        fromDefinitionId,
      });

      // Get total count for display
      const totalRemaining = db.getUnannotatedRelationshipCount(fromDefinitionId);

      if (relationships.length === 0) {
        if (fromDefinitionId !== undefined) {
          this.log(chalk.green('All relationships from this symbol are annotated!'));
        } else {
          this.log(chalk.green('All relationships are annotated!'));
        }
        return;
      }

      // Enhance with source code
      const enhancedRelationships: EnhancedRelationshipWithSource[] = [];
      for (const rel of relationships) {
        const fromSourceCode = await this.readSourceCode(
          rel.fromFilePath,
          rel.fromLine,
          rel.fromEndLine
        );
        const toSourceCode = await this.readSourceCode(
          rel.toFilePath,
          rel.toLine,
          rel.toEndLine
        );

        enhancedRelationships.push({
          ...rel,
          fromSourceCode,
          toSourceCode,
        });
      }

      if (flags.json) {
        this.log(JSON.stringify({
          relationships: enhancedRelationships,
          remaining: totalRemaining,
        }, null, 2));
      } else {
        for (let i = 0; i < enhancedRelationships.length; i++) {
          if (i > 0) {
            this.log('');
          }
          this.outputRelationship(
            enhancedRelationships[i],
            i + 1,
            enhancedRelationships.length,
            totalRemaining,
            flags['max-lines']
          );
        }
      }
    } finally {
      db.close();
    }
  }

  private async readSourceCode(filePath: string, startLine: number, endLine: number): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      // Convert to 0-based indexing for array access
      return lines.slice(startLine - 1, endLine).join('\n');
    } catch {
      return '<source code not available>';
    }
  }

  private outputRelationship(
    rel: EnhancedRelationshipWithSource,
    index: number,
    showingCount: number,
    totalRemaining: number,
    maxLines: number
  ): void {
    const countInfo = showingCount > 1 ? `(${index} of ${showingCount}) ` : '';
    this.log(chalk.gray('═'.repeat(68)));
    this.log(`${countInfo}Relationship needing annotation (${chalk.yellow(totalRemaining)} remaining):`);
    this.log('');

    // FROM symbol with rich context
    this.log(`${chalk.bold('FROM')}: ${chalk.yellow(rel.fromName)} (${rel.fromKind})`);
    this.log(`  ${rel.fromFilePath}:${rel.fromLine}`);

    // Metadata details
    if (rel.fromDomains && rel.fromDomains.length > 0) {
      this.log(`  Domains: ${chalk.magenta('[' + rel.fromDomains.join(', ') + ']')}`);
    }
    if (rel.fromPurpose) {
      this.log(`  Purpose: ${chalk.cyan(rel.fromPurpose)}`);
    }
    if (rel.fromRole) {
      this.log(`  Role: ${chalk.blue(rel.fromRole)}`);
    }
    if (rel.fromPure !== null) {
      this.log(`  Pure: ${rel.fromPure ? chalk.green('true') : chalk.red('false')}`);
    }

    // Other relationships from this symbol
    if (rel.otherFromRelationships.length > 0) {
      this.log(`  Other calls: ${chalk.gray('[' + rel.otherFromRelationships.join(', ') + ']')}`);
    }

    this.log('');
    this.log(chalk.gray('  ' + '─'.repeat(64)));
    this.outputSourceCode(rel.fromSourceCode, rel.fromLine, maxLines);
    this.log(chalk.gray('  ' + '─'.repeat(64)));

    this.log('');

    // TO symbol with rich context
    this.log(`${chalk.bold('TO')}: ${chalk.cyan(rel.toName)} (${rel.toKind})`);
    this.log(`  ${rel.toFilePath}:${rel.toLine}`);

    // Metadata details
    if (rel.toDomains && rel.toDomains.length > 0) {
      this.log(`  Domains: ${chalk.magenta('[' + rel.toDomains.join(', ') + ']')}`);
    }
    if (rel.toPurpose) {
      this.log(`  Purpose: ${chalk.cyan(rel.toPurpose)}`);
    }
    if (rel.toRole) {
      this.log(`  Role: ${chalk.blue(rel.toRole)}`);
    }
    if (rel.toPure !== null) {
      this.log(`  Pure: ${rel.toPure ? chalk.green('true') : chalk.red('false')}`);
    }

    // Other symbols that call this target
    if (rel.otherToRelationships.length > 0) {
      this.log(`  Also called by: ${chalk.gray('[' + rel.otherToRelationships.join(', ') + ']')}`);
    }

    this.log('');
    this.log(chalk.gray('  ' + '─'.repeat(64)));
    this.outputSourceCode(rel.toSourceCode, rel.toLine, maxLines);
    this.log(chalk.gray('  ' + '─'.repeat(64)));

    this.log('');

    // Relationship summary
    this.log(chalk.bold('Relationship context:'));
    this.log(`  Type: ${chalk.yellow(rel.relationshipType)} (line ${rel.usageLine})`);
    if (rel.sharedDomains.length > 0) {
      this.log(`  Domain overlap: ${chalk.magenta('[' + rel.sharedDomains.join(', ') + ']')}`);
    } else if (rel.fromDomains && rel.toDomains) {
      this.log(`  Domain overlap: ${chalk.gray('(none)')}`);
    }

    this.log('');
    this.log('To annotate this relationship:');
    this.log(chalk.gray(`  ats relationships set "<semantic description>" --from-id ${rel.fromDefinitionId} --to-id ${rel.toDefinitionId}`));
    this.log('');
    this.log(chalk.gray('Example annotations:'));
    this.log(chalk.gray('  "delegates authentication - controller hands off to service"'));
    this.log(chalk.gray('  "transforms request into domain model"'));
    this.log(chalk.gray('  "persists data - writes to database"'));
  }

  private outputSourceCode(sourceCode: string, startLine: number, maxLines: number): void {
    const lines = sourceCode.split('\n');
    const totalLines = lines.length;
    const linesToShow = maxLines > 0 && totalLines > maxLines ? maxLines : totalLines;
    const truncated = maxLines > 0 && totalLines > maxLines;

    for (let i = 0; i < linesToShow; i++) {
      const lineNum = startLine + i;
      const lineNumStr = String(lineNum).padStart(5, ' ');
      this.log(`  ${chalk.gray(lineNumStr)} | ${lines[i]}`);
    }

    if (truncated) {
      this.log(chalk.gray(`    ... ${totalLines - maxLines} more lines (use -m 0 to show all)`));
    }
  }
}
