import fs from 'node:fs/promises';
import path from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../db/database.js';
import { SharedFlags, SymbolResolver, openDatabase, withDatabase } from '../_shared/index.js';

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

// biome-ignore lint/suspicious/noShadowRestrictedNames: Command class must match CLI command name
export default class Set extends Command {
  static override description = 'Set metadata on a symbol';

  static override examples = [
    '<%= config.bin %> symbols set purpose "Parse TS files" --name parseFile',
    '<%= config.bin %> symbols set purpose "Main entry point" --id 42',
    '<%= config.bin %> symbols set domain \'["auth", "user"]\' --name loginUser',
    '<%= config.bin %> symbols set role "controller that handles HTTP requests" --name UserController',
    '<%= config.bin %> symbols set pure true --name calculateTotal',
    '<%= config.bin %> symbols set pure false --name saveToDatabase',
    'echo \'[{"name":"foo","value":"desc1"}]\' | <%= config.bin %> symbols set purpose --batch',
  ];

  static override args = {
    key: Args.string({ description: 'Metadata key', required: true }),
    value: Args.string({ description: 'Metadata value (required unless --batch)' }),
  };

  static override flags = {
    database: SharedFlags.database,
    name: SharedFlags.symbolName,
    file: SharedFlags.symbolFile,
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
    json: SharedFlags.json,
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

    await withDatabase(flags.database, this, async (db) => {
      const resolver = new SymbolResolver(db, this);
      const definition = resolver.resolve(flags.name, flags.id, flags.file);

      if (!definition) {
        return; // Disambiguation message already shown
      }

      // Set the metadata
      db.setDefinitionMetadata(definition.id, args.key, args.value!);

      // Get the definition name for output
      const defDetails = db.getDefinitionById(definition.id);
      const displayName = defDetails?.name ?? `ID ${definition.id}`;

      this.log(`Set ${chalk.cyan(args.key)}="${args.value}" on ${chalk.yellow(displayName)}`);

      // Warn about unregistered domains
      if (args.key === 'domain') {
        this.warnUnregisteredDomains(db, args.value!);
      }
    });
  }

  private async runBatchMode(
    key: string,
    flags: { database: string; json: boolean; 'input-file'?: string; batch?: boolean }
  ): Promise<void> {
    const dbPath = path.resolve(flags.database);

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

    const db = await openDatabase(dbPath, this);
    const results: BatchResult[] = [];
    const resolver = new SymbolResolver(db, this);

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
          const definition = resolver.resolveSilent(entry.name, entry.id, entry.file);

          if (!definition) {
            results.push({ symbol: symbolId, success: false, error: 'Symbol not found or ambiguous' });
            continue;
          }

          // Set the metadata
          db.setDefinitionMetadata(definition.id, key, entry.value);

          results.push({ symbol: definition.name, success: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.push({ symbol: symbolId, success: false, error: message });
        }
      }
    } finally {
      db.close();
    }

    // Warn about unregistered domains in batch mode
    if (key === 'domain' && !flags.json) {
      let db2: IndexDatabase | null = null;
      try {
        db2 = await openDatabase(dbPath, this);
        // Collect all domains from successful entries
        const allDomainsSet: globalThis.Set<string> = new globalThis.Set();
        for (const entry of entries) {
          try {
            const domains = JSON.parse(entry.value) as string[];
            if (Array.isArray(domains)) {
              for (const d of domains) {
                if (typeof d === 'string') allDomainsSet.add(d);
              }
            }
          } catch {
            /* skip */
          }
        }
        const unregistered = Array.from(allDomainsSet).filter((d: string) => !db2!.isDomainRegistered(d));
        if (unregistered.length > 0) {
          this.log('');
          this.log(chalk.yellow(`Warning: ${unregistered.length} unregistered domain(s): ${unregistered.join(', ')}`));
          this.log(chalk.gray('Register with: squint domains sync'));
        }
      } catch {
        /* skip warnings if db fails */
      } finally {
        db2?.close();
      }
    }

    // Output results
    if (flags.json) {
      this.log(JSON.stringify({ key, results }, null, 2));
    } else {
      const successCount = results.filter((r) => r.success).length;
      const failCount = results.filter((r) => !r.success).length;

      this.log(
        `Set ${chalk.cyan(key)} on ${chalk.green(successCount)} symbols${failCount > 0 ? `, ${chalk.red(failCount)} failed` : ''}:`
      );

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
      throw new Error("No input piped to stdin. Use: echo '[...]' | squint symbols set ... --batch");
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

  /**
   * Warn about unregistered domains in a domain value.
   * The value should be a JSON array of domain names.
   */
  private warnUnregisteredDomains(db: IndexDatabase, value: string): void {
    try {
      const domains = JSON.parse(value) as string[];
      if (!Array.isArray(domains)) return;

      const unregistered: string[] = [];
      for (const domain of domains) {
        if (typeof domain === 'string' && !db.isDomainRegistered(domain)) {
          unregistered.push(domain);
        }
      }

      if (unregistered.length > 0) {
        this.log('');
        this.log(chalk.yellow(`Warning: ${unregistered.length} unregistered domain(s): ${unregistered.join(', ')}`));
        this.log(chalk.gray(`Register with: squint domains add <name> "<description>"`));
        this.log(chalk.gray('Or sync all: squint domains sync'));
      }
    } catch {
      // Value is not valid JSON, skip warning
    }
  }
}
