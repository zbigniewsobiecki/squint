import { Flags } from '@oclif/core';
import chalk from 'chalk';
import type { ReadySymbolInfo } from '../../db/database.js';
import {
  LlmFlags,
  RelationshipRetryQueue,
  SharedFlags,
  enhanceSymbols,
  readSourceAsString,
  validateAnnotationValue,
} from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import {
  type AnnotationResult,
  type IterationSummary,
  type RelationshipAnnotationResult,
  type RelationshipCoverageInfo,
  filterCoverageForAspects,
  formatFinalSummary,
  formatIterationResults,
} from '../llm/_shared/coverage.js';
import { parseCombinedCsv } from '../llm/_shared/csv.js';
import { completeWithLogging } from '../llm/_shared/llm-utils.js';
import {
  type CoverageInfo,
  type SymbolContextEnhanced,
  buildSystemPrompt,
  buildUserPromptEnhanced,
} from '../llm/_shared/prompts.js';

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
    '<%= config.bin %> symbols annotate --aspect purpose',
    '<%= config.bin %> symbols annotate --aspect purpose --aspect domain',
    '<%= config.bin %> symbols annotate --aspect purpose --model gpt4o --batch-size 10',
    '<%= config.bin %> symbols annotate --aspect purpose --dry-run',
    '<%= config.bin %> symbols annotate --aspect purpose --kind function --max-iterations 5',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    ...LlmFlags,
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
      default: 0,
    }),
  };

  protected async execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, dryRun, model } = ctx;

    const aspects = flags.aspect as string[];

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
            const enhancedCycleSymbols = await enhanceSymbols(db, cycleSymbols, aspects, relationshipLimit);

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

            // Build source code, dependency, and kind maps for cycle symbols
            const cycleSourceCodeById = new Map(symbolContexts.map((s) => [s.id, s.sourceCode]));
            const cycleDepsById = new Map(enhancedCycleSymbols.map((s) => [s.id, s.dependencies]));
            const cycleKindById = new Map(enhancedCycleSymbols.map((s) => [s.id, s.kind]));

            // Process symbol annotations
            for (const row of parseResult.symbols) {
              if (!validSymbolIds.has(row.symbolId)) continue;
              if (!aspects.includes(row.aspect)) continue;

              let value = row.value;
              const validationError = validateAnnotationValue(
                row.aspect,
                value,
                cycleSourceCodeById.get(row.symbolId),
                cycleDepsById.get(row.symbolId),
                cycleKindById.get(row.symbolId)
              );
              if (validationError?.startsWith('overridden to true')) {
                if (!isJson && ctx.verbose) {
                  this.log(chalk.yellow(`  Pure override for #${row.symbolId}: ${validationError}`));
                }
                value = 'true';
              } else if (validationError?.startsWith('overridden')) {
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
      const enhancedSymbols = await enhanceSymbols(db, symbols, aspects, relationshipLimit);

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

      // Build source code, dependency, and kind maps for pure validation
      const sourceCodeById = new Map(symbolContexts.map((s) => [s.id, s.sourceCode]));
      const depsById = new Map(enhancedSymbols.map((s) => [s.id, s.dependencies]));
      const kindById = new Map(enhancedSymbols.map((s) => [s.id, s.kind]));

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
        const validationError = validateAnnotationValue(
          row.aspect,
          value,
          sourceCodeById.get(symbolId),
          depsById.get(symbolId),
          kindById.get(symbolId)
        );
        if (validationError?.startsWith('overridden to true')) {
          if (!isJson && ctx.verbose) {
            this.log(chalk.yellow(`  Pure override for #${symbolId}: ${validationError}`));
          }
          value = 'true';
        } else if (validationError?.startsWith('overridden')) {
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

        const sourceCode = await readSourceAsString(db.resolveFilePath(def.filePath), def.line, def.endLine);

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
}
