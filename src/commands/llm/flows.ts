import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { LLMist } from 'llmist';
import { openDatabase, SharedFlags } from '../_shared/index.js';
import { buildFlowSystemPrompt, buildFlowUserPrompt, FlowCandidate } from './_shared/prompts.js';

interface ParsedFlowAnnotation {
  flowId: number;
  name: string;
  description: string;
}

/**
 * Parse LLM response for flow annotations.
 */
function parseFlowAnnotations(response: string): ParsedFlowAnnotation[] {
  const annotations: ParsedFlowAnnotation[] = [];

  // Look for CSV-like format
  const lines = response.split('\n');
  let inCsv = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('flow_id,') || trimmed.startsWith('```csv')) {
      inCsv = true;
      continue;
    }

    if (trimmed === '```' && inCsv) {
      break;
    }

    if (inCsv && trimmed && !trimmed.startsWith('flow_id')) {
      // Parse CSV line: flow_id,name,description
      const match = trimmed.match(/^(\d+),([^,]+),(.*)$/);
      if (match) {
        annotations.push({
          flowId: parseInt(match[1], 10),
          name: match[2].trim(),
          description: match[3].trim().replace(/^"|"$/g, ''),
        });
      }
    }
  }

  return annotations;
}

export default class Flows extends Command {
  static override description = 'Detect end-to-end execution flows from entry points through the system';

  static override examples = [
    '<%= config.bin %> llm flows',
    '<%= config.bin %> llm flows --min-steps 3 --max-depth 10',
    '<%= config.bin %> llm flows --domain sales --dry-run',
    '<%= config.bin %> llm flows --from SalesController --skip-llm',
    '<%= config.bin %> llm flows --force',
  ];

  static override flags = {
    database: SharedFlags.database,
    'min-steps': Flags.integer({
      description: 'Minimum steps for a valid flow',
      default: 2,
    }),
    'max-depth': Flags.integer({
      description: 'Maximum traversal depth',
      default: 15,
    }),
    domain: Flags.string({
      description: 'Only detect flows in a specific domain',
    }),
    from: Flags.string({
      description: 'Start from a specific entry point (name pattern)',
    }),
    'dry-run': Flags.boolean({
      description: 'Show detected flows without persisting',
      default: false,
    }),
    force: Flags.boolean({
      description: 'Re-detect even if flows exist',
      default: false,
    }),
    model: Flags.string({
      char: 'm',
      description: 'LLM model alias for flow naming',
      default: 'sonnet',
    }),
    'skip-llm': Flags.boolean({
      description: 'Skip LLM naming pass (use auto-generated names)',
      default: false,
    }),
    'max-iterations': Flags.integer({
      description: 'Maximum LLM naming iterations (batches of 10 flows)',
      default: 100,
    }),
    'batch-size': Flags.integer({
      description: 'Flows per LLM naming batch',
      default: 10,
    }),
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Flows);

    const db = await openDatabase(flags.database, this);
    const dryRun = flags['dry-run'];
    const minSteps = flags['min-steps'];
    const maxDepth = flags['max-depth'];
    const isJson = flags.json;
    const skipLlm = flags['skip-llm'];
    const domainFilter = flags.domain;
    const fromFilter = flags.from;

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
        this.log(chalk.bold('Flow Detection'));
        this.log(chalk.gray(`Max depth: ${maxDepth}, Min steps: ${minSteps}`));
        if (domainFilter) {
          this.log(chalk.gray(`Domain filter: ${domainFilter}`));
        }
        if (fromFilter) {
          this.log(chalk.gray(`Entry point filter: ${fromFilter}`));
        }
        this.log('');
      }

      // Step 1: Find entry points
      if (!isJson) {
        this.log('Finding entry points...');
      }
      let entryPoints = db.getEntryPoints();

      if (entryPoints.length === 0) {
        if (isJson) {
          this.log(JSON.stringify({ error: 'No entry points found' }));
        } else {
          this.log(chalk.yellow('No entry points found.'));
          this.log(chalk.gray('Entry points are identified by:'));
          this.log(chalk.gray('  - role=controller metadata'));
          this.log(chalk.gray('  - Names containing "Controller" or "Handler"'));
          this.log(chalk.gray('  - Exported functions in routes/controllers/handlers directories'));
        }
        return;
      }

      // Apply filters
      if (domainFilter) {
        entryPoints = entryPoints.filter(ep => ep.domain === domainFilter);
      }
      if (fromFilter) {
        entryPoints = entryPoints.filter(ep =>
          ep.name.toLowerCase().includes(fromFilter.toLowerCase())
        );
      }

      if (!isJson) {
        this.log(chalk.gray(`  Found ${entryPoints.length} entry points`));
      }

      if (entryPoints.length === 0) {
        if (isJson) {
          this.log(JSON.stringify({ error: 'No matching entry points found', filters: { domain: domainFilter, from: fromFilter } }));
        } else {
          this.log(chalk.yellow('No entry points match the specified filters.'));
        }
        return;
      }

      // Step 2: Trace flows from each entry point
      if (!isJson) {
        this.log('Tracing execution flows...');
      }

      const candidates: FlowCandidate[] = [];

      for (const entryPoint of entryPoints) {
        const trace = db.traceFlowFromEntry(entryPoint.id, maxDepth);

        // Filter by minimum steps
        if (trace.length < minSteps) {
          continue;
        }

        // Get definition details for each step
        const steps: Array<{
          definitionId: number;
          name: string;
          kind: string;
          filePath: string;
          depth: number;
          moduleId: number | null;
          moduleName: string | null;
          layer: string | null;
        }> = [];

        // Collect unique modules for the flow
        const moduleNames = new Set<string>();

        for (const step of trace) {
          const def = db.getDefinitionById(step.definitionId);
          if (!def) continue;

          let moduleName: string | null = null;
          if (step.moduleId) {
            const moduleInfo = db.getModuleWithMembers(step.moduleId);
            if (moduleInfo) {
              moduleName = moduleInfo.name;
              moduleNames.add(moduleName);
            }
          }

          steps.push({
            definitionId: step.definitionId,
            name: def.name,
            kind: def.kind,
            filePath: def.filePath,
            depth: step.depth,
            moduleId: step.moduleId,
            moduleName,
            layer: step.layer,
          });
        }

        // Determine dominant domains
        const domainCounts = new Map<string, number>();
        for (const step of steps) {
          const metadata = db.getDefinitionMetadata(step.definitionId);
          if (metadata['domain']) {
            try {
              const domains = JSON.parse(metadata['domain']) as string[];
              for (const d of domains) {
                domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
              }
            } catch { /* ignore */ }
          }
        }

        const dominantDomains = Array.from(domainCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([d]) => d);

        candidates.push({
          id: candidates.length + 1,
          entryPointId: entryPoint.id,
          entryPointName: entryPoint.name,
          entryPointKind: entryPoint.kind,
          entryPointFilePath: entryPoint.filePath,
          steps,
          modulesCrossed: Array.from(moduleNames),
          dominantDomains,
        });
      }

      if (!isJson) {
        this.log(chalk.gray(`  Detected ${candidates.length} flows with >= ${minSteps} steps`));
      }

      if (candidates.length === 0) {
        if (isJson) {
          this.log(JSON.stringify({
            flows: [],
            message: `No flows detected with >= ${minSteps} steps`,
          }));
        } else {
          this.log(chalk.yellow(`No flows detected with >= ${minSteps} steps.`));
        }
        return;
      }

      // Step 3: LLM naming pass (if not skipped)
      let annotations: ParsedFlowAnnotation[] = [];
      const maxIterations = flags['max-iterations'];
      const batchSize = flags['batch-size'];

      if (!skipLlm) {
        if (!isJson) {
          this.log('Generating flow names with LLM...');
        }

        const systemPrompt = buildFlowSystemPrompt();

        // Process in batches
        let iteration = 0;
        for (let i = 0; i < candidates.length && iteration < maxIterations; i += batchSize) {
          iteration++;
          const batch = candidates.slice(i, i + batchSize);
          const userPrompt = buildFlowUserPrompt(batch);

          try {
            const response = await LLMist.complete(userPrompt, {
              model: flags.model,
              systemPrompt,
              temperature: 0,
            });

            const batchAnnotations = parseFlowAnnotations(response);
            annotations.push(...batchAnnotations);

            if (!isJson && batchAnnotations.length > 0) {
              this.log(chalk.gray(`  Batch ${iteration}: Named ${batchAnnotations.length} flows`));
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!isJson) {
              this.log(chalk.yellow(`  Batch ${iteration} failed: ${message}`));
            }
          }
        }

        if (!isJson && annotations.length > 0) {
          this.log(chalk.gray(`  Total: ${annotations.length} flows named`));
        }
      }

      // Step 4: Persist or display
      if (dryRun) {
        if (isJson) {
          this.log(JSON.stringify({
            flowCount: candidates.length,
            flows: candidates.map(c => {
              const annotation = annotations.find(a => a.flowId === c.id);
              return {
                id: c.id,
                name: annotation?.name ?? `Flow_${c.entryPointName}`,
                description: annotation?.description ?? null,
                entryPoint: {
                  id: c.entryPointId,
                  name: c.entryPointName,
                  kind: c.entryPointKind,
                  filePath: c.entryPointFilePath,
                },
                stepCount: c.steps.length,
                modulesCrossed: c.modulesCrossed,
                dominantDomains: c.dominantDomains,
                steps: c.steps.map((s, i) => ({
                  order: i + 1,
                  name: s.name,
                  kind: s.kind,
                  layer: s.layer,
                  module: s.moduleName,
                })),
              };
            }),
          }, null, 2));
        } else {
          this.log('');
          this.log(chalk.bold('Detected Flows (dry run)'));
          this.log('');

          for (const c of candidates) {
            const annotation = annotations.find(a => a.flowId === c.id);
            const name = annotation?.name ?? `Flow_${c.entryPointName}`;

            this.log(chalk.bold(`Flow: ${name}`));
            if (c.dominantDomains.length > 0) {
              this.log(chalk.gray(`  Domain: ${c.dominantDomains[0]}`));
            }
            this.log(chalk.gray(`  Entry: ${c.entryPointName} (${c.entryPointKind})`));
            if (annotation?.description) {
              this.log(chalk.gray(`  ${annotation.description}`));
            }
            this.log('');
            this.log(chalk.gray('  Steps:'));
            for (let i = 0; i < c.steps.length; i++) {
              const step = c.steps[i];
              const layerStr = step.layer ? ` (${step.layer})` : '';
              this.log(chalk.gray(`    ${i + 1}. ${step.name}${layerStr}`));
            }
            if (c.modulesCrossed.length > 0) {
              this.log('');
              this.log(chalk.gray(`  Modules crossed: ${c.modulesCrossed.join(' → ')}`));
            }
            this.log('');
          }
        }
      } else {
        // Clear existing flows if force
        if (existingFlowCount > 0 && flags.force) {
          db.clearFlows();
          if (!isJson) {
            this.log(chalk.gray(`  Cleared ${existingFlowCount} existing flows`));
          }
        }

        // Insert flows
        for (const c of candidates) {
          const annotation = annotations.find(a => a.flowId === c.id);
          const name = annotation?.name ?? `Flow_${c.entryPointName}`;
          const domain = c.dominantDomains[0] ?? null;

          const flowId = db.insertFlow(
            name,
            c.entryPointId,
            annotation?.description,
            domain
          );

          // Add steps
          for (let i = 0; i < c.steps.length; i++) {
            const step = c.steps[i];
            db.addFlowStep(
              flowId,
              i + 1,
              step.definitionId,
              step.moduleId ?? undefined,
              step.layer ?? undefined
            );
          }
        }

        if (isJson) {
          const stats = db.getFlowStats();
          this.log(JSON.stringify(stats));
        } else {
          const stats = db.getFlowStats();
          this.log('');
          this.log(chalk.green(`Created ${stats.flowCount} flows`));
          this.log(chalk.gray(`  Total steps: ${stats.totalSteps}`));
          this.log(chalk.gray(`  Avg steps per flow: ${stats.avgStepsPerFlow.toFixed(1)}`));
          this.log(chalk.gray(`  Modules covered: ${stats.modulesCovered}`));
        }
      }
    } finally {
      db.close();
    }
  }
}
