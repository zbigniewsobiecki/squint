import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { withDatabase, SharedFlags, outputJsonOrPlain, tableSeparator } from '../_shared/index.js';

export default class Flows extends Command {
  static override description = 'List all flows with step counts';

  static override examples = [
    '<%= config.bin %> flows',
    '<%= config.bin %> flows --domain user',
    '<%= config.bin %> flows --json',
    '<%= config.bin %> flows -d ./my-index.db',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    domain: Flags.string({
      description: 'Filter by domain',
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Flows);

    await withDatabase(flags.database, this, async (db) => {
      const allFlows = db.getAllFlowsWithSteps();
      const stats = db.getFlowStats();

      // Filter by domain if specified
      const flows = flags.domain
        ? allFlows.filter(f => f.domain === flags.domain)
        : allFlows;

      // Collect unique modules crossed for each flow
      const flowsWithModules = flows.map(f => {
        const moduleSet = new Set<string>();
        for (const step of f.steps) {
          if (step.moduleName) {
            moduleSet.add(step.moduleName);
          }
        }
        return {
          ...f,
          modulesCrossed: Array.from(moduleSet),
        };
      });

      const jsonData = {
        flows: flowsWithModules.map(f => ({
          id: f.id,
          name: f.name,
          description: f.description,
          domain: f.domain,
          entryPoint: f.entryPointName,
          entryPointKind: f.entryPointKind,
          entryPointFile: f.entryPointFilePath,
          stepCount: f.steps.length,
          modulesCrossed: f.modulesCrossed,
        })),
        stats: {
          flowCount: stats.flowCount,
          totalSteps: stats.totalSteps,
          avgStepsPerFlow: Math.round(stats.avgStepsPerFlow * 10) / 10,
          modulesCovered: stats.modulesCovered,
        },
      };

      outputJsonOrPlain(this, flags.json, jsonData, () => {
        if (flows.length === 0) {
          if (flags.domain) {
            this.log(chalk.gray(`No flows found with domain "${flags.domain}".`));
          } else {
            this.log(chalk.gray('No flows found. Use `ats llm flows` to detect flows.'));
          }
          return;
        }

        this.log(`Flows (${chalk.cyan(String(flows.length))} total, ${chalk.cyan(String(stats.totalSteps))} steps)`);
        this.log('');

        // Calculate column widths
        const nameWidth = Math.max(20, ...flows.map(f => f.name.length));
        const entryWidth = Math.max(20, ...flows.map(f => f.entryPointName.length));
        const stepsWidth = 6;

        // Header
        this.log(
          chalk.gray('Name'.padEnd(nameWidth)) + '  ' +
          chalk.gray('Entry Point'.padEnd(entryWidth)) + '  ' +
          chalk.gray('Steps'.padEnd(stepsWidth)) + '  ' +
          chalk.gray('Modules Crossed')
        );
        this.log(tableSeparator(nameWidth + entryWidth + stepsWidth + 50));

        // Rows
        for (const f of flowsWithModules) {
          const name = f.name.padEnd(nameWidth);
          const entry = f.entryPointName.padEnd(entryWidth);
          const steps = String(f.steps.length).padStart(stepsWidth - 1).padEnd(stepsWidth);
          const modules = f.modulesCrossed.length > 0
            ? f.modulesCrossed.slice(0, 3).join(', ') + (f.modulesCrossed.length > 3 ? '...' : '')
            : chalk.gray('-');

          this.log(`${chalk.cyan(name)}  ${chalk.yellow(entry)}  ${steps}  ${modules}`);
        }

        // Summary
        if (stats.modulesCovered > 0) {
          this.log('');
          this.log(chalk.gray(`Flows cover ${stats.modulesCovered} distinct modules`));
        }
      });
    });
  }
}
