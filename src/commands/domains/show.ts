import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, outputJsonOrPlain, withDatabase } from '../_shared/index.js';

export default class DomainsShow extends Command {
  static override description = 'Show domain details including symbols';

  static override examples = ['<%= config.bin %> domains show auth', '<%= config.bin %> domains show payment --json'];

  static override args = {
    name: Args.string({ description: 'Domain name', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(DomainsShow);

    await withDatabase(flags.database, this, async (db) => {
      const domain = db.domains.get(args.name);
      if (!domain) {
        this.error(chalk.red(`Domain "${args.name}" not found.`));
      }

      const symbols = db.domains.getSymbolsByDomain(args.name);

      // Module distribution: group symbols by module
      const moduleMap = new Map<string, { id: number; name: string; fullPath: string; count: number }>();
      for (const s of symbols) {
        const moduleResult = db.modules.getDefinitionModule(s.id);
        if (moduleResult) {
          const key = String(moduleResult.module.id);
          const existing = moduleMap.get(key);
          if (existing) {
            existing.count++;
          } else {
            moduleMap.set(key, {
              id: moduleResult.module.id,
              name: moduleResult.module.name,
              fullPath: moduleResult.module.fullPath,
              count: 1,
            });
          }
        }
      }
      const moduleDistribution = Array.from(moduleMap.values()).sort((a, b) => b.count - a.count);

      // Intra-domain relationships: for each symbol (limit 100), get outgoing relationships
      // and filter to those where the target is also in this domain
      const domainSymbolIds = new Set(symbols.map((s) => s.id));
      const intraDomainRelationships: Array<{
        fromName: string;
        toName: string;
        relationshipType: string;
        semantic: string;
      }> = [];
      const symbolsToCheck = symbols.slice(0, 100);
      for (const s of symbolsToCheck) {
        const rels = db.relationships.getFrom(s.id);
        for (const r of rels) {
          if (domainSymbolIds.has(r.toDefinitionId)) {
            intraDomainRelationships.push({
              fromName: r.fromName,
              toName: r.toName,
              relationshipType: r.relationshipType,
              semantic: r.semantic,
            });
          }
        }
      }

      const jsonData = {
        domain,
        symbols,
        moduleDistribution,
        intraDomainRelationships,
      };

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        this.log(chalk.bold(`Domain: ${chalk.cyan(domain.name)}`));
        if (domain.description) {
          this.log(`Description: ${domain.description}`);
        }
        this.log(`Created: ${domain.createdAt}`);

        this.log('');
        this.log(chalk.bold(`Symbols (${symbols.length})`));
        if (symbols.length === 0) {
          this.log(chalk.gray('  No symbols tagged with this domain.'));
        } else {
          for (const s of symbols) {
            const purpose = s.purpose ? chalk.gray(` - ${s.purpose}`) : '';
            this.log(
              `  ${chalk.cyan(s.name)} ${chalk.yellow(s.kind)} ${chalk.gray(`${s.filePath}:${s.line}`)}${purpose}`
            );
          }
        }

        if (moduleDistribution.length > 0) {
          this.log('');
          this.log(chalk.bold(`Module Distribution (${moduleDistribution.length})`));
          for (const m of moduleDistribution) {
            this.log(`  ${chalk.cyan(m.name)} ${chalk.gray(`(${m.fullPath})`)} - ${m.count} symbols`);
          }
        }

        if (intraDomainRelationships.length > 0) {
          this.log('');
          this.log(chalk.bold(`Intra-Domain Relationships (${intraDomainRelationships.length})`));
          for (const r of intraDomainRelationships) {
            const semantic = r.semantic ? ` "${r.semantic}"` : '';
            this.log(
              `  ${chalk.cyan(r.fromName)} -> ${chalk.cyan(r.toName)} [${r.relationshipType}]${chalk.gray(semantic)}`
            );
          }
        }
      });
    });
  }
}
