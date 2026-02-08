import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { LLMist } from 'llmist';
import { IndexDatabase, ReadySymbolInfo } from '../../db/database.js';
import { openDatabase, SharedFlags, readSourceAsString } from '../_shared/index.js';
import { parseCombinedCsv } from './_shared/csv.js';
import {
  buildSystemPrompt,
  buildUserPromptEnhanced,
  SymbolContextEnhanced,
  DependencyContextEnhanced,
  RelationshipToAnnotate,
  CoverageInfo,
  IncomingDependencyContext,
} from './_shared/prompts.js';
import {
  formatIterationResults,
  formatFinalSummary,
  filterCoverageForAspects,
  AnnotationResult,
  RelationshipAnnotationResult,
  RelationshipCoverageInfo,
  IterationSummary,
} from './_shared/coverage.js';

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

export default class Annotate extends Command {
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
    aspect: Flags.string({
      char: 'a',
      description: 'Metadata key to annotate (can be repeated)',
      required: true,
      multiple: true,
    }),
    model: Flags.string({
      char: 'm',
      description: 'LLM model alias',
      default: 'sonnet',
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
    'dry-run': Flags.boolean({
      description: 'Parse LLM output but do not persist',
      default: false,
    }),
    kind: Flags.string({
      char: 'k',
      description: 'Filter by symbol kind',
    }),
    file: Flags.string({
      char: 'f',
      description: 'Filter by file path pattern',
    }),
    json: SharedFlags.json,
    'show-llm-requests': Flags.boolean({
      description: 'Show full LLM requests (system + user prompts)',
      default: false,
    }),
    'show-llm-responses': Flags.boolean({
      description: 'Show full LLM responses',
      default: false,
    }),
    force: Flags.boolean({
      description: 'Annotate symbols even if dependencies are not annotated',
      default: false,
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

  public async run(): Promise<void> {
    const { flags } = await this.parse(Annotate);

    // Open database
    const db = await openDatabase(flags.database, this);

    const aspects = flags.aspect;
    const primaryAspect = aspects[0]; // Use first aspect for readiness check
    const batchSize = flags['batch-size'];
    const maxIterations = flags['max-iterations'];
    const dryRun = flags['dry-run'];
    const isJson = flags.json;
    const showLlmRequests = flags['show-llm-requests'];
    const showLlmResponses = flags['show-llm-responses'];
    const forceMode = flags.force;
    const excludePattern = flags.exclude;
    const relationshipLimit = flags['relationship-limit'];

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

    if (!isJson) {
      this.log(chalk.bold(`LLM Annotation: ${aspects.join(', ')}`));
      this.log(chalk.gray(`Model: ${flags.model}, Batch size: ${batchSize}`));
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

    try {
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
          const result = db.getAllUnannotatedSymbols(primaryAspect, {
            limit: batchSize,
            kind: flags.kind,
            filePattern: flags.file,
            excludePattern: excludePattern,
          });
          symbols = result.symbols;
          totalRemaining = result.total;
          blockedCount = 0; // No blocking in force mode
        } else {
          // Normal mode: only get symbols with all dependencies annotated
          const result = db.getReadyToUnderstandSymbols(primaryAspect, {
            limit: batchSize,
            kind: flags.kind,
            filePattern: flags.file,
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
          } else if (blockedCount > 0) {
            if (!isJson) {
              this.log(chalk.yellow(`No symbols ready for annotation.`));
              this.log(chalk.gray(`${blockedCount} symbols have unmet dependencies.`));
              this.log(chalk.gray(`Use --force to annotate them anyway.`));
            }
          }
          break;
        }

        // Enhance symbols with source code and dependency context
        const enhancedSymbols = await this.enhanceSymbols(db, symbols, aspects, relationshipLimit);

        // Get current coverage for the prompt
        const allCoverage = db.getAspectCoverage({
          kind: flags.kind,
          filePattern: flags.file,
        });
        const totalSymbols = db.getFilteredDefinitionCount({
          kind: flags.kind,
          filePattern: flags.file,
        });
        const coverage = filterCoverageForAspects(allCoverage, aspects, totalSymbols);

        // Build prompt
        const symbolContexts: SymbolContextEnhanced[] = enhancedSymbols.map(s => ({
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
          response = await LLMist.complete(userPrompt, {
            model: flags.model,
            systemPrompt,
            temperature: 0,
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
        const validSymbolIds = new Set(enhancedSymbols.map(s => s.id));
        const symbolNameById = new Map(enhancedSymbols.map(s => [s.id, s.name]));

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
          const validationError = this.validateValue(row.aspect, row.value);
          if (validationError) {
            iterationResults.push({
              symbolId,
              symbolName: symbolNameById.get(symbolId) || String(symbolId),
              aspect: row.aspect,
              value: row.value,
              success: false,
              error: validationError,
            });
            totalErrors++;
            continue;
          }

          // Persist (unless dry-run)
          if (!dryRun) {
            db.setDefinitionMetadata(symbolId, row.aspect, row.value);
          }

          iterationResults.push({
            symbolId,
            symbolName: symbolNameById.get(symbolId) || String(symbolId),
            aspect: row.aspect,
            value: row.value,
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
            db.setRelationshipAnnotation(fromId, toId, row.value);
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
        const updatedCoverage = db.getAspectCoverage({
          kind: flags.kind,
          filePattern: flags.file,
        });
        const finalCoverage = filterCoverageForAspects(updatedCoverage, aspects, totalSymbols);

        // Get relationship coverage (handle missing table in older databases)
        let annotatedRels = 0;
        let unannotatedRels = 0;
        try {
          annotatedRels = db.getRelationshipAnnotationCount();
          unannotatedRels = db.getUnannotatedRelationshipCount();
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
        const updatedResult = db.getReadyToUnderstandSymbols(primaryAspect, {
          limit: 1,
          kind: flags.kind,
          filePattern: flags.file,
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
          const def = db.getDefinitionById(fromId);
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
${toIds.map(toId => {
  const toDef = db.getDefinitionById(toId);
  return toDef ? `- ${def.name} → ${toDef.name} (${toDef.kind} in ${toDef.filePath})` : null;
}).filter(Boolean).join('\n')}

Format: CSV with columns: from_id,to_id,relationship_annotation
\`\`\`csv
from_id,to_id,relationship_annotation
${toIds.map(toId => `${fromId},${toId},"<describe how ${def.name} uses this dependency>"`).join('\n')}
\`\`\``;

          try {
            const response = await LLMist.complete(retryPrompt, {
              model: flags.model,
              systemPrompt: 'You are annotating code relationships. Provide clear, concise descriptions of how symbols are related.',
              temperature: 0,
            });

            // Parse response for relationship annotations
            const lines = response.split('\n');
            for (const line of lines) {
              const match = line.match(/^(\d+),(\d+),["']?(.+?)["']?$/);
              if (match) {
                const retryFromId = parseInt(match[1], 10);
                const retryToId = parseInt(match[2], 10);
                const value = match[3].trim();

                if (retryFromId === fromId && toIds.includes(retryToId) && value.length >= 5) {
                  db.setRelationshipAnnotation(retryFromId, retryToId, value);
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
      const finalCoverageData = db.getAspectCoverage({
        kind: flags.kind,
        filePattern: flags.file,
      });
      const totalSymbols = db.getFilteredDefinitionCount({
        kind: flags.kind,
        filePattern: flags.file,
      });
      const coverage = filterCoverageForAspects(finalCoverageData, aspects, totalSymbols);

      // Get final relationship coverage (handle missing table in older databases)
      let finalAnnotatedRels = 0;
      let finalUnannotatedRels = 0;
      try {
        finalAnnotatedRels = db.getRelationshipAnnotationCount();
        finalUnannotatedRels = db.getUnannotatedRelationshipCount();
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
        for (const line of formatFinalSummary(totalAnnotations, totalRelationshipAnnotations, totalErrors, iteration - 1, coverage, finalRelCoverage)) {
          this.log(line);
        }
      }
    } finally {
      db.close();
    }
  }

  /**
   * Enhance symbols with source code, dependency context, and relationships to annotate.
   */
  private async enhanceSymbols(
    db: IndexDatabase,
    symbols: ReadySymbolInfo[],
    aspects: string[],
    relationshipLimit: number,
  ): Promise<EnhancedSymbol[]> {
    const enhanced: EnhancedSymbol[] = [];

    for (const symbol of symbols) {
      const sourceCode = await readSourceAsString(symbol.filePath, symbol.line, symbol.endLine);

      // Get dependencies with all their metadata
      const deps = db.getDependenciesWithMetadata(symbol.id, aspects[0]);
      const dependencies: DependencyContextEnhanced[] = deps.map(dep => {
        // Get all metadata for this dependency
        const metadata = db.getDefinitionMetadata(dep.id);

        let domains: string[] | null = null;
        try {
          if (metadata['domain']) {
            domains = JSON.parse(metadata['domain']) as string[];
          }
        } catch { /* ignore */ }

        return {
          id: dep.id,
          name: dep.name,
          kind: dep.kind,
          filePath: dep.filePath,
          line: dep.line,
          purpose: metadata['purpose'] || null,
          domains,
          role: metadata['role'] || null,
          pure: metadata['pure'] ? metadata['pure'] === 'true' : null,
        };
      });

      // Get unannotated relationships from this symbol (handle missing table)
      let unannotatedRels: ReturnType<typeof db.getUnannotatedRelationships> = [];
      try {
        const limit = relationshipLimit > 0 ? relationshipLimit : undefined;
        unannotatedRels = db.getUnannotatedRelationships({ fromDefinitionId: symbol.id, limit });
      } catch {
        // Table doesn't exist - continue with empty relationships
      }
      // These are usage-based relationships (calls), so they're all 'uses' type
      const relationshipsToAnnotate: RelationshipToAnnotate[] = unannotatedRels.map(rel => ({
        toId: rel.toDefinitionId,
        toName: rel.toName,
        toKind: rel.toKind,
        usageLine: rel.fromLine, // Use fromLine as approximate usage location
        relationshipType: 'uses' as const,
      }));

      // Get incoming dependencies (who uses this symbol)
      const incomingDeps = db.getIncomingDependencies(symbol.id, 5);
      const incomingDependencyCount = db.getIncomingDependencyCount(symbol.id);
      const incomingDependencies: IncomingDependencyContext[] = incomingDeps.map(inc => ({
        id: inc.id,
        name: inc.name,
        kind: inc.kind,
        filePath: inc.filePath,
      }));

      // Get the definition to check if it's exported
      const defInfo = db.getDefinitionById(symbol.id);
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
  private validateValue(aspect: string, value: string): string | null {
    switch (aspect) {
      case 'domain':
        try {
          const parsed = JSON.parse(value);
          if (!Array.isArray(parsed)) {
            return 'domain must be a JSON array';
          }
          if (!parsed.every(d => typeof d === 'string')) {
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
