import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { IndexDatabase } from '../../db/database.js';

interface BatchEntry {
  name?: string;
  id?: number;
  file?: string;
  value: string;
}

interface BatchResult {
  symbol: string;
  success: boolean;
  error?: string;
}

export default class Set extends Command {
  static override description = 'Set metadata on a symbol';

  static override examples = [
    '<%= config.bin %> symbols set purpose "Parse TS files" --name parseFile',
    '<%= config.bin %> symbols set purpose "Main entry point" --id 42',
    '<%= config.bin %> symbols set status "deprecated" --name MyClass --file src/models/user.ts',
    'echo \'[{"name":"foo","value":"desc1"}]\' | <%= config.bin %> symbols set purpose --batch',
  ];

  static override args = {
    key: Args.string({ description: 'Metadata key', required: true }),
    value: Args.string({ description: 'Metadata value (required unless --batch)' }),
  };

  static override flags = {
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
    name: Flags.string({
      char: 'n',
      description: 'Symbol name',
    }),
    file: Flags.string({
      char: 'f',
      description: 'Disambiguate by file path',
    }),
    id: Flags.integer({
      description: 'Set by definition ID directly',
    }),
    batch: Flags.boolean({
      description: 'Read symbol-value pairs from stdin (JSON array)',
      default: false,
    }),
    'input-file': Flags.string({
      char: 'i',
      description: 'Read batch input from file instead of stdin',
    }),
    json: Flags.boolean({
      description: 'Output as JSON (for batch mode)',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Set);

    // Handle batch mode vs single mode
    if (flags.batch || flags['input-file']) {
      await this.runBatchMode(args.key, flags);
      return;
    }

    // Single mode validation
    if (!args.value) {
      this.error('Value argument is required (or use --batch to read from stdin)');
    }

    if (!flags.name && flags.id === undefined) {
      this.error('Either provide --name or --id to identify the symbol');
    }

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
      // Resolve the definition
      const definition = this.resolveDefinition(db, flags.name, flags.id, flags.file);

      if (!definition) {
        return; // Error already shown in resolveDefinition
      }

      // Set the metadata
      db.setDefinitionMetadata(definition.id, args.key, args.value);

      // Get the definition name for output
      const defDetails = db.getDefinitionById(definition.id);
      const displayName = defDetails?.name ?? `ID ${definition.id}`;

      this.log(`Set ${chalk.cyan(args.key)}="${args.value}" on ${chalk.yellow(displayName)}`);
    } finally {
      db.close();
    }
  }

  private async runBatchMode(key: string, flags: { database: string; json: boolean; 'input-file'?: string; batch?: boolean }): Promise<void> {
    const dbPath = path.resolve(flags.database);

    // Check if database exists
    try {
      await fs.access(dbPath);
    } catch {
      this.error(chalk.red(`Database file "${dbPath}" does not exist.\nRun 'ats parse <directory>' first to create an index.`));
    }

    // Read input from file or stdin
    let input = '';
    if (flags['input-file']) {
      try {
        input = await fs.readFile(flags['input-file'], 'utf8');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.error(chalk.red(`Failed to read input file: ${message}`));
      }
    } else {
      try {
        input = await this.readStdin();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.error(chalk.red(`Failed to read stdin: ${message}`));
      }
    }

    if (!input.trim()) {
      this.error(chalk.red('No input received. Provide a JSON array of entries.'));
    }

    // Parse JSON
    let entries: BatchEntry[];
    try {
      entries = JSON.parse(input);
      if (!Array.isArray(entries)) {
        this.error(chalk.red('Input must be a JSON array'));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(chalk.red(`Failed to parse JSON: ${message}`));
    }

    // Open database
    let db: IndexDatabase;
    try {
      db = new IndexDatabase(dbPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(chalk.red(`Failed to open database: ${message}`));
    }

    const results: BatchResult[] = [];

    try {
      for (const entry of entries) {
        const symbolId = entry.name ?? entry.id?.toString() ?? 'unknown';

        // Validate entry
        if (!entry.value) {
          results.push({ symbol: symbolId, success: false, error: 'Missing value' });
          continue;
        }

        if (!entry.name && entry.id === undefined) {
          results.push({ symbol: symbolId, success: false, error: 'Missing name or id' });
          continue;
        }

        try {
          // Resolve the definition (silently)
          const definition = this.resolveDefinitionSilent(db, entry.name, entry.id, entry.file);

          if (!definition) {
            results.push({ symbol: symbolId, success: false, error: 'Symbol not found or ambiguous' });
            continue;
          }

          // Set the metadata
          db.setDefinitionMetadata(definition.id, key, entry.value);

          const defDetails = db.getDefinitionById(definition.id);
          results.push({ symbol: defDetails?.name ?? symbolId, success: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({ symbol: symbolId, success: false, error: message });
        }
      }
    } finally {
      db.close();
    }

    // Output results
    if (flags.json) {
      this.log(JSON.stringify({ key, results }, null, 2));
    } else {
      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      this.log(`Set ${chalk.cyan(key)} on ${chalk.green(successCount)} symbols${failCount > 0 ? `, ${chalk.red(failCount)} failed` : ''}:`);

      for (const result of results) {
        if (result.success) {
          this.log(`  ${chalk.green('✓')} ${result.symbol}`);
        } else {
          this.log(`  ${chalk.red('✗')} ${result.symbol} (${result.error})`);
        }
      }
    }
  }

  private async readStdin(): Promise<string> {
    // Check if stdin is a TTY (interactive terminal)
    if (process.stdin.isTTY) {
      throw new Error('No input piped to stdin. Use: echo \'[...]\' | ats symbols set ... --batch');
    }

    return new Promise((resolve, reject) => {
      const chunks: string[] = [];
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        chunks.push(chunk);
      });
      process.stdin.on('end', () => {
        resolve(chunks.join(''));
      });
      process.stdin.on('error', reject);
      // Ensure stdin is flowing
      process.stdin.resume();
    });
  }

  private resolveDefinitionSilent(
    db: IndexDatabase,
    name: string | undefined,
    id: number | undefined,
    filePath: string | undefined
  ): { id: number } | null {
    // Direct ID lookup
    if (id !== undefined) {
      const def = db.getDefinitionById(id);
      if (!def) return null;
      return { id };
    }

    // Name lookup
    if (!name) return null;

    let matches = db.getDefinitionsByName(name);
    if (matches.length === 0) return null;

    // Filter by file if specified
    if (filePath) {
      const resolvedPath = path.resolve(filePath);
      matches = matches.filter(m => m.filePath === resolvedPath || m.filePath.endsWith(filePath));
      if (matches.length === 0) return null;
    }

    // Ambiguous
    if (matches.length > 1) return null;

    return { id: matches[0].id };
  }

  private resolveDefinition(
    db: IndexDatabase,
    name: string | undefined,
    id: number | undefined,
    filePath: string | undefined
  ): { id: number } | null {
    // Direct ID lookup
    if (id !== undefined) {
      const def = db.getDefinitionById(id);
      if (!def) {
        this.error(chalk.red(`No definition found with ID ${id}`));
      }
      return { id };
    }

    // Name lookup
    if (!name) {
      this.error(chalk.red('Symbol name is required'));
    }

    let matches = db.getDefinitionsByName(name);

    if (matches.length === 0) {
      this.error(chalk.red(`No symbol found with name "${name}"`));
    }

    // Filter by file if specified
    if (filePath) {
      const resolvedPath = path.resolve(filePath);
      matches = matches.filter(m => m.filePath === resolvedPath || m.filePath.endsWith(filePath));

      if (matches.length === 0) {
        this.error(chalk.red(`No symbol "${name}" found in file "${filePath}"`));
      }
    }

    // Disambiguation needed
    if (matches.length > 1) {
      this.log(chalk.yellow(`Multiple symbols found with name "${name}":`));
      this.log('');
      for (const match of matches) {
        this.log(`  ${chalk.cyan('--id')} ${match.id}\t${match.kind}\t${match.filePath}:${match.line}`);
      }
      this.log('');
      this.log(chalk.gray('Use --id or --file to disambiguate'));
      return null;
    }

    return { id: matches[0].id };
  }
}
