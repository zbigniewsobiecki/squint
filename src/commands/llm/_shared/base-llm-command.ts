/**
 * Base class for LLM commands that share common patterns:
 * - Database open/close lifecycle
 * - Flag unpacking into a typed LlmContext
 * - Header logging
 * - Existence check + force/clear pattern
 */

import { Command } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../../db/database.js';
import { openDatabase } from '../../_shared/index.js';

export interface LlmContext {
  db: IndexDatabase;
  isJson: boolean;
  dryRun: boolean;
  verbose: boolean;
  model: string;
  llmOptions: { showLlmRequests: boolean; showLlmResponses: boolean };
}

export abstract class BaseLlmCommand extends Command {
  /**
   * Subclasses implement this instead of run().
   * The db is opened before and closed after (in finally).
   */
  protected abstract execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void>;

  public async run(): Promise<void> {
    const { flags } = await this.parse(this.constructor as typeof BaseLlmCommand);

    const db = await openDatabase(flags.database as string, this);
    const ctx: LlmContext = {
      db,
      isJson: flags.json as boolean,
      dryRun: flags['dry-run'] as boolean,
      verbose: flags.verbose as boolean,
      model: flags.model as string,
      llmOptions: {
        showLlmRequests: flags['show-llm-requests'] as boolean,
        showLlmResponses: flags['show-llm-responses'] as boolean,
      },
    };

    try {
      await this.execute(ctx, flags);
    } finally {
      db.close();
    }
  }

  /**
   * Print a bold title + gray model line.
   */
  protected logHeader(ctx: LlmContext, title: string): void {
    if (!ctx.isJson) {
      this.log(chalk.bold(title));
      this.log(chalk.gray(`Model: ${ctx.model}`));
      this.log('');
    }
  }

  /**
   * Handle the existence check + force/clear pattern.
   * Returns true if the command should continue, false if it should return early.
   */
  protected checkExistingAndClear(
    ctx: LlmContext,
    opts: {
      entityName: string;
      existingCount: number;
      force: boolean;
      clearFn: () => void;
      forceHint?: string;
    }
  ): boolean {
    const { entityName, existingCount, force, clearFn, forceHint } = opts;
    const hint = forceHint ?? 'Use --force to re-run';

    if (existingCount > 0 && !force) {
      if (ctx.isJson) {
        this.log(
          JSON.stringify({
            error: `${entityName} already exist`,
            count: existingCount,
            hint,
          })
        );
      } else {
        this.log(chalk.yellow(`${existingCount} ${entityName.toLowerCase()} already exist.`));
        this.log(chalk.gray(`${hint}.`));
      }
      return false;
    }

    if (existingCount > 0 && force && !ctx.dryRun) {
      clearFn();
      if (!ctx.isJson && ctx.verbose) {
        this.log(chalk.gray(`Cleared ${existingCount} existing ${entityName.toLowerCase()}`));
      }
    }

    return true;
  }
}
