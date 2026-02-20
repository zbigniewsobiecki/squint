import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, outputJsonOrPlain, withDatabase } from '../_shared/index.js';

export default class ContractsShow extends Command {
  static override description = 'Show details for a specific contract';

  static override examples = [
    '<%= config.bin %> contracts show 25',
    '<%= config.bin %> contracts show http:"GET /vehicles"',
    '<%= config.bin %> contracts show 25 --json',
  ];

  static override args = {
    identifier: Args.string({
      description: 'Contract ID or protocol:key (e.g., http:"GET /vehicles")',
      required: true,
    }),
  };

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ContractsShow);

    await withDatabase(flags.database, this, async (db) => {
      let contract: Awaited<ReturnType<typeof db.contracts.getWithParticipants>> = null;

      // Try as numeric ID first
      const numericId = Number.parseInt(args.identifier, 10);
      if (!Number.isNaN(numericId) && String(numericId) === args.identifier) {
        contract = db.contracts.getWithParticipants(numericId);
      } else {
        // Parse as protocol:key
        const colonIdx = args.identifier.indexOf(':');
        if (colonIdx === -1) {
          this.error(chalk.red(`Invalid identifier "${args.identifier}". Use a numeric ID or protocol:key.`));
        }
        const protocol = args.identifier.slice(0, colonIdx);
        const key = args.identifier.slice(colonIdx + 1);
        const found = db.contracts.findByProtocolAndKey(protocol, key);
        if (found) {
          contract = db.contracts.getWithParticipants(found.id);
        }
      }

      if (!contract) {
        this.error(chalk.red(`Contract "${args.identifier}" not found.`));
      }

      // Get detailed participants
      const participants = db.contracts.getParticipantsWithDetails(contract.id);

      // Find matching interaction
      const conn = db.getConnection();
      const interaction = conn
        .prepare(
          `SELECT i.id, i.weight, m1.full_path as fromPath, m2.full_path as toPath
           FROM interactions i
           JOIN modules m1 ON i.from_module_id = m1.id
           JOIN modules m2 ON i.to_module_id = m2.id
           WHERE i.source = 'contract-matched'
           AND EXISTS (
             SELECT 1 FROM interaction_definition_links idl
             WHERE idl.interaction_id = i.id AND idl.contract_id = ?
           )`
        )
        .get(contract.id) as { id: number; weight: number; fromPath: string; toPath: string } | undefined;

      const jsonData = {
        contract: {
          id: contract.id,
          protocol: contract.protocol,
          key: contract.key,
          normalizedKey: contract.normalizedKey,
          description: contract.description,
        },
        participants: participants.map((p) => ({
          id: p.id,
          definitionId: p.definitionId,
          definitionName: p.definitionName,
          moduleId: p.moduleId,
          modulePath: p.modulePath,
          role: p.role,
          filePath: p.filePath,
          line: p.line,
        })),
        interaction: interaction
          ? { id: interaction.id, weight: interaction.weight, from: interaction.fromPath, to: interaction.toPath }
          : null,
      };

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        this.log(chalk.bold(`Contract #${contract.id}: ${contract.key} (${contract.protocol})`));
        this.log(`  Normalized Key: ${contract.normalizedKey}`);
        if (contract.description) {
          this.log(`  Description: ${contract.description}`);
        }
        this.log('');

        this.log(chalk.bold('  Participants:'));
        for (const p of participants) {
          this.log(`    ${chalk.cyan(p.role)}: ${p.definitionName} (#${p.definitionId})`);
          if (p.modulePath) {
            this.log(`      Module: ${p.modulePath}`);
          }
          this.log(`      File: ${chalk.gray(`${p.filePath}:${p.line}`)}`);
        }

        if (interaction) {
          this.log('');
          this.log(
            `${chalk.bold('  Interaction:')} #${interaction.id} (${interaction.fromPath} \u2192 ${interaction.toPath}, weight ${interaction.weight})`
          );
        }
      });
    });
  }
}
