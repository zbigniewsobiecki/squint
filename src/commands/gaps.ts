import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, outputJsonOrPlain, withDatabase } from './_shared/index.js';

type GapType = 'symbols' | 'relationships' | 'modules' | 'unassigned';

function sectionHeader(title: string): string {
  const line = '─'.repeat(Math.max(1, 48 - title.length - 4));
  return chalk.bold(`── ${title} ${line}`);
}

export default class Gaps extends Command {
  static override description = 'List unannotated symbols, relationships, empty modules, and unassigned symbols';

  static override examples = [
    '<%= config.bin %> gaps -d ./my-index.db',
    '<%= config.bin %> gaps --type symbols',
    '<%= config.bin %> gaps --type relationships --limit 50',
    '<%= config.bin %> gaps --kind function',
    '<%= config.bin %> gaps --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    type: Flags.string({
      char: 't',
      description: 'Gap type to show',
      options: ['symbols', 'relationships', 'modules', 'unassigned'],
    }),
    limit: Flags.integer({
      description: 'Max items per section',
      default: 20,
    }),
    kind: Flags.string({
      description: 'Filter symbols by kind (function, class, etc.)',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Gaps);
    const types: GapType[] = flags.type
      ? [flags.type as GapType]
      : ['symbols', 'relationships', 'modules', 'unassigned'];
    const limit = flags.limit;
    const kind = flags.kind;

    await withDatabase(flags.database, this, async (db) => {
      const totalSymbols = db.definitions.getCount();

      // ── Unannotated Symbols ──
      let unannotatedSymbols:
        | { items: Array<{ name: string; kind: string; filePath: string; line: number }>; shown: number; total: number }
        | undefined;

      if (types.includes('symbols')) {
        const total = db.metadata.getDefinitionsWithNoMetadataCount({ kind });
        const items = db.metadata.getDefinitionsWithNoMetadata({ kind, limit });
        unannotatedSymbols = { items, shown: items.length, total };
      }

      // ── Unannotated Relationships ──
      let unannotatedRelationships:
        | {
            items: Array<{
              fromName: string;
              toName: string;
              fromFilePath: string;
              fromLine: number;
            }>;
            shown: number;
            total: number;
          }
        | undefined;

      if (types.includes('relationships')) {
        const total = db.relationships.getUnannotatedCount();
        const items = db.relationships.getUnannotated({ limit });
        unannotatedRelationships = {
          items: items.map((r) => ({
            fromName: r.fromName,
            toName: r.toName,
            fromFilePath: r.fromFilePath,
            fromLine: r.fromLine,
          })),
          shown: items.length,
          total,
        };
      }

      // ── Empty Modules ──
      let emptyModules: { items: Array<{ fullPath: string; name: string }>; shown: number; total: number } | undefined;

      if (types.includes('modules')) {
        try {
          const allModules = db.modules.getAllWithMembers();
          const empty = allModules.filter((m) => m.members.length === 0);
          const shown = empty.slice(0, limit);
          emptyModules = {
            items: shown.map((m) => ({ fullPath: m.fullPath, name: m.name })),
            shown: shown.length,
            total: empty.length,
          };
        } catch {
          // modules table may not exist yet
          emptyModules = { items: [], shown: 0, total: 0 };
        }
      }

      // ── Unassigned Symbols ──
      let unassignedSymbols:
        | { items: Array<{ name: string; kind: string; filePath: string; line: number }>; shown: number; total: number }
        | undefined;

      if (types.includes('unassigned')) {
        try {
          const all = db.modules.getUnassigned();
          const filtered = kind ? all.filter((s) => s.kind === kind) : all;
          const shown = filtered.slice(0, limit);
          unassignedSymbols = {
            items: shown.map((s) => ({ name: s.name, kind: s.kind, filePath: s.filePath, line: s.line })),
            shown: shown.length,
            total: filtered.length,
          };
        } catch {
          // modules table may not exist yet
          unassignedSymbols = { items: [], shown: 0, total: 0 };
        }
      }

      // ── Output ──
      const jsonData: Record<string, unknown> = {};
      if (unannotatedSymbols) jsonData.unannotatedSymbols = unannotatedSymbols;
      if (unannotatedRelationships) jsonData.unannotatedRelationships = unannotatedRelationships;
      if (emptyModules) jsonData.emptyModules = emptyModules;
      if (unassignedSymbols) jsonData.unassignedSymbols = unassignedSymbols;

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        let printed = false;

        if (unannotatedSymbols) {
          const { items, total } = unannotatedSymbols;
          this.log(sectionHeader(`Unannotated Symbols (${total} / ${totalSymbols})`));
          for (const s of items) {
            this.log(`  ${s.name.padEnd(20)} ${s.kind.padEnd(12)} ${s.filePath}:${s.line}`);
          }
          const remaining = total - items.length;
          if (remaining > 0) {
            this.log(chalk.gray(`  (${remaining} more — use --limit to show all)`));
          }
          if (total === 0) {
            this.log(chalk.green('  All symbols annotated!'));
          }
          this.log('');
          printed = true;
        }

        if (unannotatedRelationships) {
          const { items, total } = unannotatedRelationships;
          this.log(sectionHeader(`Unannotated Relationships (${total})`));
          for (const r of items) {
            this.log(`${`  ${r.fromName} → ${r.toName}`.padEnd(40)}${r.fromFilePath}:${r.fromLine}`);
          }
          const remaining = total - items.length;
          if (remaining > 0) {
            this.log(chalk.gray(`  (${remaining} more)`));
          }
          if (total === 0) {
            this.log(chalk.green('  All relationships annotated!'));
          }
          this.log('');
          printed = true;
        }

        if (emptyModules) {
          const { items, total } = emptyModules;
          this.log(sectionHeader(`Empty Modules (${total})`));
          for (const m of items) {
            this.log(`  ${m.fullPath.padEnd(30)} ${m.name}`);
          }
          const remaining = total - items.length;
          if (remaining > 0) {
            this.log(chalk.gray(`  (${remaining} more)`));
          }
          if (total === 0) {
            this.log(chalk.green('  No empty modules!'));
          }
          this.log('');
          printed = true;
        }

        if (unassignedSymbols) {
          const { items, total } = unassignedSymbols;
          this.log(sectionHeader(`Unassigned Symbols (${total} / ${totalSymbols})`));
          for (const s of items) {
            this.log(`  ${s.name.padEnd(20)} ${s.kind.padEnd(12)} ${s.filePath}:${s.line}`);
          }
          const remaining = total - items.length;
          if (remaining > 0) {
            this.log(chalk.gray(`  (${remaining} more — use --limit to show all)`));
          }
          if (total === 0) {
            this.log(chalk.green('  All symbols assigned to modules!'));
          }
          this.log('');
          printed = true;
        }

        if (!printed) {
          this.log('No gap data to show.');
        }
      });
    });
  }
}
