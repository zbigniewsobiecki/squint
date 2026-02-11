import fs from 'node:fs';
import path from 'node:path';
import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import Parse from './parse.js';
import SymbolsAnnotate from './symbols/annotate.js';
import SymbolsVerify from './symbols/verify.js';
import RelationshipsAnnotate from './relationships/annotate.js';
import RelationshipsVerify from './relationships/verify.js';
import ModulesGenerate from './modules/generate.js';
import ModulesVerify from './modules/verify.js';
import InteractionsGenerate from './interactions/generate.js';
import InteractionsVerify from './interactions/verify.js';
import FlowsGenerate from './flows/generate.js';
import FlowsVerify from './flows/verify.js';
import FeaturesGenerate from './features/generate.js';

interface Stage {
  id: string;
  label: string;
  run: () => Promise<unknown>;
}

const STAGE_IDS = [
  'parse',
  'symbols',
  'symbols-verify',
  'relationships',
  'relationships-verify',
  'modules',
  'modules-verify',
  'interactions',
  'interactions-verify',
  'flows',
  'flows-verify',
  'features',
] as const;

type StageId = (typeof STAGE_IDS)[number];

export default class Ingest extends Command {
  static override description = 'Run the full analysis pipeline: parse, annotate, verify, and generate modules/interactions/flows/features';

  static override examples = [
    '<%= config.bin %> ingest ./src',
    '<%= config.bin %> ingest ./src --model openrouter:google/gemini-2.5-flash',
    '<%= config.bin %> ingest ./src --from-stage relationships',
    '<%= config.bin %> ingest ./src --to-stage symbols-verify --dry-run',
  ];

  static override args = {
    directory: Args.string({
      description: 'Codebase directory to analyze',
      required: true,
    }),
  };

  static override flags = {
    output: Flags.string({
      char: 'o',
      description: 'Database file path (default: <directory>/.squint.db)',
    }),
    model: Flags.string({
      char: 'm',
      description: 'LLM model alias',
      default: 'openrouter:google/gemini-2.5-flash',
    }),
    'batch-size': Flags.integer({
      char: 'b',
      description: 'Batch size for annotation stages',
      default: 40,
    }),
    'max-iterations': Flags.integer({
      description: 'Max iterations for annotation stages',
      default: 80,
    }),
    verbose: Flags.boolean({
      description: 'Verbose output',
      default: false,
    }),
    'dry-run': Flags.boolean({
      description: "Don't persist LLM results",
      default: false,
    }),
    force: Flags.boolean({
      description: 'Re-run stages even if data exists',
      default: false,
    }),
    'show-llm-requests': Flags.boolean({
      description: 'Show full LLM request prompts',
      default: false,
    }),
    'show-llm-responses': Flags.boolean({
      description: 'Show full LLM responses',
      default: false,
    }),
    'from-stage': Flags.string({
      description: 'Resume from a specific stage (skips earlier stages)',
      options: [...STAGE_IDS],
    }),
    'to-stage': Flags.string({
      description: 'Stop after a specific stage',
      options: [...STAGE_IDS],
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Ingest);

    const directory = path.resolve(args.directory);
    const dbPath = flags.output ? path.resolve(flags.output) : path.join(directory, '.squint.db');
    const model = flags.model!;
    const batchSize = String(flags['batch-size']!);
    const maxIterations = String(flags['max-iterations']!);
    const fromStage = flags['from-stage'] as StageId | undefined;
    const toStage = flags['to-stage'] as StageId | undefined;

    // Build common flag arrays
    const llmFlags = ['--model', model, '-d', dbPath];
    const debugFlags: string[] = [];
    if (flags['show-llm-requests']) debugFlags.push('--show-llm-requests');
    if (flags['show-llm-responses']) debugFlags.push('--show-llm-responses');
    if (flags.verbose) llmFlags.push('--verbose');
    if (flags['dry-run']) llmFlags.push('--dry-run');
    if (flags.force) llmFlags.push('--force');

    const stages: Stage[] = [
      {
        id: 'parse',
        label: 'Parse codebase',
        run: () => Parse.run([directory, '-o', dbPath]),
      },
      {
        id: 'symbols',
        label: 'Annotate symbols',
        run: () => SymbolsAnnotate.run([
          '--aspect', 'purpose', '--aspect', 'domain', '--aspect', 'pure',
          '--batch-size', batchSize, '--max-iterations', maxIterations,
          ...llmFlags, ...debugFlags,
        ]),
      },
      {
        id: 'symbols-verify',
        label: 'Verify symbols',
        run: () => SymbolsVerify.run([
          '--aspect', 'purpose', '--aspect', 'domain', '--aspect', 'pure',
          '--fix', ...llmFlags, ...debugFlags,
        ]),
      },
      {
        id: 'relationships',
        label: 'Annotate relationships',
        run: () => RelationshipsAnnotate.run([
          '--batch-size', batchSize, '--max-iterations', maxIterations,
          ...llmFlags, ...debugFlags,
        ]),
      },
      {
        id: 'relationships-verify',
        label: 'Verify relationships',
        run: () => RelationshipsVerify.run([
          '--fix', ...llmFlags, ...debugFlags,
        ]),
      },
      {
        id: 'modules',
        label: 'Generate modules',
        run: () => ModulesGenerate.run([...llmFlags, ...debugFlags]),
      },
      {
        id: 'modules-verify',
        label: 'Verify modules',
        run: () => ModulesVerify.run(['--fix', ...llmFlags, ...debugFlags]),
      },
      {
        id: 'interactions',
        label: 'Generate interactions',
        run: () => InteractionsGenerate.run([
          '--verbose', '--force', ...llmFlags, ...debugFlags,
        ]),
      },
      {
        id: 'interactions-verify',
        label: 'Verify interactions',
        run: () => InteractionsVerify.run(['--fix', ...llmFlags, ...debugFlags]),
      },
      {
        id: 'flows',
        label: 'Generate flows',
        run: () => FlowsGenerate.run([
          '--verbose', '--force', ...llmFlags, ...debugFlags,
        ]),
      },
      {
        id: 'flows-verify',
        label: 'Verify flows',
        run: () => FlowsVerify.run(['--fix', ...llmFlags, ...debugFlags]),
      },
      {
        id: 'features',
        label: 'Generate features',
        run: () => FeaturesGenerate.run([
          '--verbose', '--force', ...llmFlags, ...debugFlags,
        ]),
      },
    ];

    // Filter stages by --from-stage / --to-stage
    const fromIndex = fromStage ? stages.findIndex(s => s.id === fromStage) : 0;
    const toIndex = toStage ? stages.findIndex(s => s.id === toStage) : stages.length - 1;
    const stagesToRun = stages.slice(fromIndex, toIndex + 1);

    // Delete existing DB unless resuming from a later stage
    if (!fromStage) {
      try {
        fs.unlinkSync(dbPath);
      } catch {
        // File doesn't exist, that's fine
      }
    }

    this.log(chalk.bold(`\nSquint Ingest Pipeline`));
    this.log(chalk.gray(`Directory: ${directory}`));
    this.log(chalk.gray(`Database:  ${dbPath}`));
    this.log(chalk.gray(`Model:     ${model}`));
    this.log(chalk.gray(`Stages:    ${stagesToRun[0].id} → ${stagesToRun[stagesToRun.length - 1].id} (${stagesToRun.length} of ${stages.length})`));
    this.log('');

    const pipelineStart = Date.now();

    for (let i = 0; i < stagesToRun.length; i++) {
      const stage = stagesToRun[i];
      const stageNum = stages.findIndex(s => s.id === stage.id) + 1;

      this.log(chalk.blue.bold(`[${stageNum}/${stages.length}] ${stage.label}`));
      const stageStart = Date.now();

      try {
        await stage.run();
      } catch (err) {
        const elapsed = ((Date.now() - stageStart) / 1000).toFixed(1);
        this.log(chalk.red(`\nStage "${stage.id}" failed after ${elapsed}s`));
        this.log(chalk.yellow(`Resume with: squint ingest ${args.directory} --from-stage ${stage.id}`));
        throw err;
      }

      const elapsed = ((Date.now() - stageStart) / 1000).toFixed(1);
      this.log(chalk.green(`  ✓ ${stage.label} (${elapsed}s)\n`));
    }

    const totalElapsed = ((Date.now() - pipelineStart) / 1000).toFixed(1);
    this.log(chalk.green.bold(`\n✓ Pipeline complete! (${totalElapsed}s)`));
    this.log(chalk.white(`  Database: ${dbPath}`));
  }
}
