import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, openDatabase } from '../_shared/index.js';
import { areSameProcess, computeProcessGroups } from '../llm/_shared/process-utils.js';

export default class InteractionsValidate extends Command {
  static override description = 'Validate LLM-inferred interactions using deterministic checks';

  static override examples = [
    '<%= config.bin %> interactions validate',
    '<%= config.bin %> interactions validate --fix',
    '<%= config.bin %> interactions validate -d index.db --json',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    fix: Flags.boolean({
      description: 'Auto-remediate issues (delete invalid interactions)',
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(InteractionsValidate);

    const db = await openDatabase(flags.database, this);
    const isJson = flags.json;

    try {
      const processGroups = computeProcessGroups(db);
      const issues = db.interactionAnalysis.validateInferredInteractions(db.interactions, (from, to) =>
        areSameProcess(from, to, processGroups)
      );

      if (issues.length === 0) {
        if (isJson) {
          this.log(JSON.stringify({ issues: [], summary: { total: 0, fixed: 0 } }));
        } else {
          this.log(chalk.green('All LLM-inferred interactions passed validation.'));
        }
        return;
      }

      if (isJson) {
        const result: { issues: typeof issues; summary: { total: number; fixed: number } } = {
          issues,
          summary: { total: issues.length, fixed: 0 },
        };

        if (flags.fix) {
          let fixed = 0;
          for (const issue of issues) {
            db.interactions.delete(issue.interactionId);
            fixed++;
          }
          result.summary.fixed = fixed;
        }

        this.log(JSON.stringify(result, null, 2));
        return;
      }

      this.log(chalk.bold(`Validation Issues (${issues.length})`));
      this.log('');

      for (const issue of issues) {
        const arrow = `${issue.fromPath} → ${issue.toPath}`;

        if (issue.issue.startsWith('REVERSED:')) {
          this.log(`  ${chalk.red('REVERSED')} ${arrow}`);
          this.log(`    ${chalk.gray(issue.issue.replace('REVERSED: ', ''))}`);
          this.log(`    ${chalk.yellow('Recommendation: DELETE (reverse already exists as AST interaction)')}`);
        } else if (issue.issue.startsWith('DIRECTION_CONFUSED:')) {
          this.log(`  ${chalk.yellow('DIRECTION_CONFUSED')} ${arrow}`);
          this.log(`    ${chalk.gray(issue.issue.replace('DIRECTION_CONFUSED: ', ''))}`);
          this.log(`    ${chalk.yellow('Recommendation: DELETE (direction is wrong)')}`);
        } else if (issue.issue.startsWith('NO_IMPORTS:')) {
          this.log(`  ${chalk.yellow('NO_IMPORTS')} ${arrow}`);
          this.log(`    ${chalk.gray(issue.issue.replace('NO_IMPORTS: ', ''))}`);
          this.log(`    ${chalk.yellow('Recommendation: DELETE (no static evidence)')}`);
        } else {
          this.log(`  ${chalk.gray('ISSUE')} ${arrow}`);
          this.log(`    ${chalk.gray(issue.issue)}`);
        }
        this.log('');
      }

      if (flags.fix) {
        let fixed = 0;
        for (const issue of issues) {
          db.interactions.delete(issue.interactionId);
          fixed++;
        }
        this.log(chalk.green(`Fixed ${fixed} issues (deleted invalid interactions).`));
      } else {
        this.log(chalk.gray('Use --fix to auto-remediate these issues.'));
      }
    } finally {
      db.close();
    }
  }
}
