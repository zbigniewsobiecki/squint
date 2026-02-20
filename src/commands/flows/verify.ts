/**
 * Flows Verify Command - Verifies existing flows for quality and referential integrity.
 */

import { Flags } from '@oclif/core';
import chalk from 'chalk';
import { LlmFlags, SharedFlags } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import { checkFlowQuality } from '../llm/_shared/verify/flow-checker.js';
import { checkReferentialIntegrity } from '../llm/_shared/verify/integrity-checker.js';

export default class FlowsVerify extends BaseLlmCommand {
  static override description = 'Verify existing flows';

  static override examples = [
    '<%= config.bin %> flows verify',
    '<%= config.bin %> flows verify --fix',
    '<%= config.bin %> flows verify --json',
    '<%= config.bin %> flows verify -d index.db',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    ...LlmFlags,
    fix: Flags.boolean({
      description: 'Auto-fix structural issues found during verification',
      default: false,
    }),
  };

  protected async execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, dryRun } = ctx;
    const shouldFix = flags.fix as boolean;

    if (!isJson) {
      this.log(chalk.bold('Flow Quality Verification'));
      this.log('');
    }

    // Run referential integrity check first
    const ghostResult = checkReferentialIntegrity(db);
    const result = checkFlowQuality(db);

    // Merge ghost issues
    result.issues.unshift(...ghostResult.issues);
    result.stats.structuralIssueCount += ghostResult.stats.structuralIssueCount;
    if (!ghostResult.passed) result.passed = false;

    if (!isJson) {
      const errorIssues = result.issues.filter((i) => i.severity === 'error');
      const warningIssues = result.issues.filter((i) => i.severity === 'warning');
      const infoIssues = result.issues.filter((i) => i.severity === 'info');

      if (errorIssues.length > 0) {
        this.log(chalk.red(`  Errors (${errorIssues.length}):`));
        for (const issue of errorIssues.slice(0, 30)) {
          this.log(`    ${chalk.red('ERR')}  [${issue.category}] ${issue.message}`);
        }
        if (errorIssues.length > 30) {
          this.log(chalk.gray(`    ... and ${errorIssues.length - 30} more`));
        }
        this.log('');
      }

      if (warningIssues.length > 0) {
        this.log(chalk.yellow(`  Warnings (${warningIssues.length}):`));
        for (const issue of warningIssues.slice(0, 30)) {
          this.log(`    ${chalk.yellow('WARN')} [${issue.category}] ${issue.message}`);
        }
        if (warningIssues.length > 30) {
          this.log(chalk.gray(`    ... and ${warningIssues.length - 30} more`));
        }
        this.log('');
      }

      if (infoIssues.length > 0) {
        this.log(chalk.gray(`  Info (${infoIssues.length}):`));
        for (const issue of infoIssues.slice(0, 30)) {
          this.log(`    ${chalk.gray('INFO')} [${issue.category}] ${issue.message}`);
        }
        if (infoIssues.length > 30) {
          this.log(chalk.gray(`    ... and ${infoIssues.length - 30} more`));
        }
        this.log('');
      }

      if (result.passed) {
        this.log(chalk.green('  \u2713 All flows passed verification'));
      } else {
        this.log(chalk.red(`  \u2717 Verification failed: ${result.stats.structuralIssueCount} structural issues`));
      }
    }

    // Auto-fix
    if (shouldFix && !dryRun) {
      let fixed = 0;

      // Fix remove-flow issues
      const removableIssues = result.issues.filter((i) => i.fixData?.action === 'remove-flow');
      for (const issue of removableIssues) {
        if (issue.fixData?.targetDefinitionId) {
          const deleted = db.flows.delete(issue.fixData.targetDefinitionId);
          if (deleted) fixed++;
        }
      }

      // Fix null-entry-point issues
      const entryPointIssues = result.issues.filter((i) => i.fixData?.action === 'null-entry-point');
      for (const issue of entryPointIssues) {
        if (issue.fixData?.flowId) {
          const updated = db.flows.update(issue.fixData.flowId, {
            entryPointId: undefined,
          });
          if (updated) fixed++;
        }
      }

      // Fix ghost row issues
      const ghostIssues = result.issues.filter((i) => i.fixData?.action === 'remove-ghost');
      for (const issue of ghostIssues) {
        if (issue.fixData?.ghostTable && issue.fixData?.ghostRowId) {
          const deleted = db.deleteGhostRow(issue.fixData.ghostTable, issue.fixData.ghostRowId);
          if (deleted) fixed++;
        }
      }

      if (fixed > 0 && !isJson) {
        this.log(chalk.green(`  Fixed: ${fixed} issues auto-corrected`));
      }
    }

    if (isJson) {
      this.log(JSON.stringify(result, null, 2));
    }
  }
}
