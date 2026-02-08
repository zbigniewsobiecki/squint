import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { LLMist } from 'llmist';
import { openDatabase, SharedFlags } from '../_shared/index.js';
import type { IndexDatabase } from '../../db/database.js';
import type { FlowCompositionRelationship } from '../../db/schema.js';
import {
  parseEntryPointClassification,
  parseFlowConstruction,
  parseGapFillSuggestions,
  type ClassifiedEntryPoint,
  type ParsedFlow,
} from './_shared/flow-csv.js';
import {
  FlowValidator,
  detectAndSuggestOverlapAction,
  type ValidationOptions,
} from './_shared/flow-validation.js';
import {
  buildEntryPointSystemPrompt,
  buildEntryPointUserPrompt,
  buildFlowConstructionSystemPrompt,
  buildFlowConstructionUserPrompt,
  buildGapFillingSystemPrompt,
  buildGapFillingUserPrompt,
  formatCoverageStats,
  type EntryPointCandidate,
  type FlowConstructionContext,
  type GapFillingContext,
} from './_shared/flow-prompts.js';

type PhaseType = 'all' | 'entry-points' | 'construct' | 'gaps';

interface FlowsResult {
  phase: PhaseType;
  entryPoints?: {
    total: number;
    topLevel: number;
    subflowCandidates: number;
    internal: number;
  };
  flows?: {
    created: number;
    subflows: number;
    composite: number;
    failed: number;
  };
  coverage?: {
    totalDefinitions: number;
    coveredByFlows: number;
    coveragePercentage: number;
    topLevelFlows: number;
    subFlows: number;
  };
  iterations?: number;
}

export default class Flows extends Command {
  static override description = 'Detect hierarchical execution flows using LLM-driven analysis';

  static override examples = [
    '<%= config.bin %> llm flows',
    '<%= config.bin %> llm flows --phase entry-points --dry-run',
    '<%= config.bin %> llm flows --target-coverage 80 --max-gap-iterations 5',
    '<%= config.bin %> llm flows --detect-subflows --min-subflow-reuse 3',
    '<%= config.bin %> llm flows --strict-edges=false --force',
  ];

  static override flags = {
    database: SharedFlags.database,

    // Phase control
    phase: Flags.string({
      description: 'Which phase to run',
      options: ['all', 'entry-points', 'construct', 'gaps'],
      default: 'all',
    }),

    // Hierarchy options
    'detect-subflows': Flags.boolean({
      description: 'Detect reusable sub-flow patterns',
      default: true,
    }),
    'min-subflow-reuse': Flags.integer({
      description: 'Minimum times a pattern must appear to be a sub-flow',
      default: 2,
    }),

    // Coverage targets
    'target-coverage': Flags.integer({
      description: 'Target symbol coverage percentage',
      default: 80,
    }),
    'max-gap-iterations': Flags.integer({
      description: 'Maximum gap-filling iterations',
      default: 10,
    }),

    // Validation strictness
    'strict-edges': Flags.boolean({
      description: 'Require call graph edge between all consecutive steps',
      default: true,
      allowNo: true,
    }),
    'allow-layer-skip': Flags.boolean({
      description: 'Allow flows that skip architectural layers',
      default: true,
      allowNo: true,
    }),
    'max-depth': Flags.integer({
      description: 'Maximum neighborhood traversal depth',
      default: 3,
    }),
    'max-nodes': Flags.integer({
      description: 'Maximum nodes in neighborhood context',
      default: 50,
    }),
    'min-steps': Flags.integer({
      description: 'Minimum steps for a valid flow',
      default: 2,
    }),

    // LLM options
    model: Flags.string({
      char: 'm',
      description: 'LLM model alias',
      default: 'sonnet',
    }),
    'batch-size': Flags.integer({
      description: 'Entry points per LLM batch',
      default: 5,
    }),
    'max-iterations': Flags.integer({
      description: 'Maximum LLM iterations per phase',
      default: 100,
    }),

    // Output options
    'dry-run': Flags.boolean({
      description: 'Show results without persisting',
      default: false,
    }),
    force: Flags.boolean({
      description: 'Re-detect even if flows exist',
      default: false,
    }),
    json: SharedFlags.json,
    verbose: Flags.boolean({
      description: 'Show detailed progress',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Flows);

    const db = await openDatabase(flags.database, this);
    const phase = flags.phase as PhaseType;
    const isJson = flags.json;
    const dryRun = flags['dry-run'];
    const verbose = flags.verbose;

    const validationOptions: ValidationOptions = {
      strictEdges: flags['strict-edges'],
      allowLayerSkip: flags['allow-layer-skip'],
      maxCompositionDepth: 3,
      minStepCount: flags['min-steps'],
    };

    try {
      // Check if flows already exist
      const existingFlowCount = db.getFlowCount();
      if (existingFlowCount > 0 && !flags.force) {
        if (isJson) {
          this.log(JSON.stringify({
            error: 'Flows already exist',
            flowCount: existingFlowCount,
            hint: 'Use --force to re-detect',
          }));
        } else {
          this.log(chalk.yellow(`${existingFlowCount} flows already exist.`));
          this.log(chalk.gray('Use --force to re-detect flows.'));
        }
        return;
      }

      if (!isJson) {
        this.log(chalk.bold('LLM-Driven Flow Detection'));
        this.log(chalk.gray(`Phase: ${phase}, Model: ${flags.model}`));
        this.log('');
      }

      // Clear existing flows if force
      if (existingFlowCount > 0 && flags.force && !dryRun) {
        db.clearFlows();
        if (!isJson && verbose) {
          this.log(chalk.gray(`Cleared ${existingFlowCount} existing flows`));
        }
      }

      const result: FlowsResult = { phase };

      // Phase 1: Entry Point Classification
      if (phase === 'all' || phase === 'entry-points') {
        if (!isJson) {
          this.log(chalk.bold('Phase 1: Entry Point Classification'));
        }

        const classifiedEntries = await this.runPhase1(db, flags, isJson, verbose);
        result.entryPoints = {
          total: classifiedEntries.length,
          topLevel: classifiedEntries.filter(e => e.classification === 'top_level').length,
          subflowCandidates: classifiedEntries.filter(e => e.classification === 'subflow_candidate').length,
          internal: classifiedEntries.filter(e => e.classification === 'internal').length,
        };

        if (phase === 'entry-points') {
          if (isJson) {
            this.log(JSON.stringify({ ...result, entries: classifiedEntries }, null, 2));
          }
          return;
        }

        // Store classifications for Phase 2
        if (!dryRun) {
          for (const entry of classifiedEntries) {
            db.setDefinitionMetadata(entry.id, 'flow_classification', entry.classification);
            db.setDefinitionMetadata(entry.id, 'flow_classification_confidence', entry.confidence);
          }
        }
      }

      // Phase 2: Flow Construction
      if (phase === 'all' || phase === 'construct') {
        if (!isJson) {
          this.log('');
          this.log(chalk.bold('Phase 2: Flow Construction'));
        }

        const flowResult = await this.runPhase2(db, flags, validationOptions, isJson, verbose, dryRun);
        result.flows = flowResult;
      }

      // Phase 3: Gap Filling
      if (phase === 'all' || phase === 'gaps') {
        if (!isJson) {
          this.log('');
          this.log(chalk.bold('Phase 3: Gap Filling'));
        }

        const gapResult = await this.runPhase3(db, flags, validationOptions, isJson, verbose, dryRun);
        result.iterations = gapResult.iterations;
      }

      // Final coverage statistics
      const coverage = db.getFlowCoverageStats();
      result.coverage = {
        totalDefinitions: coverage.totalDefinitions,
        coveredByFlows: coverage.coveredByFlows,
        coveragePercentage: coverage.coveragePercentage,
        topLevelFlows: coverage.topLevelFlows,
        subFlows: coverage.subFlows,
      };

      if (isJson) {
        this.log(JSON.stringify(result, null, 2));
      } else {
        this.log('');
        this.log(chalk.bold('Final Results'));
        this.log(formatCoverageStats(coverage));
      }
    } finally {
      db.close();
    }
  }

  /**
   * Phase 1: Entry Point Classification
   */
  private async runPhase1(
    db: IndexDatabase,
    flags: Record<string, unknown>,
    isJson: boolean,
    verbose: boolean
  ): Promise<ClassifiedEntryPoint[]> {
    // Get entry point candidates
    const heuristicEntries = db.getEntryPoints();
    const highConnectivity = db.getHighConnectivitySymbols({
      minIncoming: 0,
      exported: true,
      limit: 100,
    });

    // Combine and deduplicate
    const candidateIds = new Set<number>();
    const candidates: EntryPointCandidate[] = [];

    for (const ep of heuristicEntries) {
      if (candidateIds.has(ep.id)) continue;
      candidateIds.add(ep.id);

      const metadata = db.getDefinitionMetadata(ep.id);
      let domains: string[] | null = null;
      if (metadata['domain']) {
        try {
          domains = JSON.parse(metadata['domain']);
        } catch { /* ignore */ }
      }

      const hc = highConnectivity.find(h => h.id === ep.id);
      candidates.push({
        id: ep.id,
        name: ep.name,
        kind: ep.kind,
        filePath: ep.filePath,
        incomingDeps: hc?.incomingDeps ?? 0,
        outgoingDeps: hc?.outgoingDeps ?? 0,
        purpose: metadata['purpose'] ?? null,
        domain: domains,
        role: metadata['role'] ?? null,
      });
    }

    // Add high-connectivity symbols not already included
    for (const hc of highConnectivity) {
      if (candidateIds.has(hc.id)) continue;
      if (hc.outgoingDeps < 3) continue; // Skip low outgoing

      candidateIds.add(hc.id);
      const metadata = db.getDefinitionMetadata(hc.id);
      let domains: string[] | null = null;
      if (metadata['domain']) {
        try {
          domains = JSON.parse(metadata['domain']);
        } catch { /* ignore */ }
      }

      candidates.push({
        id: hc.id,
        name: hc.name,
        kind: hc.kind,
        filePath: hc.filePath,
        incomingDeps: hc.incomingDeps,
        outgoingDeps: hc.outgoingDeps,
        purpose: metadata['purpose'] ?? null,
        domain: domains,
        role: metadata['role'] ?? null,
      });
    }

    if (!isJson && verbose) {
      this.log(chalk.gray(`  Found ${candidates.length} entry point candidates`));
    }

    if (candidates.length === 0) {
      if (!isJson) {
        this.log(chalk.yellow('  No entry point candidates found'));
      }
      return [];
    }

    // Call LLM for classification
    const systemPrompt = buildEntryPointSystemPrompt();
    const allClassified: ClassifiedEntryPoint[] = [];
    const batchSize = flags['batch-size'] as number;
    const maxIterations = flags['max-iterations'] as number;
    const model = flags.model as string;

    let iteration = 0;
    for (let i = 0; i < candidates.length && iteration < maxIterations; i += batchSize) {
      iteration++;
      const batch = candidates.slice(i, i + batchSize);
      const userPrompt = buildEntryPointUserPrompt(batch);

      try {
        const response = await LLMist.complete(userPrompt, {
          model,
          systemPrompt,
          temperature: 0,
        });

        const { entries, errors } = parseEntryPointClassification(response);

        if (errors.length > 0 && verbose && !isJson) {
          for (const err of errors) {
            this.log(chalk.yellow(`  Parse warning: ${err}`));
          }
        }

        allClassified.push(...entries);

        if (!isJson && verbose) {
          this.log(chalk.gray(`  Batch ${iteration}: Classified ${entries.length} entries`));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isJson) {
          this.log(chalk.yellow(`  Batch ${iteration} failed: ${message}`));
        }
      }
    }

    if (!isJson) {
      const topLevel = allClassified.filter(e => e.classification === 'top_level').length;
      const subflow = allClassified.filter(e => e.classification === 'subflow_candidate').length;
      this.log(chalk.gray(`  Classified: ${topLevel} top-level, ${subflow} sub-flow candidates`));
    }

    return allClassified;
  }

  /**
   * Phase 2: Flow Construction
   */
  private async runPhase2(
    db: IndexDatabase,
    flags: Record<string, unknown>,
    validationOptions: ValidationOptions,
    isJson: boolean,
    verbose: boolean,
    dryRun: boolean
  ): Promise<{ created: number; subflows: number; composite: number; failed: number }> {
    const model = flags.model as string;
    const batchSize = flags['batch-size'] as number;
    const maxIterations = flags['max-iterations'] as number;
    const maxDepth = flags['max-depth'] as number;
    const maxNodes = flags['max-nodes'] as number;
    const detectSubflows = flags['detect-subflows'] as boolean;

    const validator = new FlowValidator(db, validationOptions);

    // Get entry points to process
    // First try to get classified entry points, fall back to heuristic
    let entryPoints = db.getEntryPoints();

    // Filter to only top-level (if we have classifications)
    const topLevelIds = new Set<number>();
    const subflowIds = new Set<number>();

    for (const ep of entryPoints) {
      const classification = db.getDefinitionMetadataValue(ep.id, 'flow_classification');
      if (classification === 'top_level' || classification === null) {
        topLevelIds.add(ep.id);
      } else if (classification === 'subflow_candidate') {
        subflowIds.add(ep.id);
      }
    }

    // Process sub-flow candidates first (if enabled)
    const createdSubflows: string[] = [];
    if (detectSubflows && subflowIds.size > 0) {
      if (!isJson && verbose) {
        this.log(chalk.gray(`  Processing ${subflowIds.size} sub-flow candidates...`));
      }

      const subflowEntries = entryPoints.filter(ep => subflowIds.has(ep.id));
      const subflowFlows = await this.constructFlows(
        db,
        subflowEntries,
        model,
        batchSize,
        maxIterations,
        maxDepth,
        maxNodes,
        validator,
        [],
        isJson,
        verbose
      );

      // Persist sub-flows
      for (const flow of subflowFlows.valid) {
        if (!dryRun) {
          this.persistFlow(db, flow, true);
          createdSubflows.push(flow.name);
          if (verbose && !isJson) {
            this.log(chalk.gray(`    Created sub-flow: ${flow.name} (${flow.steps.length} steps)`));
          }
        } else {
          createdSubflows.push(flow.name);
        }
      }
    }

    // Process top-level flows
    const topLevelEntries = entryPoints.filter(ep => topLevelIds.has(ep.id));
    if (!isJson && verbose) {
      this.log(chalk.gray(`  Processing ${topLevelEntries.length} top-level entry points...`));
    }

    const topLevelFlows = await this.constructFlows(
      db,
      topLevelEntries,
      model,
      batchSize,
      maxIterations,
      maxDepth,
      maxNodes,
      validator,
      createdSubflows,
      isJson,
      verbose
    );

    // Persist top-level flows
    let created = createdSubflows.length;
    let composite = 0;

    for (const flow of topLevelFlows.valid) {
      // Check for overlap
      const overlap = detectAndSuggestOverlapAction(flow, db);
      if (overlap.suggestion === 'skip') {
        if (verbose && !isJson) {
          this.log(chalk.gray(`    Skipping duplicate flow: ${flow.name}`));
        }
        continue;
      }

      if (!dryRun) {
        this.persistFlow(db, flow, false);
        created++;
        if (flow.isComposite) composite++;

        if (verbose && !isJson) {
          const compStr = flow.isComposite ? ' (composite)' : '';
          this.log(chalk.gray(`    Created flow: ${flow.name}${compStr} (${flow.steps.length} steps)`));
        }
      } else {
        created++;
        if (flow.isComposite) composite++;
      }
    }

    if (!isJson) {
      this.log(chalk.gray(`  Created ${created} flows (${createdSubflows.length} sub-flows, ${composite} composite)`));
      if (topLevelFlows.failed > 0) {
        this.log(chalk.yellow(`  ${topLevelFlows.failed} flows failed validation`));
      }
    }

    return {
      created,
      subflows: createdSubflows.length,
      composite,
      failed: topLevelFlows.failed,
    };
  }

  /**
   * Construct flows from entry points using LLM.
   */
  private async constructFlows(
    db: IndexDatabase,
    entryPoints: Array<{ id: number; name: string; kind: string; filePath: string }>,
    model: string,
    batchSize: number,
    maxIterations: number,
    maxDepth: number,
    maxNodes: number,
    validator: FlowValidator,
    existingSubflows: string[],
    isJson: boolean,
    verbose: boolean
  ): Promise<{ valid: ParsedFlow[]; failed: number }> {
    const validFlows: ParsedFlow[] = [];
    let failedCount = 0;

    const systemPrompt = buildFlowConstructionSystemPrompt();
    const existingFlows = db.getFlows().map(f => ({
      id: f.id,
      name: f.name,
      description: f.description,
      entryPointId: f.entryPointId,
    }));

    let iteration = 0;
    for (let i = 0; i < entryPoints.length && iteration < maxIterations; i += batchSize) {
      iteration++;
      const batch = entryPoints.slice(i, i + batchSize);

      // Build context for each entry point
      const contexts: FlowConstructionContext[] = [];
      for (const ep of batch) {
        const neighborhood = db.getCallGraphNeighborhood(ep.id, maxDepth, maxNodes);
        const entryInfo = neighborhood.nodes.find(n => n.id === ep.id);

        if (!entryInfo) continue;

        contexts.push({
          entryPoint: entryInfo,
          neighborhood,
          existingFlows,
          existingSubflows,
        });
      }

      if (contexts.length === 0) continue;

      const userPrompt = buildFlowConstructionUserPrompt(contexts);

      try {
        const response = await LLMist.complete(userPrompt, {
          model,
          systemPrompt,
          temperature: 0,
        });

        const { flows, errors } = parseFlowConstruction(response);

        if (errors.length > 0 && verbose && !isJson) {
          for (const err of errors.slice(0, 5)) {
            this.log(chalk.yellow(`    Parse warning: ${err}`));
          }
        }

        // Validate flows
        const validationResults = validator.validateBatch(flows);
        for (const flow of flows) {
          const result = validationResults.get(flow.id);
          if (result?.valid) {
            validFlows.push(flow);
          } else {
            failedCount++;
            if (verbose && !isJson && result) {
              for (const err of result.errors.slice(0, 3)) {
                this.log(chalk.yellow(`    Validation error: ${err.message}`));
              }
            }
          }
        }

        if (verbose && !isJson) {
          this.log(chalk.gray(`    Batch ${iteration}: ${flows.length} flows, ${validFlows.length} valid`));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isJson) {
          this.log(chalk.yellow(`    Batch ${iteration} failed: ${message}`));
        }
        failedCount += batch.length;
      }
    }

    return { valid: validFlows, failed: failedCount };
  }

  /**
   * Phase 3: Gap Filling
   */
  private async runPhase3(
    db: IndexDatabase,
    flags: Record<string, unknown>,
    _validationOptions: ValidationOptions,
    isJson: boolean,
    verbose: boolean,
    _dryRun: boolean
  ): Promise<{ iterations: number }> {
    const model = flags.model as string;
    const targetCoverage = flags['target-coverage'] as number;
    const maxGapIterations = flags['max-gap-iterations'] as number;

    const systemPrompt = buildGapFillingSystemPrompt();
    let iteration = 0;

    while (iteration < maxGapIterations) {
      iteration++;

      // Check current coverage
      const coverage = db.getFlowCoverageStats();
      if (coverage.coveragePercentage >= targetCoverage) {
        if (!isJson && verbose) {
          this.log(chalk.gray(`  Target coverage ${targetCoverage}% reached (${coverage.coveragePercentage.toFixed(1)}%)`));
        }
        break;
      }

      // Get uncovered symbols
      const uncovered = db.getSymbolsNotInFlows({ minDeps: 3 });
      if (uncovered.length === 0) {
        if (!isJson && verbose) {
          this.log(chalk.gray('  No more symbols to cover'));
        }
        break;
      }

      // Build context
      const existingFlows = db.getAllFlowsWithSteps().map(f => ({
        id: f.id,
        name: f.name,
        description: f.description,
        stepCount: f.steps.length,
      }));

      const context: GapFillingContext = {
        uncoveredSymbols: uncovered.slice(0, 30).map(s => {
          const metadata = db.getDefinitionMetadata(s.id);
          let domains: string[] | null = null;
          if (metadata['domain']) {
            try {
              domains = JSON.parse(metadata['domain']);
            } catch { /* ignore */ }
          }
          return {
            ...s,
            purpose: metadata['purpose'] ?? null,
            domain: domains,
            role: metadata['role'] ?? null,
          };
        }),
        existingFlows,
        coverageStats: {
          covered: coverage.coveredByFlows,
          total: coverage.totalDefinitions,
          percentage: coverage.coveragePercentage,
        },
      };

      const userPrompt = buildGapFillingUserPrompt(context);

      try {
        const response = await LLMist.complete(userPrompt, {
          model,
          systemPrompt,
          temperature: 0,
        });

        const { suggestions, errors } = parseGapFillSuggestions(response);

        if (errors.length > 0 && verbose && !isJson) {
          for (const err of errors.slice(0, 3)) {
            this.log(chalk.yellow(`    Parse warning: ${err}`));
          }
        }

        if (suggestions.length === 0) {
          if (!isJson && verbose) {
            this.log(chalk.gray(`  Iteration ${iteration}: No suggestions`));
          }
          break;
        }

        // Process suggestions (simplified - just log for now)
        if (!isJson && verbose) {
          this.log(chalk.gray(`  Iteration ${iteration}: ${suggestions.length} suggestions`));
          for (const s of suggestions.slice(0, 5)) {
            this.log(chalk.gray(`    - ${s.type}: symbol ${s.symbolId} - ${s.reason}`));
          }
        }

        // TODO: Implement suggestion processing
        // For now, we break after first iteration to avoid infinite loops
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isJson) {
          this.log(chalk.yellow(`  Gap fill iteration ${iteration} failed: ${message}`));
        }
        break;
      }
    }

    if (!isJson) {
      const finalCoverage = db.getFlowCoverageStats();
      this.log(chalk.gray(`  Final coverage: ${finalCoverage.coveragePercentage.toFixed(1)}%`));
    }

    return { iterations: iteration };
  }

  /**
   * Persist a flow to the database.
   */
  private persistFlow(db: IndexDatabase, flow: ParsedFlow, isSubflow: boolean): number {
    // Get entry point ID from first definition step
    let entryPointId: number | undefined;
    for (const step of flow.steps) {
      if (step.type === 'definition' && step.id) {
        entryPointId = step.id;
        break;
      }
    }

    if (!entryPointId) {
      throw new Error(`Flow ${flow.name} has no entry point`);
    }

    // Insert flow
    const flowId = db.insertFlow(
      flow.name,
      entryPointId,
      flow.description,
      flow.domain ?? undefined
    );

    // Set metadata
    if (isSubflow) {
      db.setFlowMetadata(flowId, 'is_subflow', 'true');
    }
    if (flow.isComposite) {
      db.setFlowMetadata(flowId, 'is_composite', 'true');
    }

    // Add steps
    const subflowSteps: Array<{ order: number; flowName: string }> = [];

    for (const step of flow.steps) {
      if (step.type === 'definition' && step.id) {
        const module = db.getDefinitionModule(step.id);
        db.addFlowStep(
          flowId,
          step.order,
          step.id,
          module?.module.id,
          undefined // Layer is no longer part of module tree
        );
      } else if (step.type === 'subflow' && step.flowName) {
        // Track for later composition insertion
        subflowSteps.push({ order: step.order, flowName: step.flowName });

        // Add a placeholder step (using the subflow's entry point)
        const subflowDb = db.getFlows().find(f => f.name === step.flowName);
        if (subflowDb) {
          const module = db.getDefinitionModule(subflowDb.entryPointId);
          db.addFlowStep(
            flowId,
            step.order,
            subflowDb.entryPointId,
            module?.module.id,
            undefined // Layer is no longer part of module tree
          );
        }
      }
    }

    // Insert compositions
    for (const { order, flowName } of subflowSteps) {
      const subflowDb = db.getFlows().find(f => f.name === flowName);
      if (subflowDb) {
        const reason = flow.subflowReasons.get(order);
        db.insertFlowComposition(
          flowId,
          subflowDb.id,
          order,
          'includes' as FlowCompositionRelationship,
          reason
        );
      }
    }

    return flowId;
  }
}
