import { Flags } from '@oclif/core';
import chalk from 'chalk';
import { LlmFlags, SharedFlags } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import { computeProcessGroups } from '../llm/_shared/process-utils.js';
import { checkInteractionQuality, checkReferentialIntegrity } from '../llm/_shared/verify/coverage-checker.js';

export default class InteractionsVerify extends BaseLlmCommand {
  static override description = 'Verify existing interactions';

  static override examples = [
    '<%= config.bin %> interactions verify',
    '<%= config.bin %> interactions verify --fix',
    '<%= config.bin %> interactions verify -d index.db --verbose',
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
      this.log(chalk.bold('Interaction Quality Verification'));
      this.log('');
    }

    // Run referential integrity check first
    const ghostResult = checkReferentialIntegrity(db);
    const processGroups = computeProcessGroups(db);
    const result = checkInteractionQuality(db, processGroups);

    // Merge ghost issues into result
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
        this.log(chalk.green('  \u2713 All interactions passed verification'));
      } else {
        this.log(chalk.red(`  \u2717 Verification failed: ${result.stats.structuralIssueCount} structural issues`));
      }
    }

    // Auto-fix
    if (shouldFix && !dryRun) {
      let fixed = 0;

      for (const issue of result.issues) {
        if (!issue.fixData) continue;

        if (issue.fixData.action === 'remove-ghost' && issue.fixData.ghostTable && issue.fixData.ghostRowId) {
          const deleted = db.deleteGhostRow(issue.fixData.ghostTable, issue.fixData.ghostRowId);
          if (deleted) fixed++;
        }

        if (issue.fixData.action === 'remove-interaction' && issue.fixData.interactionId) {
          const deleted = db.interactions.delete(issue.fixData.interactionId);
          if (deleted) fixed++;
        }

        if (issue.fixData.action === 'rebuild-symbols' && issue.fixData.interactionId) {
          const interaction = db.interactions.getById(issue.fixData.interactionId);
          if (interaction) {
            const importedSymbols = db.interactions.getModuleImportedSymbols(
              interaction.fromModuleId,
              interaction.toModuleId
            );
            if (importedSymbols.length > 0) {
              db.interactions.update(issue.fixData.interactionId, {
                symbols: importedSymbols.map((s) => s.name),
              });
              fixed++;
            }
          }
        }

        if (issue.fixData.action === 'set-direction-uni' && issue.fixData.interactionId) {
          const updated = db.interactions.update(issue.fixData.interactionId, { direction: 'uni' });
          if (updated) fixed++;
        }

        if (issue.fixData.action === 'remove-inferred-to-module' && issue.fixData.targetModuleId) {
          const removed = db.interactions.removeInferredToModule(issue.fixData.targetModuleId);
          fixed += removed;
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
