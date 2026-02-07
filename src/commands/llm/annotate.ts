import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LLMist } from 'llmist';
import { IndexDatabase, ReadySymbolInfo } from '../../db/database.js';
import { parseCombinedCsv } from './_shared/csv.js';
import {
  buildSystemPrompt,
  buildUserPromptEnhanced,
  SymbolContextEnhanced,
  DependencyContextEnhanced,
  RelationshipToAnnotate,
  CoverageInfo,
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
  dependencies: DependencyContextEnhanced[];
  relationshipsToAnnotate: RelationshipToAnnotate[];
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
    database: Flags.string({
      char: 'd',
      description: 'Path to the index database',
      default: 'index.db',
    }),
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
    json: Flags.boolean({
      description: 'Output as JSON',
      default: false,
    }),
    'show-llm-requests': Flags.boolean({
      description: 'Show full LLM requests (system + user prompts)',
      default: false,
    }),
    'show-llm-responses': Flags.boolean({
      description: 'Show full LLM responses',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Annotate);

    const dbPath = path.resolve(flags.database);

    // Check if database exists
    try {
      await fs.access(dbPath);
    } catch {
      this.error(chalk.red(`Database file "${dbPath}" does not exist.\nRun 'ats parse <directory>' first to create an index.`));
    }

    // Open database
    let db: IndexDatabase;
    try {
      db = new IndexDatabase(dbPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.error(chalk.red(`Failed to open database: ${message}`));
    }

    const aspects = flags.aspect;
    const primaryAspect = aspects[0]; // Use first aspect for readiness check
    const batchSize = flags['batch-size'];
    const maxIterations = flags['max-iterations'];
    const dryRun = flags['dry-run'];
    const isJson = flags.json;
    const showLlmRequests = flags['show-llm-requests'];
    const showLlmResponses = flags['show-llm-responses'];

    // Build system prompt once
    const systemPrompt = buildSystemPrompt(aspects);

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

        // Get batch of ready symbols
        const result = db.getReadyToUnderstandSymbols(primaryAspect, {
          limit: batchSize,
          kind: flags.kind,
          filePattern: flags.file,
        });

        if (result.symbols.length === 0) {
          if (result.totalReady === 0 && result.remaining === 0) {
            if (!isJson) {
              this.log(chalk.green(`All symbols have '${primaryAspect}' annotated!`));
            }
          } else if (result.totalReady === 0) {
            if (!isJson) {
              this.log(chalk.yellow(`No symbols ready for annotation.`));
              this.log(chalk.gray(`${result.remaining} symbols have unmet dependencies.`));
            }
          }
          break;
        }

        // Enhance symbols with source code and dependency context
        const enhancedSymbols = await this.enhanceSymbols(db, result.symbols, aspects);

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
          dependencies: s.dependencies,
          relationshipsToAnnotate: s.relationshipsToAnnotate,
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
            iterationRelResults.push({
              fromId,
              fromName: symbolNameById.get(fromId) || String(fromId),
              toId,
              toName: toMap.get(toId) || String(toId),
              value: row.value,
              success: false,
              error: 'Relationship description must be at least 5 characters',
            });
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

        // Get relationship coverage
        const annotatedRels = db.getRelationshipAnnotationCount();
        const unannotatedRels = db.getUnannotatedRelationshipCount();
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

      // Get final relationship coverage
      const finalAnnotatedRels = db.getRelationshipAnnotationCount();
      const finalUnannotatedRels = db.getUnannotatedRelationshipCount();
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
  ): Promise<EnhancedSymbol[]> {
    const enhanced: EnhancedSymbol[] = [];

    for (const symbol of symbols) {
      const sourceCode = await this.readSourceCode(symbol.filePath, symbol.line, symbol.endLine);

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

      // Get unannotated relationships from this symbol
      const unannotatedRels = db.getUnannotatedRelationships({ fromDefinitionId: symbol.id, limit: 50 });
      const relationshipsToAnnotate: RelationshipToAnnotate[] = unannotatedRels.map(rel => ({
        toId: rel.toDefinitionId,
        toName: rel.toName,
        toKind: rel.toKind,
        usageLine: rel.fromLine, // Use fromLine as approximate usage location
      }));

      enhanced.push({
        ...symbol,
        sourceCode,
        dependencies,
        relationshipsToAnnotate,
      });
    }

    return enhanced;
  }

  /**
   * Read source code for a symbol.
   */
  private async readSourceCode(filePath: string, startLine: number, endLine: number): Promise<string> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      return lines.slice(startLine - 1, endLine).join('\n');
    } catch {
      return '<source code not available>';
    }
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
