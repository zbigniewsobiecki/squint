import path from 'node:path';
import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

export default class SymbolsList extends Command {
  static override description = 'List all symbols in the index';

  static override examples = [
    '<%= config.bin %> symbols',
    '<%= config.bin %> symbols --kind function',
    '<%= config.bin %> symbols --kind class',
    '<%= config.bin %> symbols --file src/index.ts',
    '<%= config.bin %> symbols -d ./my-index.db',
    '<%= config.bin %> symbols --has purpose',
    '<%= config.bin %> symbols --missing purpose --kind function',
    '<%= config.bin %> symbols --domain auth',
    '<%= config.bin %> symbols --pure false',
    '<%= config.bin %> symbols --domains',
    '<%= config.bin %> symbols --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    kind: Flags.string({
      description: 'Filter by kind (function, class, variable, type, interface, enum)',
    }),
    file: Flags.string({
      description: 'Filter to symbols in a specific file',
    }),
    has: Flags.string({
      description: 'Filter to symbols with this metadata key',
    }),
    missing: Flags.string({
      description: 'Filter to symbols missing this metadata key',
    }),
    domain: Flags.string({
      description: 'Filter to symbols with this domain tag',
    }),
    pure: Flags.string({
      description: 'Filter by purity (true for pure functions, false for side-effecting)',
    }),
    domains: Flags.boolean({
      description: 'List all unique domains used in the codebase',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(SymbolsList);

    await withDatabase(flags.database, this, async (db) => {
      // Handle --domains flag: list all unique domains
      if (flags.domains) {
        const domains = db.metadata.getAllDomains();
        if (flags.json) {
          this.log(
            JSON.stringify(
              {
                domains: domains.map((d) => ({
                  name: d,
                  symbolCount: db.domains.getSymbolsByDomain(d).length,
                })),
              },
              null,
              2
            )
          );
          return;
        }

        if (domains.length === 0) {
          this.log(
            chalk.gray(
              'No domains found. Use `squint symbols set domain \'["tag1", "tag2"]\' --name SymbolName` to add domains.'
            )
          );
        } else {
          this.log('Domains in use:');
          for (const domain of domains) {
            const count = db.domains.getSymbolsByDomain(domain).length;
            this.log(`  ${chalk.cyan(domain)} (${count} symbol${count !== 1 ? 's' : ''})`);
          }
        }
        return;
      }

      // Handle --domain filter: show symbols with a specific domain
      if (flags.domain) {
        const symbols = db.domains.getSymbolsByDomain(flags.domain);
        if (flags.json) {
          this.log(
            JSON.stringify(
              {
                symbols: symbols.map((s) => ({
                  name: s.name,
                  kind: s.kind,
                  domains: s.domains,
                  purpose: s.purpose ?? null,
                })),
                count: symbols.length,
                domain: flags.domain,
              },
              null,
              2
            )
          );
          return;
        }

        if (symbols.length === 0) {
          this.log(chalk.gray(`No symbols found with domain "${flags.domain}".`));
        } else {
          for (const sym of symbols) {
            const domainsStr = sym.domains.join(', ');
            const purposeStr = sym.purpose ? ` - ${sym.purpose}` : '';
            this.log(`${sym.name}\t${sym.kind}\t[${domainsStr}]${purposeStr}`);
          }
          this.log('');
          this.log(chalk.gray(`Found ${symbols.length} symbol(s) with domain "${flags.domain}"`));
        }
        return;
      }

      // Handle --pure filter: show pure or impure symbols
      if (flags.pure !== undefined) {
        const isPure = flags.pure === 'true';
        if (flags.pure !== 'true' && flags.pure !== 'false') {
          this.error(chalk.red('--pure must be "true" or "false"'));
        }
        const symbols = db.domains.getSymbolsByPurity(isPure);
        if (flags.json) {
          this.log(
            JSON.stringify(
              {
                symbols: symbols.map((s) => ({
                  name: s.name,
                  kind: s.kind,
                  filePath: s.filePath,
                  line: s.line,
                  purpose: s.purpose ?? null,
                })),
                count: symbols.length,
                pure: isPure,
              },
              null,
              2
            )
          );
          return;
        }

        if (symbols.length === 0) {
          this.log(chalk.gray(`No symbols found with pure=${flags.pure}.`));
        } else {
          for (const sym of symbols) {
            const purposeStr = sym.purpose ? ` - ${sym.purpose}` : '';
            this.log(`${sym.name}\t${sym.kind}\t${sym.filePath}:${sym.line}${purposeStr}`);
          }
          this.log('');
          const label = isPure ? 'pure' : 'side-effecting';
          this.log(chalk.gray(`Found ${symbols.length} ${label} symbol(s)`));
        }
        return;
      }

      // Default: list all symbols with optional filters
      // Resolve file path if provided
      let fileId: number | null = null;
      if (flags.file) {
        const filePath = path.resolve(flags.file);
        fileId = db.files.getIdByPath(db.toRelativePath(filePath)) ?? db.files.getIdByPath(filePath);
        if (fileId === null) {
          this.error(chalk.red(`File "${filePath}" not found in the index.`));
        }
      }

      let symbols = db.definitions.getSymbols({
        kind: flags.kind,
        fileId: fileId ?? undefined,
      });

      // Apply metadata filters
      if (flags.has) {
        const idsWithKey = new Set(db.metadata.getDefinitionsWith(flags.has));
        symbols = symbols.filter((sym) => idsWithKey.has(sym.id));
      }
      if (flags.missing) {
        const idsWithoutKey = new Set(db.metadata.getDefinitionsWithout(flags.missing));
        symbols = symbols.filter((sym) => idsWithoutKey.has(sym.id));
      }

      if (flags.json) {
        this.log(
          JSON.stringify(
            {
              symbols: symbols.map((s) => ({
                id: s.id,
                name: s.name,
                kind: s.kind,
                filePath: s.filePath,
                line: s.line,
              })),
              count: symbols.length,
            },
            null,
            2
          )
        );
        return;
      }

      if (symbols.length === 0) {
        this.log(chalk.gray('No symbols found.'));
      } else {
        for (const sym of symbols) {
          this.log(`${sym.name}\t${sym.kind}\t${sym.filePath}:${sym.line}`);
        }
        this.log('');
        this.log(chalk.gray(`Found ${symbols.length} symbol(s)`));
      }
    });
  }
}
