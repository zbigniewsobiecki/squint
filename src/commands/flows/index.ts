import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type { Flow, FlowStakeholder } from '../../db/schema.js';
import { SharedFlags, openDatabase } from '../_shared/index.js';

export default class Flows extends Command {
  static override description = 'List all detected user journey flows';

  static override examples = [
    '<%= config.bin %> flows',
    '<%= config.bin %> flows --stakeholder user',
    '<%= config.bin %> flows --stakeholder admin',
    '<%= config.bin %> flows -d index.db --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    stakeholder: Flags.string({
      description: 'Filter by stakeholder type',
      options: ['user', 'admin', 'system', 'developer', 'external'],
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Flows);

    const db = await openDatabase(flags.database, this);
    const isJson = flags.json;

    try {
      let flows: Flow[];

      if (flags.stakeholder) {
        flows = db.getFlowsByStakeholder(flags.stakeholder as FlowStakeholder);
      } else {
        flows = db.getAllFlows();
      }

      if (flows.length === 0) {
        if (isJson) {
          this.log(JSON.stringify({ flows: [], stats: { flowCount: 0 } }));
        } else {
          this.log(chalk.gray('No flows detected yet.'));
          this.log(chalk.gray('Run `squint llm flows` to detect user journey flows.'));
        }
        return;
      }

      if (isJson) {
        const stats = db.getFlowStats();
        const coverage = db.getFlowCoverage();
        this.log(JSON.stringify({ flows, stats, coverage }, null, 2));
        return;
      }

      // Group by stakeholder
      const byStakeholder = new Map<string, Flow[]>();
      for (const flow of flows) {
        const key = flow.stakeholder ?? 'unassigned';
        const list = byStakeholder.get(key) ?? [];
        list.push(flow);
        byStakeholder.set(key, list);
      }

      this.log(chalk.bold(`Flows (${flows.length})`));
      this.log('');

      const stakeholderOrder = ['user', 'admin', 'system', 'developer', 'external', 'unassigned'];
      const stakeholderColors: Record<string, (s: string) => string> = {
        user: chalk.green,
        admin: chalk.red,
        system: chalk.blue,
        developer: chalk.yellow,
        external: chalk.magenta,
        unassigned: chalk.gray,
      };

      for (const stakeholder of stakeholderOrder) {
        const stakeholderFlows = byStakeholder.get(stakeholder);
        if (!stakeholderFlows || stakeholderFlows.length === 0) continue;

        const colorFn = stakeholderColors[stakeholder] ?? chalk.white;
        this.log(chalk.bold(colorFn(`${stakeholder.charAt(0).toUpperCase() + stakeholder.slice(1)} Flows`)));

        for (const flow of stakeholderFlows) {
          this.log(`  ${chalk.bold(flow.name)} ${chalk.gray(`(${flow.slug})`)}`);
          if (flow.entryPath) {
            this.log(`    Entry: ${flow.entryPath}`);
          }
          if (flow.description) {
            this.log(`    ${chalk.gray(flow.description)}`);
          }
        }
        this.log('');
      }

      // Stats
      const stats = db.getFlowStats();
      const coverage = db.getFlowCoverage();

      this.log(chalk.bold('Statistics'));
      this.log(`Total flows: ${stats.flowCount}`);
      this.log(`With entry points: ${stats.withEntryPointCount}`);
      this.log(`Avg steps per flow: ${stats.avgStepsPerFlow.toFixed(1)}`);
      this.log(
        `Interaction coverage: ${coverage.coveredByFlows}/${coverage.totalInteractions} (${coverage.percentage.toFixed(1)}%)`
      );
    } finally {
      db.close();
    }
  }
}
