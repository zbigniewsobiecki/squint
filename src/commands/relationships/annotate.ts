import { Flags } from '@oclif/core';
import chalk from 'chalk';

import type { IndexDatabase } from '../../db/database.js';
import { LlmFlags, SharedFlags, readSourceAsString } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import type { RelationshipCoverageInfo } from '../llm/_shared/coverage.js';
import { parseCombinedCsv } from '../llm/_shared/csv.js';
import {
  type LlmLogOptions,
  completeWithLogging,
  groupBy,
  logLlmRequest,
  logLlmResponse,
} from '../llm/_shared/llm-utils.js';
import {
  type RelationshipSourceGroup,
  type RelationshipTarget,
  buildRelationshipSystemPrompt,
  buildRelationshipUserPrompt,
} from '../llm/_shared/prompts.js';

interface JsonIterationOutput {
  iteration: number;
  sourceSymbols: number;
  annotated: number;
  errors: number;
}

interface JsonOutput {
  iterations: JsonIterationOutput[];
  summary: {
    totalIterations: number;
    totalAnnotations: number;
    totalErrors: number;
    coverage: RelationshipCoverageInfo;
  };
}

export default class RelationshipsAnnotate extends BaseLlmCommand {
  static override description = 'Annotate relationships between symbols using an LLM';

  static override examples = [
    '<%= config.bin %> relationships annotate',
    '<%= config.bin %> relationships annotate --batch-size 10',
    '<%= config.bin %> relationships annotate --dry-run',
    '<%= config.bin %> relationships annotate --max-iterations 5',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    ...LlmFlags,
    'batch-size': Flags.integer({
      char: 'b',
      description: 'Number of source symbols per LLM call',
      default: 5,
    }),
    'max-iterations': Flags.integer({
      description: 'Maximum iterations (0 = unlimited)',
      default: 0,
    }),
  };

  protected async execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, dryRun, model } = ctx;

    const batchSize = flags['batch-size'] as number;
    const maxIterations = flags['max-iterations'] as number;

    const llmLogOptions: LlmLogOptions = {
      showRequests: ctx.llmOptions.showLlmRequests,
      showResponses: ctx.llmOptions.showLlmResponses,
      isJson,
    };

    // Build system prompt once
    const systemPrompt = buildRelationshipSystemPrompt();

    // Tracking
    let iteration = 0;
    let totalAnnotations = 0;
    let totalErrors = 0;
    const jsonOutput: JsonOutput = {
      iterations: [],
      summary: {
        totalIterations: 0,
        totalAnnotations: 0,
        totalErrors: 0,
        coverage: { annotated: 0, total: 0, percentage: 0 },
      },
    };

    // Header
    if (!isJson) {
      this.log(chalk.bold('LLM Relationship Annotation'));
      this.log(chalk.gray(`Model: ${model}, Batch size: ${batchSize}`));
      if (dryRun) {
        this.log(chalk.yellow('DRY RUN - annotations will not be persisted'));
      }
      this.log('');
    }

    // Check initial state
    const initialUnannotated = db.relationships.getUnannotatedCount();
    const initialPending = db.relationships.getUnannotatedInheritanceCount();
    if (initialUnannotated === 0 && initialPending === 0) {
      if (isJson) {
        this.log(JSON.stringify({ message: 'All relationships are already annotated' }));
      } else {
        this.log(chalk.green('All relationships are already annotated!'));
      }
      return;
    }

    if (!isJson) {
      const initialAnnotated = db.relationships.getCount();
      this.log(chalk.gray(`Unannotated relationships: ${initialUnannotated}, Already annotated: ${initialAnnotated}`));
      this.log('');
    }

    while (true) {
      iteration++;

      // Check max iterations
      if (maxIterations > 0 && iteration > maxIterations) {
        if (!isJson) {
          this.log(chalk.yellow(`Reached maximum iterations (${maxIterations})`));
        }
        break;
      }

      // Fetch unannotated relationships
      const unannotated = db.relationships.getUnannotated();
      if (unannotated.length === 0) {
        if (!isJson) {
          this.log(chalk.green('All relationships annotated!'));
        }
        break;
      }

      // Group by source symbol
      const grouped = groupBy(unannotated, (r) => r.fromDefinitionId);
      const sourceIds = [...grouped.keys()];

      // Take a batch of source symbols
      const batchSourceIds = sourceIds.slice(0, batchSize);

      // Build source groups for prompt
      const groups = await this.buildSourceGroups(db, batchSourceIds, grouped);

      if (groups.length === 0) {
        break;
      }

      const totalRelsInBatch = groups.reduce((sum, g) => sum + g.relationships.length, 0);

      if (!isJson && ctx.verbose) {
        this.log(
          chalk.gray(`Iteration ${iteration}: ${groups.length} source symbols, ${totalRelsInBatch} relationships`)
        );
      }

      // Build user prompt
      const userPrompt = buildRelationshipUserPrompt(groups);

      logLlmRequest(this, `relationships-iter${iteration}`, systemPrompt, userPrompt, llmLogOptions);

      // Call LLM
      let response: string;
      try {
        response = await completeWithLogging({
          model,
          systemPrompt,
          userPrompt,
          temperature: 0,
          command: this,
          isJson,
          iteration: { current: iteration, max: maxIterations },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isJson) {
          this.log(JSON.stringify({ error: `LLM API error: ${message}` }));
        } else {
          this.log(chalk.red(`LLM API error: ${message}`));
        }
        totalErrors++;
        break;
      }

      logLlmResponse(this, `relationships-iter${iteration}`, response, llmLogOptions);

      // Parse CSV
      const parseResult = parseCombinedCsv(response);

      // Log parse errors
      for (const error of parseResult.errors) {
        if (!isJson) {
          this.log(chalk.yellow(`  Warning: ${error}`));
        }
        totalErrors++;
      }

      // Build valid relationship map for this batch
      const validRelationships = new Map<number, Set<number>>();
      for (const group of groups) {
        const toIds = new Set(group.relationships.map((r) => r.toId));
        validRelationships.set(group.id, toIds);
      }

      const validSourceIds = new Set(batchSourceIds);
      let iterationAnnotations = 0;
      let iterationErrors = 0;

      // Process relationship rows
      for (const row of parseResult.relationships) {
        const { fromId, toId, value } = row;

        // Validate source symbol
        if (!validSourceIds.has(fromId)) {
          if (!isJson && ctx.verbose) {
            this.log(chalk.yellow(`  Skipped: invalid from_id ${fromId}`));
          }
          iterationErrors++;
          totalErrors++;
          continue;
        }

        // Validate relationship exists
        const toIds = validRelationships.get(fromId);
        if (!toIds || !toIds.has(toId)) {
          if (!isJson && ctx.verbose) {
            this.log(chalk.yellow(`  Skipped: unexpected relationship ${fromId} → ${toId}`));
          }
          iterationErrors++;
          totalErrors++;
          continue;
        }

        // Validate description length
        if (!value || value.length < 5) {
          if (!isJson && ctx.verbose) {
            this.log(chalk.yellow(`  Skipped: description too short for ${fromId} → ${toId}`));
          }
          iterationErrors++;
          totalErrors++;
          continue;
        }

        // Persist
        if (!dryRun) {
          db.relationships.set(fromId, toId, value);
        }

        iterationAnnotations++;
        totalAnnotations++;
      }

      // Show iteration summary
      if (isJson) {
        jsonOutput.iterations.push({
          iteration,
          sourceSymbols: groups.length,
          annotated: iterationAnnotations,
          errors: iterationErrors,
        });
      } else {
        const remaining = db.relationships.getUnannotatedCount();
        this.log(
          chalk.green(`  ✓ Annotated ${iterationAnnotations} relationships`) + chalk.gray(` (${remaining} remaining)`)
        );
      }
    }

    // Phase 2: Annotate PENDING inheritance relationships
    const pendingInheritance = db.relationships.getUnannotatedInheritance(500);
    if (pendingInheritance.length > 0) {
      if (!isJson) {
        this.log('');
        this.log(chalk.bold(`Annotating ${pendingInheritance.length} PENDING inheritance relationships...`));
      }

      // Group by fromId
      const inheritGrouped = new Map<number, typeof pendingInheritance>();
      for (const rel of pendingInheritance) {
        if (!inheritGrouped.has(rel.fromId)) inheritGrouped.set(rel.fromId, []);
        inheritGrouped.get(rel.fromId)!.push(rel);
      }

      const inheritSourceIds = [...inheritGrouped.keys()];

      // Process in batches
      for (let offset = 0; offset < inheritSourceIds.length; offset += batchSize) {
        const batchIds = inheritSourceIds.slice(offset, offset + batchSize);

        // Build source groups from PENDING inheritance relationships
        const inheritGroups = await this.buildInheritanceSourceGroups(db, batchIds, inheritGrouped);
        if (inheritGroups.length === 0) continue;

        const totalRelsInBatch = inheritGroups.reduce((sum, g) => sum + g.relationships.length, 0);
        iteration++;

        if (!isJson && ctx.verbose) {
          this.log(
            chalk.gray(`  Inheritance batch: ${inheritGroups.length} source symbols, ${totalRelsInBatch} relationships`)
          );
        }

        const userPrompt = buildRelationshipUserPrompt(inheritGroups);
        logLlmRequest(this, `relationships-inherit-${offset}`, systemPrompt, userPrompt, llmLogOptions);

        let response: string;
        try {
          response = await completeWithLogging({
            model,
            systemPrompt,
            userPrompt,
            temperature: 0,
            command: this,
            isJson,
            iteration: { current: iteration, max: maxIterations },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!isJson) {
            this.log(chalk.red(`  LLM API error: ${message}`));
          }
          totalErrors++;
          continue;
        }

        logLlmResponse(this, `relationships-inherit-${offset}`, response, llmLogOptions);

        const parseResult = parseCombinedCsv(response);
        for (const error of parseResult.errors) {
          if (!isJson) {
            this.log(chalk.yellow(`  Warning: ${error}`));
          }
          totalErrors++;
        }

        // Build valid relationship map for this batch
        const validRelationships = new Map<number, Set<number>>();
        for (const group of inheritGroups) {
          const toIds = new Set(group.relationships.map((r) => r.toId));
          validRelationships.set(group.id, toIds);
        }

        const validSourceIds = new Set(batchIds);
        let batchAnnotations = 0;

        for (const row of parseResult.relationships) {
          const { fromId, toId, value } = row;
          if (!validSourceIds.has(fromId)) {
            totalErrors++;
            continue;
          }
          const toIds = validRelationships.get(fromId);
          if (!toIds || !toIds.has(toId)) {
            totalErrors++;
            continue;
          }
          if (!value || value.length < 5) {
            totalErrors++;
            continue;
          }

          if (!dryRun) {
            db.relationships.set(fromId, toId, value);
          }
          batchAnnotations++;
          totalAnnotations++;
        }

        if (!isJson) {
          const remaining = db.relationships.getUnannotatedInheritanceCount();
          this.log(
            chalk.green(`  ✓ Annotated ${batchAnnotations} inheritance relationships`) +
              chalk.gray(` (${remaining} PENDING remaining)`)
          );
        }
      }
    }

    // Final summary
    const finalAnnotated = db.relationships.getCount();
    const finalUnannotated = db.relationships.getUnannotatedCount();
    const finalPending = db.relationships.getUnannotatedInheritanceCount();
    const finalTotal = finalAnnotated + finalUnannotated;
    const finalCoverage: RelationshipCoverageInfo = {
      annotated: finalAnnotated,
      total: finalTotal,
      percentage: finalTotal > 0 ? (finalAnnotated / finalTotal) * 100 : 0,
    };

    if (isJson) {
      jsonOutput.summary = {
        totalIterations: iteration - 1,
        totalAnnotations,
        totalErrors,
        coverage: finalCoverage,
      };
      this.log(JSON.stringify(jsonOutput, null, 2));
    } else {
      this.log('');
      this.log(chalk.bold('═'.repeat(50)));
      this.log(chalk.bold('Relationship Annotation Complete'));
      this.log(chalk.bold('═'.repeat(50)));
      this.log('');
      this.log(`Total iterations: ${iteration - 1}`);
      this.log(`Annotations created: ${chalk.green(totalAnnotations)}`);
      if (totalErrors > 0) {
        this.log(`Errors: ${chalk.red(totalErrors)}`);
      }
      if (finalPending > 0) {
        this.log(`PENDING inheritance: ${chalk.yellow(finalPending)}`);
      }
      this.log('');
      const pctColor =
        finalCoverage.percentage >= 80 ? chalk.green : finalCoverage.percentage >= 50 ? chalk.yellow : chalk.red;
      this.log(
        `Coverage: ${finalCoverage.annotated}/${finalCoverage.total} (${pctColor(`${finalCoverage.percentage.toFixed(1)}%`)})`
      );
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

  /**
   * Build RelationshipSourceGroup[] for PENDING inheritance relationships.
   */
  private async buildInheritanceSourceGroups(
    db: IndexDatabase,
    sourceIds: number[],
    grouped: Map<number, import('../../db/repositories/relationship-repository.js').UnannotatedInheritance[]>
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

      const relationships: RelationshipTarget[] = [];
      for (const rel of rels) {
        const targetDef = db.definitions.getById(rel.toId);
        const targetMeta = db.metadata.get(rel.toId);

        relationships.push({
          toId: rel.toId,
          toName: rel.toName,
          toKind: rel.toKind,
          toFilePath: rel.toFilePath,
          toLine: targetDef?.line ?? 1,
          usageLine: def.line,
          relationshipType: rel.relationshipType,
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
