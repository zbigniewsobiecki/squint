import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { withDatabase, SharedFlags, outputJsonOrPlain, tableSeparator } from '../_shared/index.js';

export default class FlowsShow extends Command {
  static override description = 'Show flow details with step sequence';

  static override examples = [
    '<%= config.bin %> flows show user-registration',
    '<%= config.bin %> flows show login --json',
    '<%= config.bin %> flows show checkout -d ./my-index.db',
  ];

  static override args = {
    name: Args.string({ description: 'Flow name to show', required: true }),
  };

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(FlowsShow);

    await withDatabase(flags.database, this, async (db) => {
      const allFlows = db.getAllFlowsWithSteps();
      const flow = allFlows.find(f => f.name === args.name);

      if (!flow) {
        // Try partial match
        const matches = allFlows.filter(f =>
          f.name.toLowerCase().includes(args.name.toLowerCase())
        );

        if (matches.length === 1) {
          return this.displayFlow(matches[0], flags.json);
        } else if (matches.length > 1) {
          this.log(chalk.yellow(`Multiple flows match "${args.name}":`));
          for (const f of matches) {
            this.log(`  ${chalk.cyan(f.name)} (${f.steps.length} steps)`);
          }
          this.log('');
          this.log(chalk.gray('Please specify the exact flow name.'));
          return;
        }

        this.error(chalk.red(`Flow "${args.name}" not found.`));
      }

      return this.displayFlow(flow, flags.json);
    });
  }

  private displayFlow(flow: {
    id: number;
    name: string;
    description: string | null;
    domain: string | null;
    entryPointId: number;
    entryPointName: string;
    entryPointKind: string;
    entryPointFilePath: string;
    steps: Array<{
      stepOrder: number;
      definitionId: number;
      name: string;
      kind: string;
      filePath: string;
      moduleId: number | null;
      moduleName: string | null;
      layer: string | null;
    }>;
  }, json: boolean): void {
    const jsonData = {
      id: flow.id,
      name: flow.name,
      description: flow.description,
      domain: flow.domain,
      entryPoint: {
        id: flow.entryPointId,
        name: flow.entryPointName,
        kind: flow.entryPointKind,
        filePath: flow.entryPointFilePath,
      },
      stepCount: flow.steps.length,
      steps: flow.steps.map(s => ({
        order: s.stepOrder,
        id: s.definitionId,
        name: s.name,
        kind: s.kind,
        filePath: s.filePath,
        moduleId: s.moduleId,
        moduleName: s.moduleName,
        layer: s.layer,
      })),
    };

    outputJsonOrPlain(this, json, jsonData, () => {
      this.log(`Flow: ${chalk.cyan(flow.name)}`);
      this.log(`Entry: ${chalk.yellow(flow.entryPointName)} (${flow.entryPointKind}) - ${chalk.gray(flow.entryPointFilePath)}`);
      if (flow.domain) {
        this.log(`Domain: ${chalk.blue(flow.domain)}`);
      }
      if (flow.description) {
        this.log(`Description: ${flow.description}`);
      }
      this.log('');
      this.log(`Steps (${chalk.cyan(String(flow.steps.length))}):`);

      if (flow.steps.length === 0) {
        this.log(chalk.gray('  No steps recorded for this flow.'));
        return;
      }

      // Calculate column widths
      const orderWidth = 4;
      const nameWidth = Math.max(20, ...flow.steps.map(s => s.name.length));
      const kindWidth = 12;
      const moduleWidth = 15;
      const layerWidth = 12;

      this.log('');
      this.log(
        '  ' + chalk.gray('#'.padEnd(orderWidth)) +
        chalk.gray('Name'.padEnd(nameWidth)) + '  ' +
        chalk.gray('Kind'.padEnd(kindWidth)) + '  ' +
        chalk.gray('Module'.padEnd(moduleWidth)) + '  ' +
        chalk.gray('Layer'.padEnd(layerWidth))
      );
      this.log('  ' + tableSeparator(orderWidth + nameWidth + kindWidth + moduleWidth + layerWidth + 10));

      for (const step of flow.steps) {
        const order = String(step.stepOrder + 1).padEnd(orderWidth);
        const name = step.name.padEnd(nameWidth);
        const kind = step.kind.padEnd(kindWidth);
        const module = (step.moduleName ?? '-').padEnd(moduleWidth);
        const layer = (step.layer ?? '-').padEnd(layerWidth);

        this.log(`  ${chalk.gray(order)}${chalk.cyan(name)}  ${chalk.yellow(kind)}  ${module}  ${chalk.magenta(layer)}`);
      }
    });
  }
}
