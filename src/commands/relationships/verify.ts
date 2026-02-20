import { Flags } from '@oclif/core';
import chalk from 'chalk';

import type { IndexDatabase } from '../../db/database.js';
import { LlmFlags, SharedFlags, readSourceAsString } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import { parseCombinedCsv } from '../llm/_shared/csv.js';
import { completeWithLogging } from '../llm/_shared/llm-utils.js';
import {
  type RelationshipSourceGroup,
  type RelationshipTarget,
  buildRelationshipSystemPrompt,
  buildRelationshipUserPrompt,
} from '../llm/_shared/prompts.js';
import { verifyRelationshipContent } from '../llm/_shared/verify/content-verifier.js';
import { checkReferentialIntegrity } from '../llm/_shared/verify/integrity-checker.js';
import { checkRelationshipCoverage } from '../llm/_shared/verify/relationship-checker.js';
import type { VerificationIssue, VerifyReport } from '../llm/_shared/verify/verify-types.js';

export default class RelationshipsVerify extends BaseLlmCommand {
  static override description = 'Verify existing relationship annotations';

  static override examples = [
    '<%= config.bin %> relationships verify',
    '<%= config.bin %> relationships verify --fix',
    '<%= config.bin %> relationships verify --dry-run',
    '<%= config.bin %> relationships verify --batch-size 10',
    '<%= config.bin %> relationships verify --max-iterations 5',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    ...LlmFlags,
    fix: Flags.boolean({
      description: 'Auto-fix structural issues found during verification (e.g., stale files)',
      default: false,
    }),
    'batch-size': Flags.integer({
      char: 'b',
      description: 'Number of source symbols per LLM call',
      default: 80,
    }),
    'max-iterations': Flags.integer({
      description: 'Maximum iterations (0 = unlimited)',
      default: 0,
    }),
  };

  protected async execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, dryRun } = ctx;
    const batchSize = (flags['batch-size'] as number) || 10;
    const maxIterations = (flags['max-iterations'] as number) || 0;
    const shouldFix = flags.fix as boolean;

    if (!isJson) {
      this.log(chalk.bold('Relationship Verification'));
      this.log('');
    }

    // Referential integrity preamble
    const ghostResult = checkReferentialIntegrity(db);

    // Phase 1: Coverage + structural checks
    if (!isJson) {
      this.log(chalk.bold('Phase 1: Coverage & Structural Check'));
    }

    const phase1 = checkRelationshipCoverage(db);

    // Merge ghost issues into phase1
    phase1.issues.unshift(...ghostResult.issues);
    phase1.stats.structuralIssueCount += ghostResult.stats.structuralIssueCount;
    if (!ghostResult.passed) phase1.passed = false;

    const report: VerifyReport = { phase1 };

    if (!isJson) {
      this.log(`  Relationships: ${phase1.stats.annotatedRelationships}/${phase1.stats.totalRelationships} annotated`);

      // Show structural issues
      const errorIssues = phase1.issues.filter((i) => i.severity === 'error');
      const warningIssues = phase1.issues.filter((i) => i.severity === 'warning');

      if (errorIssues.length > 0) {
        this.log('');
        this.log(chalk.red(`  Errors (${errorIssues.length}):`));
        for (const issue of errorIssues.slice(0, 20)) {
          this.log(`    ${chalk.red('ERR')} [${issue.category}] ${issue.message}`);
          if (issue.suggestion) {
            this.log(`      ${chalk.gray(issue.suggestion)}`);
          }
        }
        if (errorIssues.length > 20) {
          this.log(chalk.gray(`    ... and ${errorIssues.length - 20} more`));
        }
      }

      if (warningIssues.length > 0) {
        this.log('');
        this.log(chalk.yellow(`  Warnings (${warningIssues.length}):`));
        for (const issue of warningIssues.slice(0, 20)) {
          this.log(`    ${chalk.yellow('WARN')} [${issue.category}] ${issue.message}`);
        }
        if (warningIssues.length > 20) {
          this.log(chalk.gray(`    ... and ${warningIssues.length - 20} more`));
        }
      }

      if (phase1.passed) {
        this.log(chalk.green('  ✓ All structural checks passed'));
      } else {
        this.log(chalk.red(`  ✗ ${phase1.stats.structuralIssueCount} structural issues found`));
      }
      this.log('');
    }

    // Auto-fix: ghost rows
    if (shouldFix && !dryRun) {
      const ghostIssues = phase1.issues.filter((i) => i.fixData?.action === 'remove-ghost');
      if (ghostIssues.length > 0) {
        let ghostFixed = 0;
        for (const issue of ghostIssues) {
          if (issue.fixData?.ghostTable && issue.fixData?.ghostRowId) {
            const deleted = db.deleteGhostRow(issue.fixData.ghostTable, issue.fixData.ghostRowId);
            if (deleted) ghostFixed++;
          }
        }
        if (ghostFixed > 0 && !isJson) {
          this.log(chalk.green(`  Fixed: removed ${ghostFixed} ghost rows`));
          this.log('');
        }
      }
    }

    // Auto-fix: clean stale files if --fix
    if (shouldFix && !dryRun) {
      const staleIssues = phase1.issues.filter((i) => i.category === 'stale-file');
      if (staleIssues.length > 0) {
        const result = db.cleanStaleFiles();
        if (!isJson) {
          this.log(chalk.green(`  Fixed: removed ${result.removed} stale file entries`));
          this.log('');
        }
      }

      const typeMismatchIssues = phase1.issues.filter((i) => i.fixData?.action === 'change-relationship-type');
      if (typeMismatchIssues.length > 0) {
        let fixed = 0;
        for (const issue of typeMismatchIssues) {
          if (issue.definitionId && issue.fixData?.targetDefinitionId && issue.fixData?.expectedType) {
            db.relationships.updateType(
              issue.definitionId,
              issue.fixData.targetDefinitionId,
              issue.fixData.expectedType as 'extends' | 'implements'
            );
            fixed++;
          }
        }
        if (!isJson) {
          this.log(chalk.green(`  Fixed: corrected ${fixed} relationship types`));
          this.log('');
        }
      }
    }

    // If dry-run, stop here
    if (dryRun) {
      if (isJson) {
        this.log(JSON.stringify(report, null, 2));
      } else {
        this.log(chalk.yellow('Dry run — skipping Phase 2 (LLM content verification)'));
      }
      return;
    }

    // Phase 2: LLM content verification
    if (!isJson) {
      this.log(chalk.bold('Phase 2: Content Verification (LLM)'));
    }

    const phase2 = await verifyRelationshipContent(db, ctx, this, {
      'batch-size': batchSize,
      'max-iterations': maxIterations,
    });
    report.phase2 = phase2;

    if (!isJson) {
      this.log(`  Checked: ${phase2.stats.checked} relationships in ${phase2.stats.batchesProcessed} batches`);

      if (phase2.issues.length === 0) {
        this.log(chalk.green('  ✓ All relationships passed content verification'));
      } else {
        this.log(chalk.yellow(`  Found ${phase2.issues.length} issues:`));
        for (const issue of phase2.issues) {
          const severity = issue.severity === 'error' ? chalk.red('ERR') : chalk.yellow('WARN');
          this.log(`  ${severity} ${issue.message}`);
        }
      }
    }

    // LLM-based fixes (PENDING, missing, wrong relationships)
    if (shouldFix && !dryRun && ctx.model) {
      const llmFixIssues: VerificationIssue[] = [];

      // Collect from Phase 1: pending-annotation and missing-relationship
      llmFixIssues.push(
        ...phase1.issues.filter(
          (i) =>
            i.fixData?.action === 'reannotate-relationship' || i.fixData?.action === 'annotate-missing-relationship'
        )
      );

      // Collect from Phase 2: wrong relationships
      if (phase2) {
        llmFixIssues.push(...phase2.issues.filter((i) => i.fixData?.action === 'reannotate-relationship'));
      }

      if (llmFixIssues.length > 0) {
        if (!isJson) {
          this.log('');
          this.log(chalk.bold(`Fixing ${llmFixIssues.length} relationship issues via LLM...`));
        }

        // Group by fromId (definitionId)
        const byFromId = new Map<number, typeof llmFixIssues>();
        for (const issue of llmFixIssues) {
          if (!issue.definitionId) continue;
          if (!byFromId.has(issue.definitionId)) byFromId.set(issue.definitionId, []);
          byFromId.get(issue.definitionId)!.push(issue);
        }

        const fromIds = [...byFromId.keys()];
        let fixedCount = 0;

        for (let offset = 0; offset < fromIds.length; offset += batchSize) {
          const batchFromIds = fromIds.slice(offset, offset + batchSize);

          // Build source groups for these definitions
          const fixGrouped = new Map<
            number,
            Array<{
              fromDefinitionId: number;
              fromName: string;
              fromKind: string;
              fromFilePath: string;
              fromLine: number;
              toDefinitionId: number;
              toName: string;
              toKind: string;
              toFilePath: string;
              toLine: number;
            }>
          >();

          for (const fromId of batchFromIds) {
            const issues = byFromId.get(fromId) || [];
            const rels: Array<{
              fromDefinitionId: number;
              fromName: string;
              fromKind: string;
              fromFilePath: string;
              fromLine: number;
              toDefinitionId: number;
              toName: string;
              toKind: string;
              toFilePath: string;
              toLine: number;
            }> = [];

            const fromDef = db.definitions.getById(fromId);
            if (!fromDef) continue;

            for (const issue of issues) {
              const toId = issue.fixData?.targetDefinitionId;
              if (!toId) continue;
              const toDef = db.definitions.getById(toId);
              if (!toDef) continue;

              rels.push({
                fromDefinitionId: fromId,
                fromName: fromDef.name,
                fromKind: fromDef.kind,
                fromFilePath: fromDef.filePath,
                fromLine: fromDef.line,
                toDefinitionId: toId,
                toName: toDef.name,
                toKind: toDef.kind,
                toFilePath: toDef.filePath,
                toLine: toDef.line,
              });
            }

            if (rels.length > 0) {
              fixGrouped.set(fromId, rels);
            }
          }

          const fixGroups = await this.buildSourceGroups(db, [...fixGrouped.keys()], fixGrouped);
          if (fixGroups.length === 0) continue;

          const systemPrompt = buildRelationshipSystemPrompt();
          const userPrompt = buildRelationshipUserPrompt(fixGroups);

          try {
            const response = await completeWithLogging({
              model: ctx.model,
              systemPrompt,
              userPrompt,
              temperature: 0,
              command: this,
              isJson,
            });

            const parseResult = parseCombinedCsv(response);

            const validRels = new Map<number, Set<number>>();
            for (const group of fixGroups) {
              validRels.set(group.id, new Set(group.relationships.map((r) => r.toId)));
            }

            for (const row of parseResult.relationships) {
              const toIds = validRels.get(row.fromId);
              if (!toIds || !toIds.has(row.toId)) continue;
              if (!row.value || row.value.length < 5) continue;
              db.relationships.set(row.fromId, row.toId, row.value);
              fixedCount++;
            }
          } catch {
            // LLM error, continue
          }
        }

        if (fixedCount > 0 && !isJson) {
          this.log(chalk.green(`  Fixed: re-annotated ${fixedCount} relationships via LLM`));
        }
      }
    }

    if (isJson) {
      this.log(JSON.stringify(report, null, 2));
    }
  }

  /**
   * Build RelationshipSourceGroup[] for a batch of source symbol IDs.
   */
  private async buildSourceGroups(
    db: IndexDatabase,
    sourceIds: number[],
    grouped: Map<
      number,
      Array<{
        fromDefinitionId: number;
        fromName: string;
        fromKind: string;
        fromFilePath: string;
        fromLine: number;
        toDefinitionId: number;
        toName: string;
        toKind: string;
        toFilePath: string;
        toLine: number;
      }>
    >
  ): Promise<RelationshipSourceGroup[]> {
    const groups: RelationshipSourceGroup[] = [];

    for (const sourceId of sourceIds) {
      const rels = grouped.get(sourceId);
      if (!rels || rels.length === 0) continue;

      const def = db.definitions.getById(sourceId);
      if (!def) continue;

      const sourceCode = await readSourceAsString(db.resolveFilePath(def.filePath), def.line, def.endLine);
      const sourceMeta = db.metadata.get(sourceId);

      let sourceDomains: string[] | null = null;
      try {
        if (sourceMeta.domain) {
          sourceDomains = JSON.parse(sourceMeta.domain) as string[];
        }
      } catch {
        /* ignore */
      }

      // Build target info
      const relationships: RelationshipTarget[] = [];
      for (const rel of rels) {
        const targetMeta = db.metadata.get(rel.toDefinitionId);

        relationships.push({
          toId: rel.toDefinitionId,
          toName: rel.toName,
          toKind: rel.toKind,
          toFilePath: rel.toFilePath,
          toLine: rel.toLine,
          usageLine: rel.fromLine,
          relationshipType: 'uses',
          toPurpose: targetMeta.purpose || null,
          toDomains: null,
          toRole: targetMeta.role || null,
        });
      }

      groups.push({
        id: sourceId,
        name: def.name,
        kind: def.kind,
        filePath: def.filePath,
        line: def.line,
        endLine: def.endLine,
        sourceCode,
        purpose: sourceMeta.purpose || null,
        domains: sourceDomains,
        role: sourceMeta.role || null,
        relationships,
      });
    }

    return groups;
  }
}
