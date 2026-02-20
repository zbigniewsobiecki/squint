import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, outputJsonOrPlain, withDatabase } from '../_shared/index.js';

const ROLE_COMPLEMENTS: Record<string, string> = {
  server: 'client',
  client: 'server',
  producer: 'consumer',
  consumer: 'producer',
  emitter: 'listener',
  listener: 'emitter',
  publisher: 'subscriber',
  subscriber: 'publisher',
  sender: 'receiver',
  receiver: 'sender',
  writer: 'reader',
  reader: 'writer',
};

function isMatched(roles: Set<string>): boolean {
  for (const role of roles) {
    const complement = ROLE_COMPLEMENTS[role];
    if (complement && roles.has(complement)) return true;
  }
  return false;
}

export default class ContractsList extends Command {
  static override description = 'List all contracts with match status';

  static override examples = [
    '<%= config.bin %> contracts',
    '<%= config.bin %> contracts --matched',
    '<%= config.bin %> contracts --unmatched',
    '<%= config.bin %> contracts --protocol http',
    '<%= config.bin %> contracts --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    protocol: Flags.string({
      description: 'Filter by protocol (http, ws, queue, etc.)',
    }),
    matched: Flags.boolean({
      description: 'Show only matched contracts (complementary role pairs)',
      default: false,
    }),
    unmatched: Flags.boolean({
      description: 'Show only unmatched (one-sided) contracts',
      default: false,
    }),
    module: Flags.string({
      description: 'Filter by module path (contracts involving this module)',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(ContractsList);

    await withDatabase(flags.database, this, async (db) => {
      let contracts = db.contracts.getAllWithParticipants();

      // Apply filters
      if (flags.protocol) {
        contracts = contracts.filter((c) => c.protocol === flags.protocol);
      }

      if (flags.module) {
        const moduleFilter = flags.module.toLowerCase();
        // Get module IDs matching the filter
        const modules = db.modules.getAll();
        const matchingModuleIds = new Set(
          modules.filter((m) => m.fullPath.toLowerCase().includes(moduleFilter)).map((m) => m.id)
        );
        contracts = contracts.filter((c) =>
          c.participants.some((p) => p.moduleId !== null && matchingModuleIds.has(p.moduleId))
        );
      }

      if (flags.matched) {
        contracts = contracts.filter((c) => {
          const roles = new Set(c.participants.map((p) => p.role));
          return isMatched(roles);
        });
      }

      if (flags.unmatched) {
        contracts = contracts.filter((c) => {
          const roles = new Set(c.participants.map((p) => p.role));
          return !isMatched(roles);
        });
      }

      // Compute stats
      let matchedCount = 0;
      let unmatchedCount = 0;
      const byProtocol: Record<string, number> = {};

      for (const c of contracts) {
        const roles = new Set(c.participants.map((p) => p.role));
        if (isMatched(roles)) {
          matchedCount++;
        } else {
          unmatchedCount++;
        }
        byProtocol[c.protocol] = (byProtocol[c.protocol] ?? 0) + 1;
      }

      const jsonData = {
        contracts: contracts.map((c) => {
          const roles = new Set(c.participants.map((p) => p.role));
          return {
            id: c.id,
            protocol: c.protocol,
            key: c.key,
            normalizedKey: c.normalizedKey,
            description: c.description,
            participants: c.participants.map((p) => ({
              id: p.id,
              definitionId: p.definitionId,
              moduleId: p.moduleId,
              role: p.role,
            })),
            matched: isMatched(roles),
            roles: [...roles],
          };
        }),
        stats: {
          total: contracts.length,
          matched: matchedCount,
          unmatched: unmatchedCount,
          byProtocol,
        },
      };

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        if (contracts.length === 0) {
          this.log(chalk.gray('No contracts found. Run `squint contracts extract` first.'));
          return;
        }

        this.log(
          `Contracts: ${chalk.cyan(String(contracts.length))} (${chalk.green(String(matchedCount))} matched, ${chalk.yellow(String(unmatchedCount))} unmatched)`
        );
        this.log('');

        // Group by protocol
        const grouped = new Map<string, typeof contracts>();
        for (const c of contracts) {
          const list = grouped.get(c.protocol) ?? [];
          list.push(c);
          grouped.set(c.protocol, list);
        }

        for (const [protocol, group] of grouped) {
          this.log(`  ${chalk.bold(protocol)} (${group.length} contracts)`);

          for (const c of group) {
            const roles = new Set(c.participants.map((p) => p.role));
            const matched = isMatched(roles);
            const icon = matched ? chalk.green('\u2713') : chalk.yellow('\u2717');
            const rolesStr = [...roles].join(' \u2194 ');
            const roleSuffix = matched ? rolesStr : `${rolesStr} only`;
            this.log(`    ${icon} ${c.normalizedKey.padEnd(30)} ${chalk.gray(roleSuffix)}`);
          }

          this.log('');
        }
      });
    });
  }
}
