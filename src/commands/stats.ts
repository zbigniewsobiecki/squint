import { Command } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, outputJsonOrPlain, resolveDbPath, withDatabase } from './_shared/index.js';
import { computeProcessGroups } from './llm/_shared/process-utils.js';

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function pct(n: number, total: number): string {
  if (total === 0) return ' 0.0%';
  const p = (n / total) * 100;
  return `${p.toFixed(1).padStart(5)}%`;
}

function colorPct(n: number, total: number): string {
  if (total === 0) return chalk.gray(' 0.0%');
  const p = (n / total) * 100;
  const s = `${p.toFixed(1).padStart(5)}%`;
  if (p >= 80) return chalk.green(s);
  if (p >= 50) return chalk.yellow(s);
  return chalk.red(s);
}

function ratio(n: number, total: number): string {
  return `${fmt(n).padStart(6)} / ${fmt(total).padEnd(6)}`;
}

function sectionHeader(title: string): string {
  const line = '─'.repeat(48 - title.length - 4);
  return chalk.bold(`── ${title} ${line}`);
}

export default class Stats extends Command {
  static override description = 'Show database statistics and pipeline progress';

  static override examples = [
    '<%= config.bin %> stats',
    '<%= config.bin %> stats -d ./my-index.db',
    '<%= config.bin %> stats --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Stats);

    await withDatabase(flags.database, this, async (db) => {
      const resolvedPath = resolveDbPath(flags.database, this);

      // ── Parsed ──
      const fileCount = db.files.getCount();
      const symbolCount = db.definitions.getCount();
      const kindCounts = db.definitions.getKindCounts();
      const depCount = db.dependencies.getCallsiteCount();

      // ── Annotations ──
      const aspectCoverage = db.metadata.getAspectCoverage();
      const relAnnotated = db.relationships.getCount();
      const relUnannotated = db.relationships.getUnannotatedCount();
      const relTotal = relAnnotated + relUnannotated;

      // ── Modules ──
      const moduleStats = db.modules.getStats();

      let processGroupCount = 0;
      try {
        if (moduleStats.moduleCount > 0) {
          processGroupCount = computeProcessGroups(db).groupCount;
        }
      } catch {
        // modules may not exist yet
      }

      // ── Interactions ──
      const interactionStats = db.interactions.getStats();

      // ── Flows ──
      const flowStats = db.flows.getStats();
      const flowCoverage = db.flows.getCoverage();

      // ── Features ──
      const featureCount = db.features.getCount();
      const totalFlows = flowStats.flowCount;
      const assignedFlowCount = db.features.getAssignedFlowCount();

      // ── JSON mode ──
      outputJsonOrPlain(
        this,
        flags.json,
        {
          database: resolvedPath,
          parsed: {
            files: fileCount,
            symbols: symbolCount,
            symbolsByKind: kindCounts,
            dependencies: depCount,
          },
          annotations: {
            aspects: aspectCoverage.map((a) => ({
              aspect: a.aspect,
              covered: a.covered,
              total: a.total,
              percentage: a.percentage,
            })),
            relationships: { annotated: relAnnotated, total: relTotal },
          },
          modules: {
            count: moduleStats.moduleCount,
            assignedSymbols: moduleStats.assigned,
            totalSymbols: symbolCount,
            processGroups: processGroupCount,
          },
          interactions: {
            total: interactionStats.totalCount,
            business: interactionStats.businessCount,
            utility: interactionStats.utilityCount,
            biDirectional: interactionStats.biDirectionalCount,
          },
          flows: {
            count: flowStats.flowCount,
            withEntryPoint: flowStats.withEntryPointCount,
            avgStepsPerFlow: Math.round(flowStats.avgStepsPerFlow * 10) / 10,
            interactionCoverage: {
              covered: flowCoverage.coveredByFlows,
              total: flowCoverage.totalInteractions,
              percentage: Math.round(flowCoverage.percentage * 10) / 10,
            },
          },
          features: {
            count: featureCount,
            flowsAssigned: assignedFlowCount,
            totalFlows,
          },
        },
        () => {
          // ── Plain text mode ──
          this.log(`Squint Index: ${chalk.cyan(resolvedPath)}`);
          this.log('');

          // ── Parsed ──
          this.log(sectionHeader('Parsed'));
          this.log(`  Files          ${fmt(fileCount).padStart(8)}`);
          this.log(`  Symbols        ${fmt(symbolCount).padStart(8)}`);

          const kindOrder = ['function', 'class', 'variable', 'type', 'interface', 'enum'];
          const sortedKinds = Object.entries(kindCounts).sort((a, b) => {
            const ai = kindOrder.indexOf(a[0]);
            const bi = kindOrder.indexOf(b[0]);
            if (ai !== -1 && bi !== -1) return ai - bi;
            if (ai !== -1) return -1;
            if (bi !== -1) return 1;
            return b[1] - a[1];
          });
          for (const [kind, count] of sortedKinds) {
            this.log(`    ${kind.padEnd(14)} ${fmt(count).padStart(6)}   (${pct(count, symbolCount)})`);
          }

          this.log(`  Dependencies   ${fmt(depCount).padStart(8)}`);
          this.log('');

          // ── Annotations ──
          if (aspectCoverage.length > 0 || relTotal > 0) {
            this.log(sectionHeader('Annotations'));
            for (const a of aspectCoverage) {
              this.log(`  ${a.aspect.padEnd(14)} ${ratio(a.covered, a.total)}   (${colorPct(a.covered, a.total)})`);
            }
            if (relTotal > 0) {
              this.log(
                `  ${'relationships'.padEnd(14)} ${ratio(relAnnotated, relTotal)}   (${colorPct(relAnnotated, relTotal)})`
              );
            }
            this.log('');
          }

          // ── Modules ──
          if (moduleStats.moduleCount > 0) {
            this.log(sectionHeader('Modules'));
            this.log(`  Modules        ${fmt(moduleStats.moduleCount).padStart(8)}`);
            this.log(
              `  Assigned symbols ${ratio(moduleStats.assigned, symbolCount)}   (${colorPct(moduleStats.assigned, symbolCount)})`
            );
            if (processGroupCount > 0) {
              this.log(`  Process groups ${fmt(processGroupCount).padStart(8)}`);
            }
            this.log('');
          }

          // ── Interactions ──
          if (interactionStats.totalCount > 0) {
            this.log(sectionHeader('Interactions'));
            this.log(`  Total          ${fmt(interactionStats.totalCount).padStart(8)}`);
            if (interactionStats.businessCount > 0) {
              this.log(
                `    business     ${fmt(interactionStats.businessCount).padStart(8)}   (${pct(interactionStats.businessCount, interactionStats.totalCount)})`
              );
            }
            if (interactionStats.utilityCount > 0) {
              this.log(
                `    utility      ${fmt(interactionStats.utilityCount).padStart(8)}   (${pct(interactionStats.utilityCount, interactionStats.totalCount)})`
              );
            }
            if (interactionStats.biDirectionalCount > 0) {
              this.log(
                `    bi-directional ${fmt(interactionStats.biDirectionalCount).padStart(6)}   (${pct(interactionStats.biDirectionalCount, interactionStats.totalCount)})`
              );
            }
            this.log('');
          }

          // ── Flows ──
          if (flowStats.flowCount > 0) {
            this.log(sectionHeader('Flows'));
            this.log(`  Flows          ${fmt(flowStats.flowCount).padStart(8)}`);
            this.log(`    with entry point ${fmt(flowStats.withEntryPointCount).padStart(4)}`);
            this.log(`  Avg steps/flow ${(Math.round(flowStats.avgStepsPerFlow * 10) / 10).toFixed(1).padStart(8)}`);
            if (flowCoverage.totalInteractions > 0) {
              this.log(
                `  Interaction coverage ${ratio(flowCoverage.coveredByFlows, flowCoverage.totalInteractions)}   (${colorPct(flowCoverage.coveredByFlows, flowCoverage.totalInteractions)})`
              );
            }
            this.log('');
          }

          // ── Features ──
          if (featureCount > 0) {
            this.log(sectionHeader('Features'));
            this.log(`  Features       ${fmt(featureCount).padStart(8)}`);
            if (totalFlows > 0) {
              this.log(`  Flows assigned ${ratio(assignedFlowCount, totalFlows)}`);
            }
            this.log('');
          }
        }
      );
    });
  }
}
