import { Flags } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase, ReadySymbolInfo } from '../../db/database.js';
import { LlmFlags, SharedFlags, readSourceAsString } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from './_shared/base-llm-command.js';
import {
  type AnnotationResult,
  type IterationSummary,
  type RelationshipAnnotationResult,
  type RelationshipCoverageInfo,
  filterCoverageForAspects,
  formatFinalSummary,
  formatIterationResults,
} from './_shared/coverage.js';
import { parseCombinedCsv } from './_shared/csv.js';
import { completeWithLogging } from './_shared/llm-utils.js';
import {
  type CoverageInfo,
  type DependencyContextEnhanced,
  type IncomingDependencyContext,
  type RelationshipToAnnotate,
  type SymbolContextEnhanced,
  buildSystemPrompt,
  buildUserPromptEnhanced,
} from './_shared/prompts.js';
import { detectImpurePatterns } from './_shared/pure-check.js';
import { verifyAnnotationContent } from './_shared/verify/content-verifier.js';
import { checkAnnotationCoverage } from './_shared/verify/coverage-checker.js';
import type { VerifyReport } from './_shared/verify/verify-types.js';

interface EnhancedSymbol extends ReadySymbolInfo {
  sourceCode: string;
  isExported: boolean;
  dependencies: DependencyContextEnhanced[];
  relationshipsToAnnotate: RelationshipToAnnotate[];
  incomingDependencies: IncomingDependencyContext[];
  incomingDependencyCount: number;
}

/**
 * Tracks failed relationship annotations for retry.
 */
class RelationshipRetryQueue {
  private failures = new Map<string, { fromId: number; toId: number; attempts: number; error: string }>();

  private key(fromId: number, toId: number): string {
    return `${fromId}:${toId}`;
  }

  add(fromId: number, toId: number, error: string): void {
    const k = this.key(fromId, toId);
    const existing = this.failures.get(k);
    this.failures.set(k, {
      fromId,
      toId,
      attempts: (existing?.attempts ?? 0) + 1,
      error,
    });
  }

  getRetryable(maxAttempts = 3): Array<{ fromId: number; toId: number }> {
    const result: Array<{ fromId: number; toId: number }> = [];
    for (const entry of this.failures.values()) {
      if (entry.attempts < maxAttempts) {
        result.push({ fromId: entry.fromId, toId: entry.toId });
      }
    }
    return result;
  }

  clear(): void {
    this.failures.clear();
  }

  get size(): number {
    return this.failures.size;
  }
}

interface JsonOutput {
  iterations: IterationJsonOutput[];
  summary: {
    totalIterations: number;
    totalAnnotations: number;
    totalRelationshipAnnotations: number;
    totalErrors: number;
    coverage: CoverageInfo[];
    relationshipCoverage: RelationshipCoverageInfo;
  };
}

interface IterationJsonOutput {
  iteration: number;
  symbolsProcessed: number;
  results: AnnotationResult[];
  relationshipResults: RelationshipAnnotationResult[];
  coverage: CoverageInfo[];
  relationshipCoverage: RelationshipCoverageInfo;
}

export default class Annotate extends BaseLlmCommand {
  static override description = 'Annotate symbols using an LLM in iterative batches';

  static override examples = [
    '<%= config.bin %> llm annotate --aspect purpose',
    '<%= config.bin %> llm annotate --aspect purpose --aspect domain',
    '<%= config.bin %> llm annotate --aspect purpose --model gpt4o --batch-size 10',
    '<%= config.bin %> llm annotate --aspect purpose --dry-run',
    '<%= config.bin %> llm annotate --aspect purpose --kind function --max-iterations 5',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    ...LlmFlags,
    verify: Flags.boolean({
      description: 'Verify existing annotations instead of creating new ones',
      default: false,
    }),
    fix: Flags.boolean({
      description: 'Auto-fix structural issues found during verification',
      default: false,
    }),
    force: Flags.boolean({
      description: 'Annotate symbols even if dependencies are not annotated',
      default: false,
    }),
    aspect: Flags.string({
      char: 'a',
      description: 'Metadata key to annotate (can be repeated)',
      required: true,
      multiple: true,
    }),
    'batch-size': Flags.integer({
      char: 'b',
      description: 'Number of symbols per LLM call',
      default: 5,
    }),
    'max-iterations': Flags.integer({
      description: 'Maximum iterations (0 = unlimited)',
      default: 0,
    }),
    kind: Flags.string({
      char: 'k',
      description: 'Filter by symbol kind',
    }),
    file: Flags.string({
      char: 'f',
      description: 'Filter by file path pattern',
    }),
    exclude: Flags.string({
      char: 'x',
      description: 'Glob pattern for files to exclude (e.g., **/*.test.ts)',
    }),
    'relationship-limit': Flags.integer({
      description: 'Max relationships per symbol (0 = no limit)',
      default: 50,
    }),
  };

  protected async execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, dryRun, model } = ctx;

    const aspects = flags.aspect as string[];

    // Verify mode: run verification instead of annotation
    if (flags.verify) {
      await this.runVerify(ctx, flags, aspects);
      return;
    }

    const primaryAspect = aspects[0]; // Use first aspect for readiness check
    const batchSize = flags['batch-size'] as number;
    const maxIterations = flags['max-iterations'] as number;
    const showLlmRequests = ctx.llmOptions.showLlmRequests;
    const showLlmResponses = ctx.llmOptions.showLlmResponses;
    const forceMode = flags.force as boolean;
    const excludePattern = flags.exclude as string | undefined;
    const relationshipLimit = flags['relationship-limit'] as number;

    // Build system prompt once
    const systemPrompt = buildSystemPrompt(aspects);

    // Track failed relationship annotations for retry
    const retryQueue = new RelationshipRetryQueue();

    // Tracking
    let iteration = 0;
    let totalAnnotations = 0;
    let totalRelationshipAnnotations = 0;
    let totalErrors = 0;
    const jsonOutput: JsonOutput = {
      iterations: [],
      summary: {
        totalIterations: 0,
        totalAnnotations: 0,
        totalRelationshipAnnotations: 0,
        totalErrors: 0,
        coverage: [],
        relationshipCoverage: { annotated: 0, total: 0, percentage: 0 },
      },
    };

    // Annotate has unique header logic (includes aspects, batch size)
    if (!isJson) {
      this.log(chalk.bold(`LLM Annotation: ${aspects.join(', ')}`));
      this.log(chalk.gray(`Model: ${model}, Batch size: ${batchSize}`));
      if (forceMode) {
        this.log(chalk.yellow('FORCE MODE - ignoring dependency ordering'));
      }
      if (excludePattern) {
        this.log(chalk.gray(`Excluding files matching: ${excludePattern}`));
      }
      if (dryRun) {
        this.log(chalk.yellow('DRY RUN - annotations will not be persisted'));
      }
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

      // Get batch of symbols to annotate
      let symbols: ReadySymbolInfo[];
      let totalRemaining: number;
      let blockedCount: number;

      if (forceMode) {
        // Force mode: get all unannotated symbols regardless of dependencies
        const result = db.graph.getAllUnannotated(primaryAspect, {
          limit: batchSize,
          kind: flags.kind as string | undefined,
          filePattern: flags.file as string | undefined,
          excludePattern: excludePattern,
        });
        symbols = result.symbols;
        totalRemaining = result.total;
        blockedCount = 0; // No blocking in force mode
      } else {
        // Normal mode: only get symbols with all dependencies annotated
        const result = db.dependencies.getReadySymbols(primaryAspect, {
          limit: batchSize,
          kind: flags.kind as string | undefined,
          filePattern: flags.file as string | undefined,
        });
        symbols = result.symbols;
        totalRemaining = result.totalReady + result.remaining;
        blockedCount = result.remaining;
      }

      if (symbols.length === 0) {
        if (totalRemaining === 0) {
          if (!isJson) {
            this.log(chalk.green(`All symbols have '${primaryAspect}' annotated!`));
          }
          break;
        }
        if (blockedCount > 0 && !forceMode) {
          // Check for circular dependencies
          const cycles = db.graph.findCycles(primaryAspect);

          if (cycles.length === 0) {
            // No cycles found - truly blocked
            if (!isJson) {
              this.log(chalk.yellow('No symbols ready for annotation.'));
              this.log(chalk.gray(`${blockedCount} symbols have unmet dependencies.`));
              this.log(chalk.gray('Use --force to annotate them anyway.'));
            }
            break;
          }

          // Process circular dependency groups
          if (!isJson) {
            this.log('');
            this.log(chalk.bold(`Found ${cycles.length} circular dependency group(s). Processing as batches...`));
          }

          for (const cycle of cycles) {
            // Get full symbol info for cycle members
            const cycleSymbols: ReadySymbolInfo[] = cycle
              .map((id) => db.definitions.getById(id))
              .filter((def): def is NonNullable<typeof def> => def !== null)
              .map((def) => ({
                id: def.id,
                name: def.name,
                kind: def.kind,
                filePath: def.filePath,
                line: def.line,
                endLine: def.endLine,
                dependencyCount: 0,
              }));

            if (cycleSymbols.length === 0) continue;

            const cycleNames = cycleSymbols.map((s) => s.name).join(', ');
            if (!isJson) {
              this.log(chalk.gray(`  Processing cycle: ${cycleNames} (${cycleSymbols.length} symbols)`));
            }

            // Enhance symbols with source code
            const enhancedCycleSymbols = await this.enhanceSymbols(db, cycleSymbols, aspects, relationshipLimit);

            // Get current coverage for the prompt
            const cycleCoverage = db.metadata.getAspectCoverage({
              kind: flags.kind as string | undefined,
              filePattern: flags.file as string | undefined,
            });
            const cycleTotalSymbols = db.metadata.getFilteredCount({
              kind: flags.kind as string | undefined,
              filePattern: flags.file as string | undefined,
            });
            const coverage = filterCoverageForAspects(cycleCoverage, aspects, cycleTotalSymbols);

            // Build prompt with cycle context
            const symbolContexts: SymbolContextEnhanced[] = enhancedCycleSymbols.map((s) => ({
              id: s.id,
              name: s.name,
              kind: s.kind,
              filePath: s.filePath,
              line: s.line,
              endLine: s.endLine,
              sourceCode: s.sourceCode,
              isExported: s.isExported,
              dependencies: s.dependencies,
              relationshipsToAnnotate: s.relationshipsToAnnotate,
              incomingDependencies: s.incomingDependencies,
              incomingDependencyCount: s.incomingDependencyCount,
            }));

            // Build user prompt with cycle note
            const basePrompt = buildUserPromptEnhanced(symbolContexts, aspects, coverage);
            const cycleNote =
              '\nNote: These symbols have circular dependencies - they reference each other. Annotate them based on their collective purpose and individual contributions.\n';
            const userPrompt = cycleNote + basePrompt;

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
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (!isJson) {
                this.log(chalk.red(`    LLM error for cycle: ${message}`));
              }
              totalErrors++;
              continue;
            }

            // Parse and persist results
            const parseResult = parseCombinedCsv(response);
            const validSymbolIds = new Set(enhancedCycleSymbols.map((s) => s.id));

            // Build valid relationship map for cycle symbols
            const cycleValidRelationships = new Map<number, Set<number>>();
            for (const s of enhancedCycleSymbols) {
              const toIds = new Set<number>();
              for (const rel of s.relationshipsToAnnotate) {
                toIds.add(rel.toId);
              }
              cycleValidRelationships.set(s.id, toIds);
            }

            let cycleAnnotations = 0;
            let cycleRelAnnotations = 0;

            // Build source code and dependency maps for cycle symbols
            const cycleSourceCodeById = new Map(symbolContexts.map((s) => [s.id, s.sourceCode]));
            const cycleDepsById = new Map(enhancedCycleSymbols.map((s) => [s.id, s.dependencies]));

            // Process symbol annotations
            for (const row of parseResult.symbols) {
              if (!validSymbolIds.has(row.symbolId)) continue;
              if (!aspects.includes(row.aspect)) continue;

              let value = row.value;
              const validationError = this.validateValue(
                row.aspect,
                value,
                cycleSourceCodeById.get(row.symbolId),
                cycleDepsById.get(row.symbolId)
              );
              if (validationError?.startsWith('overridden')) {
                if (!isJson && ctx.verbose) {
                  this.log(chalk.yellow(`  Pure override for #${row.symbolId}: ${validationError}`));
                }
                value = 'false';
              } else if (validationError) {
                totalErrors++;
                continue;
              }

              if (!dryRun) {
                db.metadata.set(row.symbolId, row.aspect, value);
              }
              cycleAnnotations++;
              totalAnnotations++;
            }

            // Process relationship annotations
            for (const row of parseResult.relationships) {
              const fromId = row.fromId;
              const toId = row.toId;

              if (!validSymbolIds.has(fromId)) continue;

              const toIds = cycleValidRelationships.get(fromId);
              if (!toIds || !toIds.has(toId)) continue;

              if (!row.value || row.value.length < 5) {
                totalErrors++;
                continue;
              }

              if (!dryRun) {
                db.relationships.set(fromId, toId, row.value);
              }
              cycleRelAnnotations++;
              totalRelationshipAnnotations++;
            }

            if (!isJson) {
              this.log(
                chalk.green(`    ✓ Annotated ${cycleAnnotations} symbols, ${cycleRelAnnotations} relationships`)
              );
            }
          }

          // Continue the loop to process any newly unblocked symbols
          continue;
        }
        break;
      }

      // Enhance symbols with source code and dependency context
      const enhancedSymbols = await this.enhanceSymbols(db, symbols, aspects, relationshipLimit);

      // Get current coverage for the prompt
      const allCoverage = db.metadata.getAspectCoverage({
        kind: flags.kind as string | undefined,
        filePattern: flags.file as string | undefined,
      });
      const totalSymbols = db.metadata.getFilteredCount({
        kind: flags.kind as string | undefined,
        filePattern: flags.file as string | undefined,
      });
      const coverage = filterCoverageForAspects(allCoverage, aspects, totalSymbols);

      // Build prompt
      const symbolContexts: SymbolContextEnhanced[] = enhancedSymbols.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        filePath: s.filePath,
        line: s.line,
        endLine: s.endLine,
        sourceCode: s.sourceCode,
        isExported: s.isExported,
        dependencies: s.dependencies,
        relationshipsToAnnotate: s.relationshipsToAnnotate,
        incomingDependencies: s.incomingDependencies,
        incomingDependencyCount: s.incomingDependencyCount,
      }));
      const userPrompt = buildUserPromptEnhanced(symbolContexts, aspects, coverage);

      // Show LLM request if requested
      if (showLlmRequests) {
        this.log('');
        this.log(chalk.bold.cyan('═'.repeat(60)));
        this.log(chalk.bold.cyan('LLM REQUEST'));
        this.log(chalk.bold.cyan('═'.repeat(60)));
        this.log('');
        this.log(chalk.bold('SYSTEM PROMPT:'));
        this.log(chalk.dim('─'.repeat(40)));
        this.log(systemPrompt);
        this.log('');
        this.log(chalk.bold('USER PROMPT:'));
        this.log(chalk.dim('─'.repeat(40)));
        this.log(userPrompt);
        this.log(chalk.bold.cyan('═'.repeat(60)));
        this.log('');
      }

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
        this.error(chalk.red(`LLM API error: ${message}`));
      }

      // Show LLM response if requested
      if (showLlmResponses) {
        this.log('');
        this.log(chalk.bold.green('═'.repeat(60)));
        this.log(chalk.bold.green('LLM RESPONSE'));
        this.log(chalk.bold.green('═'.repeat(60)));
        this.log('');
        this.log(response);
        this.log('');
        this.log(chalk.bold.green('═'.repeat(60)));
        this.log('');
      }

      // Parse combined CSV response
      const parseResult = parseCombinedCsv(response);

      // Process results
      const iterationResults: AnnotationResult[] = [];
      const iterationRelResults: RelationshipAnnotationResult[] = [];
      const validSymbolIds = new Set(enhancedSymbols.map((s) => s.id));
      const symbolNameById = new Map(enhancedSymbols.map((s) => [s.id, s.name]));

      // Build source code and dependency maps for pure validation
      const sourceCodeById = new Map(symbolContexts.map((s) => [s.id, s.sourceCode]));
      const depsById = new Map(enhancedSymbols.map((s) => [s.id, s.dependencies]));

      // Build valid relationship map (from_id -> Set of valid to_ids)
      const validRelationships = new Map<number, Map<number, string>>();
      for (const s of enhancedSymbols) {
        const toMap = new Map<number, string>();
        for (const rel of s.relationshipsToAnnotate) {
          toMap.set(rel.toId, rel.toName);
        }
        validRelationships.set(s.id, toMap);
      }

      // Log parse errors
      for (const error of parseResult.errors) {
        if (!isJson) {
          this.log(chalk.yellow(`  Warning: ${error}`));
        }
        totalErrors++;
      }

      // Process symbol annotation rows
      for (const row of parseResult.symbols) {
        const symbolId = row.symbolId;

        // Validate symbol ID
        if (!validSymbolIds.has(symbolId)) {
          iterationResults.push({
            symbolId,
            symbolName: String(symbolId),
            aspect: row.aspect,
            value: row.value,
            success: false,
            error: `Invalid symbol ID: ${symbolId}`,
          });
          totalErrors++;
          continue;
        }

        // Validate aspect
        if (!aspects.includes(row.aspect)) {
          iterationResults.push({
            symbolId,
            symbolName: symbolNameById.get(symbolId) || String(symbolId),
            aspect: row.aspect,
            value: row.value,
            success: false,
            error: `Unexpected aspect: ${row.aspect}`,
          });
          totalErrors++;
          continue;
        }

        // Validate value (aspect-specific)
        let value = row.value;
        const validationError = this.validateValue(
          row.aspect,
          value,
          sourceCodeById.get(symbolId),
          depsById.get(symbolId)
        );
        if (validationError?.startsWith('overridden')) {
          // Pure gate triggered — override value to false and log
          if (!isJson && ctx.verbose) {
            this.log(chalk.yellow(`  Pure override for #${symbolId}: ${validationError}`));
          }
          value = 'false';
        } else if (validationError) {
          iterationResults.push({
            symbolId,
            symbolName: symbolNameById.get(symbolId) || String(symbolId),
            aspect: row.aspect,
            value,
            success: false,
            error: validationError,
          });
          totalErrors++;
          continue;
        }

        // Persist (unless dry-run)
        if (!dryRun) {
          db.metadata.set(symbolId, row.aspect, value);
        }

        iterationResults.push({
          symbolId,
          symbolName: symbolNameById.get(symbolId) || String(symbolId),
          aspect: row.aspect,
          value,
          success: true,
        });
        totalAnnotations++;
      }

      // Process relationship annotation rows
      for (const row of parseResult.relationships) {
        const fromId = row.fromId;
        const toId = row.toId;

        // Validate from_id
        if (!validSymbolIds.has(fromId)) {
          iterationRelResults.push({
            fromId,
            fromName: String(fromId),
            toId,
            toName: String(toId),
            value: row.value,
            success: false,
            error: `Invalid from_id: ${fromId}`,
          });
          totalErrors++;
          continue;
        }

        // Validate relationship exists
        const toMap = validRelationships.get(fromId);
        if (!toMap || !toMap.has(toId)) {
          iterationRelResults.push({
            fromId,
            fromName: symbolNameById.get(fromId) || String(fromId),
            toId,
            toName: String(toId),
            value: row.value,
            success: false,
            error: `Unexpected relationship: ${fromId} → ${toId}`,
          });
          totalErrors++;
          continue;
        }

        // Validate value is not empty
        if (!row.value || row.value.length < 5) {
          const errorMsg = 'Relationship description must be at least 5 characters';
          iterationRelResults.push({
            fromId,
            fromName: symbolNameById.get(fromId) || String(fromId),
            toId,
            toName: toMap.get(toId) || String(toId),
            value: row.value,
            success: false,
            error: errorMsg,
          });
          retryQueue.add(fromId, toId, errorMsg);
          totalErrors++;
          continue;
        }

        // Persist (unless dry-run)
        if (!dryRun) {
          db.relationships.set(fromId, toId, row.value);
        }

        iterationRelResults.push({
          fromId,
          fromName: symbolNameById.get(fromId) || String(fromId),
          toId,
          toName: toMap.get(toId) || String(toId),
          value: row.value,
          success: true,
        });
        totalRelationshipAnnotations++;
      }

      // Get updated coverage
      const updatedCoverage = db.metadata.getAspectCoverage({
        kind: flags.kind as string | undefined,
        filePattern: flags.file as string | undefined,
      });
      const finalCoverage = filterCoverageForAspects(updatedCoverage, aspects, totalSymbols);

      // Get relationship coverage (handle missing table in older databases)
      let annotatedRels = 0;
      let unannotatedRels = 0;
      try {
        annotatedRels = db.relationships.getCount();
        unannotatedRels = db.relationships.getUnannotatedCount();
      } catch {
        // Table doesn't exist - continue with zeros
      }
      const totalRels = annotatedRels + unannotatedRels;
      const relCoverage: RelationshipCoverageInfo = {
        annotated: annotatedRels,
        total: totalRels,
        percentage: totalRels > 0 ? (annotatedRels / totalRels) * 100 : 0,
      };

      // Get ready/blocked counts
      const updatedResult = db.dependencies.getReadySymbols(primaryAspect, {
        limit: 1,
        kind: flags.kind as string | undefined,
        filePattern: flags.file as string | undefined,
      });

      const summary: IterationSummary = {
        iteration,
        results: iterationResults,
        relationshipResults: iterationRelResults,
        coverage: finalCoverage,
        relationshipCoverage: relCoverage,
        readyCount: updatedResult.totalReady,
        blockedCount: updatedResult.remaining,
      };

      // Output iteration results
      if (isJson) {
        jsonOutput.iterations.push({
          iteration,
          symbolsProcessed: enhancedSymbols.length,
          results: iterationResults,
          relationshipResults: iterationRelResults,
          coverage: finalCoverage,
          relationshipCoverage: relCoverage,
        });
      } else {
        for (const line of formatIterationResults(summary)) {
          this.log(line);
        }
      }
    }

    // Retry failed relationship annotations (single pass)
    const retryable = retryQueue.getRetryable(3);
    if (retryable.length > 0 && !dryRun) {
      if (!isJson) {
        this.log('');
        this.log(chalk.bold(`Retrying ${retryable.length} failed relationship annotations...`));
      }

      // Build focused prompt for failed relationships only
      // Group by fromId for context
      const byFromId = new Map<number, number[]>();
      for (const { fromId, toId } of retryable) {
        if (!byFromId.has(fromId)) byFromId.set(fromId, []);
        byFromId.get(fromId)!.push(toId);
      }

      let retrySuccessCount = 0;
      for (const [fromId, toIds] of byFromId) {
        const def = db.definitions.getById(fromId);
        if (!def) continue;

        const sourceCode = await readSourceAsString(def.filePath, def.line, def.endLine);

        // Build minimal retry prompt
        const retryPrompt = `Please provide relationship annotations for these specific relationships. Be thorough and descriptive (minimum 5 characters).

Symbol: ${def.name} (${def.kind})
File: ${def.filePath}:${def.line}

\`\`\`
${sourceCode}
\`\`\`

Relationships to annotate:
${toIds
  .map((toId) => {
    const toDef = db.definitions.getById(toId);
    return toDef ? `- ${def.name} → ${toDef.name} (${toDef.kind} in ${toDef.filePath})` : null;
  })
  .filter(Boolean)
  .join('\n')}

Format: CSV with columns: from_id,to_id,relationship_annotation
\`\`\`csv
from_id,to_id,relationship_annotation
${toIds.map((toId) => `${fromId},${toId},"<describe how ${def.name} uses this dependency>"`).join('\n')}
\`\`\``;

        try {
          const response = await completeWithLogging({
            model,
            systemPrompt:
              'You are annotating code relationships. Provide clear, concise descriptions of how symbols are related.',
            userPrompt: retryPrompt,
            temperature: 0,
            command: this,
            isJson,
          });

          // Parse response for relationship annotations
          const lines = response.split('\n');
          for (const line of lines) {
            const match = line.match(/^(\d+),(\d+),["']?(.+?)["']?$/);
            if (match) {
              const retryFromId = Number.parseInt(match[1], 10);
              const retryToId = Number.parseInt(match[2], 10);
              const value = match[3].trim();

              if (retryFromId === fromId && toIds.includes(retryToId) && value.length >= 5) {
                db.relationships.set(retryFromId, retryToId, value);
                retrySuccessCount++;
                totalRelationshipAnnotations++;
              }
            }
          }
        } catch {
          // Retry failed, continue
        }
      }

      if (!isJson && retrySuccessCount > 0) {
        this.log(chalk.green(`  Successfully retried ${retrySuccessCount} relationships`));
      }
    }

    // Final summary
    const finalCoverageData = db.metadata.getAspectCoverage({
      kind: flags.kind as string | undefined,
      filePattern: flags.file as string | undefined,
    });
    const totalSymbols = db.metadata.getFilteredCount({
      kind: flags.kind as string | undefined,
      filePattern: flags.file as string | undefined,
    });
    const coverage = filterCoverageForAspects(finalCoverageData, aspects, totalSymbols);

    // Get final relationship coverage (handle missing table in older databases)
    let finalAnnotatedRels = 0;
    let finalUnannotatedRels = 0;
    try {
      finalAnnotatedRels = db.relationships.getCount();
      finalUnannotatedRels = db.relationships.getUnannotatedCount();
    } catch {
      // Table doesn't exist - continue with zeros
    }
    const finalTotalRels = finalAnnotatedRels + finalUnannotatedRels;
    const finalRelCoverage: RelationshipCoverageInfo = {
      annotated: finalAnnotatedRels,
      total: finalTotalRels,
      percentage: finalTotalRels > 0 ? (finalAnnotatedRels / finalTotalRels) * 100 : 0,
    };

    if (isJson) {
      jsonOutput.summary = {
        totalIterations: iteration - 1,
        totalAnnotations,
        totalRelationshipAnnotations,
        totalErrors,
        coverage,
        relationshipCoverage: finalRelCoverage,
      };
      this.log(JSON.stringify(jsonOutput, null, 2));
    } else {
      for (const line of formatFinalSummary(
        totalAnnotations,
        totalRelationshipAnnotations,
        totalErrors,
        iteration - 1,
        coverage,
        finalRelCoverage
      )) {
        this.log(line);
      }
    }
  }

  /**
   * Run verification mode: Phase 1 (coverage) then optional Phase 2 (LLM content).
   */
  private async runVerify(ctx: LlmContext, flags: Record<string, unknown>, aspects: string[]): Promise<void> {
    const { db, isJson, dryRun } = ctx;
    const batchSize = (flags['batch-size'] as number) || 10;
    const maxIterations = (flags['max-iterations'] as number) || 0;
    const shouldFix = flags.fix as boolean;

    if (!isJson) {
      this.log(chalk.bold('Annotation Verification'));
      this.log(chalk.gray(`Aspects: ${aspects.join(', ')}`));
      this.log('');
    }

    // Phase 1: Coverage check
    if (!isJson) {
      this.log(chalk.bold('Phase 1: Coverage Check'));
    }

    const phase1 = checkAnnotationCoverage(db, aspects);
    const report: VerifyReport = { phase1 };

    if (!isJson) {
      this.log(`  Definitions: ${phase1.stats.annotatedDefinitions}/${phase1.stats.totalDefinitions} annotated`);
      if (phase1.stats.missingCount > 0) {
        this.log(chalk.red(`  Missing: ${phase1.stats.missingCount} annotations`));
      }

      const errorIssues = phase1.issues.filter((i) => i.severity === 'error');
      if (errorIssues.length > 0) {
        this.log('');
        for (const issue of errorIssues.slice(0, 20)) {
          this.log(
            `  ${chalk.red('ERR')} ${issue.definitionName || '?'} (${issue.filePath}:${issue.line}): ${issue.message}`
          );
        }
        if (errorIssues.length > 20) {
          this.log(chalk.gray(`  ... and ${errorIssues.length - 20} more`));
        }
      }

      const warningIssues = phase1.issues.filter((i) => i.severity === 'warning');
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
        this.log(chalk.green('  ✓ All definitions have all aspects annotated'));
      } else {
        this.log(chalk.red('  ✗ Coverage check failed'));
      }
      this.log('');
    }

    // Auto-fix: correct suspect-pure annotations if --fix
    if (shouldFix && !dryRun) {
      const suspectPureIssues = phase1.issues.filter((i) => i.fixData?.action === 'set-pure-false');
      if (suspectPureIssues.length > 0) {
        let fixed = 0;
        for (const issue of suspectPureIssues) {
          if (issue.definitionId) {
            db.metadata.set(issue.definitionId, 'pure', 'false');
            fixed++;
          }
        }
        if (!isJson) {
          this.log(chalk.green(`  Fixed: corrected ${fixed} pure annotations to "false"`));
          this.log('');
        }
      }
    }

    // If dry-run or Phase 1 failed, stop here
    if (dryRun || !phase1.passed) {
      if (isJson) {
        this.log(JSON.stringify(report, null, 2));
      } else if (dryRun) {
        this.log(chalk.yellow('Dry run — skipping Phase 2 (LLM content verification)'));
      }
      return;
    }

    // Phase 2: LLM content verification
    if (!isJson) {
      this.log(chalk.bold('Phase 2: Content Verification (LLM)'));
    }

    const phase2 = await verifyAnnotationContent(
      db,
      ctx,
      this,
      {
        'batch-size': batchSize,
        'max-iterations': maxIterations,
      },
      aspects
    );
    report.phase2 = phase2;

    if (!isJson) {
      this.log(`  Checked: ${phase2.stats.checked} definitions in ${phase2.stats.batchesProcessed} batches`);

      if (phase2.issues.length === 0) {
        this.log(chalk.green('  ✓ All annotations passed content verification'));
      } else {
        this.log(chalk.yellow(`  Found ${phase2.issues.length} issues:`));
        for (const issue of phase2.issues) {
          const severity = issue.severity === 'error' ? chalk.red('ERR') : chalk.yellow('WARN');
          this.log(`  ${severity} ${issue.definitionName || '?'}: ${issue.message}`);
        }
      }
    }

    if (isJson) {
      this.log(JSON.stringify(report, null, 2));
    }
  }

  /**
   * Enhance symbols with source code, dependency context, and relationships to annotate.
   */
  private async enhanceSymbols(
    db: IndexDatabase,
    symbols: ReadySymbolInfo[],
    aspects: string[],
    relationshipLimit: number
  ): Promise<EnhancedSymbol[]> {
    const enhanced: EnhancedSymbol[] = [];

    for (const symbol of symbols) {
      const sourceCode = await readSourceAsString(symbol.filePath, symbol.line, symbol.endLine);

      // Get dependencies with all their metadata
      const deps = db.dependencies.getWithMetadata(symbol.id, aspects[0]);
      const dependencies: DependencyContextEnhanced[] = deps.map((dep) => {
        // Get all metadata for this dependency
        const metadata = db.metadata.get(dep.id);

        let domains: string[] | null = null;
        try {
          if (metadata.domain) {
            domains = JSON.parse(metadata.domain) as string[];
          }
        } catch {
          /* ignore */
        }

        return {
          id: dep.id,
          name: dep.name,
          kind: dep.kind,
          filePath: dep.filePath,
          line: dep.line,
          purpose: metadata.purpose || null,
          domains,
          role: metadata.role || null,
          pure: metadata.pure ? metadata.pure === 'true' : null,
        };
      });

      // Get unannotated relationships from this symbol (handle missing table)
      let unannotatedRels: ReturnType<typeof db.relationships.getUnannotated> = [];
      try {
        const limit = relationshipLimit > 0 ? relationshipLimit : undefined;
        unannotatedRels = db.relationships.getUnannotated({ fromDefinitionId: symbol.id, limit });
      } catch {
        // Table doesn't exist - continue with empty relationships
      }
      // These are usage-based relationships (calls), so they're all 'uses' type
      const relationshipsToAnnotate: RelationshipToAnnotate[] = unannotatedRels.map((rel) => ({
        toId: rel.toDefinitionId,
        toName: rel.toName,
        toKind: rel.toKind,
        usageLine: rel.fromLine, // Use fromLine as approximate usage location
        relationshipType: 'uses' as const,
      }));

      // Get incoming dependencies (who uses this symbol)
      const incomingDeps = db.dependencies.getIncoming(symbol.id, 5);
      const incomingDependencyCount = db.dependencies.getIncomingCount(symbol.id);
      const incomingDependencies: IncomingDependencyContext[] = incomingDeps.map((inc) => ({
        id: inc.id,
        name: inc.name,
        kind: inc.kind,
        filePath: inc.filePath,
      }));

      // Get the definition to check if it's exported
      const defInfo = db.definitions.getById(symbol.id);
      const isExported = defInfo?.isExported ?? false;

      enhanced.push({
        ...symbol,
        sourceCode,
        isExported,
        dependencies,
        relationshipsToAnnotate,
        incomingDependencies,
        incomingDependencyCount,
      });
    }

    return enhanced;
  }

  /**
   * Validate a value for a specific aspect.
   */
  private validateValue(
    aspect: string,
    value: string,
    sourceCode?: string,
    deps?: DependencyContextEnhanced[]
  ): string | null {
    switch (aspect) {
      case 'domain':
        try {
          const parsed = JSON.parse(value);
          if (!Array.isArray(parsed)) {
            return 'domain must be a JSON array';
          }
          if (!parsed.every((d) => typeof d === 'string')) {
            return 'domain array must contain only strings';
          }
        } catch {
          return 'domain must be valid JSON array';
        }
        break;

      case 'pure':
        if (value !== 'true' && value !== 'false') {
          return 'pure must be "true" or "false"';
        }
        // Gate 1: override LLM's "true" if source code contains impure patterns
        if (value === 'true' && sourceCode) {
          const impureReasons = detectImpurePatterns(sourceCode);
          if (impureReasons.length > 0) {
            return `overridden to false: ${impureReasons[0]}`;
          }
        }
        // Gate 2: transitive impurity — if any dependency is pure:false, this can't be pure:true
        if (value === 'true' && deps && deps.length > 0) {
          const impureDep = deps.find((d) => d.pure === false);
          if (impureDep) {
            return `overridden to false: calls impure dependency '${impureDep.name}'`;
          }
        }
        break;

      case 'purpose':
        if (!value || value.length < 5) {
          return 'purpose must be at least 5 characters';
        }
        break;
    }

    return null;
  }
}
