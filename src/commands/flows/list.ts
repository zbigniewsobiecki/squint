import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type { Flow, FlowStakeholder } from '../../db/schema.js';
import { SharedFlags, openDatabase } from '../_shared/index.js';

const TIER_NAMES: Record<number, string> = { 0: 'Atomic', 1: 'Operations', 2: 'Journeys' };
const TIER_ORDER = [1, 2, 0];

export default class FlowsList extends Command {
  static override description = 'List all detected user journey flows';

  static override examples = [
    '<%= config.bin %> flows',
    '<%= config.bin %> flows --stakeholder user',
    '<%= config.bin %> flows --tier 2',
    '<%= config.bin %> flows -d index.db --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    stakeholder: Flags.string({
      description: 'Filter by stakeholder type',
      options: ['user', 'admin', 'system', 'developer', 'external'],
    }),
    tier: Flags.integer({
      description: 'Filter by tier (0=atomic, 1=operation, 2=journey)',
      min: 0,
      max: 2,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(FlowsList);

    const db = await openDatabase(flags.database, this);
    const isJson = flags.json;

    try {
      let flows: Flow[];

      if (flags.stakeholder) {
        flows = db.flows.getByStakeholder(flags.stakeholder as FlowStakeholder);
      } else {
        flows = db.flows.getAll();
      }

      if (flags.tier !== undefined) {
        flows = flows.filter((f) => f.tier === flags.tier);
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
        const stats = db.flows.getStats();
        const coverage = db.flows.getCoverage();
        this.log(JSON.stringify({ flows, stats, coverage }, null, 2));
        return;
      }

      // Group by tier, then by stakeholder within each tier
      const byTier = new Map<number, Flow[]>();
      for (const flow of flows) {
        const list = byTier.get(flow.tier) ?? [];
        list.push(flow);
        byTier.set(flow.tier, list);
      }

      this.log(chalk.bold(`Flows (${flows.length})`));
      this.log('');

      const stakeholderColors: Record<string, (s: string) => string> = {
        user: chalk.green,
        admin: chalk.red,
        system: chalk.blue,
        developer: chalk.yellow,
        external: chalk.magenta,
        unassigned: chalk.gray,
      };

      const stakeholderOrder = ['user', 'admin', 'system', 'developer', 'external', 'unassigned'];

      for (const tier of TIER_ORDER) {
        const tierFlows = byTier.get(tier);
        if (!tierFlows || tierFlows.length === 0) continue;

        const tierName = TIER_NAMES[tier] ?? `Tier ${tier}`;
        this.log(chalk.bold.underline(`${tierName} (${tierFlows.length})`));
        this.log('');

        // Group by stakeholder within this tier
        const byStakeholder = new Map<string, Flow[]>();
        for (const flow of tierFlows) {
          const key = flow.stakeholder ?? 'unassigned';
          const list = byStakeholder.get(key) ?? [];
          list.push(flow);
          byStakeholder.set(key, list);
        }

        for (const stakeholder of stakeholderOrder) {
          const stakeholderFlows = byStakeholder.get(stakeholder);
          if (!stakeholderFlows || stakeholderFlows.length === 0) continue;

          const colorFn = stakeholderColors[stakeholder] ?? chalk.white;
          this.log(chalk.bold(colorFn(`  ${stakeholder.charAt(0).toUpperCase() + stakeholder.slice(1)}`)));

          for (const flow of stakeholderFlows) {
            const meta: string[] = [];
            if (flow.actionType) meta.push(chalk.cyan(flow.actionType));
            if (flow.targetEntity) meta.push(chalk.yellow(flow.targetEntity));
            const metaStr = meta.length > 0 ? ` ${meta.join(' ')}` : '';

            this.log(`    ${chalk.bold(flow.name)} ${chalk.gray(`(${flow.slug})`)}${metaStr}`);
            if (flow.entryPath) {
              this.log(`      Entry: ${flow.entryPath}`);
            }
            if (flow.description) {
              this.log(`      ${chalk.gray(flow.description)}`);
            }
          }
          this.log('');
        }
      }

      // Stats
      const allFlows = flags.stakeholder || flags.tier !== undefined ? db.flows.getAll() : flows;
      const stats = db.flows.getStats();
      const coverage = db.flows.getCoverage();

      // Tier breakdown
      const tierCounts = new Map<number, number>();
      for (const flow of allFlows) {
        tierCounts.set(flow.tier, (tierCounts.get(flow.tier) ?? 0) + 1);
      }

      this.log(chalk.bold('Statistics'));
      this.log(`Total flows: ${stats.flowCount}`);

      const tierParts: string[] = [];
      for (const tier of TIER_ORDER) {
        const count = tierCounts.get(tier);
        if (count && count > 0) {
          tierParts.push(`${TIER_NAMES[tier] ?? `Tier ${tier}`}: ${count}`);
        }
      }
      if (tierParts.length > 0) {
        this.log(`Tier breakdown: ${tierParts.join(', ')}`);
      }

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
