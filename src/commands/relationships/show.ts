import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, formatModuleRef, outputJsonOrPlain, withDatabase } from '../_shared/index.js';

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

      // Get metadata for both symbols
      const fromMetadata = db.metadata.get(flags.from);
      const toMetadata = db.metadata.get(flags.to);

      // Get module context for both
      const fromModuleResult = db.modules.getDefinitionModule(flags.from);
      const toModuleResult = db.modules.getDefinitionModule(flags.to);

      // Get interaction between modules if they differ
      let interaction = null;
      let flows: Array<{ id: number; name: string; slug: string }> = [];
      if (fromModuleResult && toModuleResult && fromModuleResult.module.id !== toModuleResult.module.id) {
        const interactionResult = db.interactions.getByModules(fromModuleResult.module.id, toModuleResult.module.id);
        if (interactionResult) {
          interaction = interactionResult;
          flows = db.flows.getFlowsWithInteraction(interactionResult.id).map((f) => ({
            id: f.id,
            name: f.name,
            slug: f.slug,
          }));
        }
      }

      const jsonData = {
        relationship,
        from: fromDef,
        to: toDef,
        fromMetadata,
        toMetadata,
        fromModule: formatModuleRef(fromModuleResult),
        toModule: formatModuleRef(toModuleResult),
        interaction,
        flows,
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
          if (fromModuleResult) {
            this.log(
              `  Module: ${chalk.cyan(fromModuleResult.module.name)} ${chalk.gray(`(${fromModuleResult.module.fullPath})`)}`
            );
          }
          const fromPurpose = fromMetadata.purpose;
          const fromDomain = fromMetadata.domain;
          const fromRole = fromMetadata.role;
          if (fromPurpose) this.log(`  Purpose: ${fromPurpose}`);
          if (fromDomain) this.log(`  Domain: ${fromDomain}`);
          if (fromRole) this.log(`  Role: ${fromRole}`);
        } else {
          this.log(`From: definition ${flags.from}`);
        }

        this.log('');
        if (toDef) {
          this.log(`To: ${chalk.cyan(toDef.name)} (${toDef.kind}) ${chalk.gray(`${toDef.filePath}:${toDef.line}`)}`);
          if (toModuleResult) {
            this.log(
              `  Module: ${chalk.cyan(toModuleResult.module.name)} ${chalk.gray(`(${toModuleResult.module.fullPath})`)}`
            );
          }
          const toPurpose = toMetadata.purpose;
          const toDomain = toMetadata.domain;
          const toRole = toMetadata.role;
          if (toPurpose) this.log(`  Purpose: ${toPurpose}`);
          if (toDomain) this.log(`  Domain: ${toDomain}`);
          if (toRole) this.log(`  Role: ${toRole}`);
        } else {
          this.log(`To: definition ${flags.to}`);
        }

        if (interaction) {
          this.log('');
          this.log(chalk.bold('Module Interaction'));
          this.log(`  Pattern: ${interaction.pattern ?? 'unclassified'}`);
          this.log(`  Weight: ${interaction.weight} calls`);
          if (interaction.semantic) {
            this.log(`  Semantic: "${interaction.semantic}"`);
          }
        }

        if (flows.length > 0) {
          this.log('');
          this.log(chalk.bold(`Flows (${flows.length})`));
          for (const f of flows) {
            this.log(`  ${chalk.cyan(f.name)} (${f.slug})`);
          }
        }
      });
    });
  }
}
