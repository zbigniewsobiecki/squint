import { Flags } from '@oclif/core';
import chalk from 'chalk';

import { LlmFlags, SharedFlags } from '../_shared/index.js';
import FlowsGenerate from '../flows/generate.js';
import InteractionsGenerate from '../interactions/generate.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import { verifyModuleAssignmentContent } from '../llm/_shared/verify/content-verifier.js';
import { checkReferentialIntegrity } from '../llm/_shared/verify/integrity-checker.js';
import { checkModuleAssignments } from '../llm/_shared/verify/module-checker.js';

export default class ModulesVerify extends BaseLlmCommand {
  static override description = 'Verify existing module assignments';

  static override examples = [
    '<%= config.bin %> modules verify',
    '<%= config.bin %> modules verify --fix',
    '<%= config.bin %> modules verify --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    ...LlmFlags,
    fix: Flags.boolean({
      description: 'Auto-fix structural issues found during verification (e.g., move test symbols to test modules)',
      default: false,
    }),
    'batch-size': Flags.integer({
      char: 'b',
      description: 'Number of assignments per LLM call (Phase 2)',
      default: 80,
    }),
    'max-iterations': Flags.integer({
      description: 'Maximum LLM iterations for Phase 2 (0 = unlimited)',
      default: 0,
    }),
  };

  protected async execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, dryRun } = ctx;
    const shouldFix = flags.fix as boolean;

    if (!isJson) {
      this.log(chalk.bold('Module Assignment Verification'));
      this.log('');
    }

    // Run referential integrity check first
    const ghostResult = checkReferentialIntegrity(db);
    const result = checkModuleAssignments(db);

    // Merge ghost issues
    result.issues.unshift(...ghostResult.issues);
    result.stats.structuralIssueCount += ghostResult.stats.structuralIssueCount;
    if (!ghostResult.passed) result.passed = false;

    if (!isJson) {
      const warningIssues = result.issues.filter((i) => i.severity === 'warning');
      const infoIssues = result.issues.filter((i) => i.severity === 'info');

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
        for (const issue of infoIssues.slice(0, 20)) {
          this.log(`    ${chalk.gray('INFO')} [${issue.category}] ${issue.message}`);
        }
        if (infoIssues.length > 20) {
          this.log(chalk.gray(`    ... and ${infoIssues.length - 20} more`));
        }
        this.log('');
      }

      if (result.passed) {
        this.log(chalk.green('  \u2713 All module assignments passed verification'));
      } else {
        this.log(chalk.red(`  \u2717 Verification failed: ${result.stats.structuralIssueCount} structural issues`));
      }
    }

    // Auto-fix: ghost rows + test-in-production moves
    let totalFixedAssignments = 0;

    if (shouldFix && !dryRun) {
      const ghostIssues = result.issues.filter((i) => i.fixData?.action === 'remove-ghost');
      if (ghostIssues.length > 0) {
        let ghostFixed = 0;
        for (const issue of ghostIssues) {
          if (issue.fixData?.ghostTable && issue.fixData?.ghostRowId) {
            const deleted = db.deleteGhostRow(issue.fixData.ghostTable, issue.fixData.ghostRowId);
            if (deleted) ghostFixed++;
          }
        }
        if (ghostFixed > 0 && !isJson) {
          this.log(chalk.green(`  Fixed: removed ${ghostFixed} ghost rows`));
        }
      }

      const testInProdIssues = result.issues.filter((i) => i.fixData?.action === 'move-to-test-module');
      if (testInProdIssues.length > 0) {
        // Find a test module to move symbols to
        const modules = db.modules.getAll();
        const testModules = modules.filter((m) => m.isTest);

        if (testModules.length === 0) {
          if (!isJson) {
            this.log(chalk.yellow('  No test modules found — cannot auto-fix test-in-production issues'));
          }
        } else {
          // Use deepest test module as default target
          const targetModule = testModules.sort((a, b) => b.depth - a.depth)[0];
          let fixed = 0;
          for (const issue of testInProdIssues) {
            if (issue.definitionId) {
              db.modules.assignSymbol(issue.definitionId, targetModule.id);
              fixed++;
            }
          }
          totalFixedAssignments += fixed;
          if (!isJson) {
            this.log(chalk.green(`  Fixed: moved ${fixed} test symbols to '${targetModule.fullPath}'`));
          }
        }
      }
    }

    // Phase 2: LLM content verification of assignments
    if (!dryRun && ctx.model) {
      if (!isJson) {
        this.log('');
        this.log(chalk.bold('Phase 2: Assignment Verification (LLM)'));
      }

      const phase2 = await verifyModuleAssignmentContent(db, ctx, this, {
        'batch-size': flags['batch-size'] as number,
        'max-iterations': flags['max-iterations'] as number,
      });

      if (!isJson) {
        this.log(`  Checked: ${phase2.stats.checked} assignments in ${phase2.stats.batchesProcessed} batches`);
        if (phase2.issues.length === 0) {
          this.log(chalk.green('  \u2713 All module assignments passed content verification'));
        } else {
          this.log(chalk.yellow(`  Found ${phase2.issues.length} issues:`));
          for (const issue of phase2.issues) {
            const sev = issue.severity === 'error' ? chalk.red('ERR') : chalk.yellow('WARN');
            this.log(`  ${sev} ${issue.definitionName || '?'} (${issue.filePath}): ${issue.message}`);
          }
        }
      }

      // Auto-fix: reassign definitions flagged as wrong
      if (shouldFix && phase2.issues.length > 0) {
        const wrongIssues = phase2.issues.filter((i) => i.fixData?.action === 'reassign-module');
        let fixed = 0;
        for (const issue of wrongIssues) {
          if (!issue.definitionId || !issue.fixData?.targetModuleId) continue;
          const targetModule = db.modules.getById(issue.fixData.targetModuleId);
          if (!targetModule) continue;
          db.modules.assignSymbol(issue.definitionId, targetModule.id);
          fixed++;
        }
        totalFixedAssignments += fixed;
        if (fixed > 0 && !isJson) {
          this.log(chalk.green(`  Fixed: reassigned ${fixed} definitions to better-matching modules`));
        }
      }
    }

    // Cascade: regenerate interactions + flows after assignment changes
    if (shouldFix && !dryRun && totalFixedAssignments > 0) {
      // Build flags for sub-command invocation (same pattern as sync.ts)
      const dbPath = db.getConnection().name;
      const llmFlags = ['-d', dbPath, '--model', ctx.model];

      if (!isJson) {
        this.log('');
        this.log(chalk.gray('  Regenerating interactions after reassignment...'));
      }
      try {
        await InteractionsGenerate.run(['--force', ...llmFlags]);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.warn(chalk.yellow(`  Interaction regeneration warning: ${msg}`));
      }

      try {
        if (!isJson) this.log(chalk.gray('  Regenerating flows...'));
        await FlowsGenerate.run(['--force', ...llmFlags]);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.warn(chalk.yellow(`  Flow regeneration warning: ${msg}`));
      }
    }

    if (isJson) {
      this.log(JSON.stringify(result, null, 2));
    }
  }
}
