/**
 * Tree Phase: Generate the module tree structure.
 */

import type { Command } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../../db/database.js';
import type { LlmLogOptions } from '../../llm/_shared/llm-utils.js';
import { completeWithLogging, getErrorMessage, logLlmRequest, logLlmResponse } from '../../llm/_shared/llm-utils.js';
import { parseTreeCsv } from '../../llm/_shared/module-csv.js';
import {
  type DirectoryInfo,
  type DomainSummary,
  type TreeGenerationContext,
  buildTreeSystemPrompt,
  buildTreeUserPrompt,
} from '../../llm/_shared/module-prompts.js';

export interface TreePhaseContext {
  db: IndexDatabase;
  command: Command;
  model: string;
  dryRun: boolean;
  isJson: boolean;
  verbose: boolean;
  llmLogOptions: LlmLogOptions;
  maxModules: number;
}

/**
 * Execute the tree generation phase.
 */
export async function runTreePhase(ctx: TreePhaseContext): Promise<void> {
  const { db, command, model, dryRun, isJson, verbose, llmLogOptions, maxModules } = ctx;

  if (!isJson) {
    command.log(chalk.bold('Phase 1: Tree Structure Generation'));
  }

  // Ensure root module exists
  if (!dryRun) {
    db.modules.ensureRoot();
  }

  // Gather context for the LLM
  const context = buildTreeContext(db, maxModules);

  if (context.totalSymbolCount === 0) {
    if (isJson) {
      command.log(JSON.stringify({ error: 'No symbols found in database' }));
    } else {
      command.log(chalk.yellow('No symbols found in database.'));
    }
    return;
  }

  if (!isJson && verbose) {
    command.log(chalk.gray(`  Total symbols: ${context.totalSymbolCount}`));
    command.log(chalk.gray(`  Domains found: ${context.domains.length}`));
  }

  // Build prompts
  const systemPrompt = buildTreeSystemPrompt();
  const userPrompt = buildTreeUserPrompt(context);

  if (verbose && !isJson) {
    command.log(chalk.gray('  Calling LLM for tree structure...'));
  }

  logLlmRequest(command, 'runTreePhase', systemPrompt, userPrompt, llmLogOptions);

  // Call LLM
  const response = await completeWithLogging({
    model,
    systemPrompt,
    userPrompt,
    temperature: 0,
    command,
    isJson,
  });

  logLlmResponse(command, 'runTreePhase', response, llmLogOptions);

  // Parse response
  const { modules: parsedModules, errors } = parseTreeCsv(response);

  if (errors.length > 0 && !isJson) {
    command.log(chalk.yellow(`  Parse warnings: ${errors.length}`));
    if (verbose) {
      for (const err of errors.slice(0, 5)) {
        command.log(chalk.gray(`    ${err}`));
      }
    }
  }

  if (parsedModules.length === 0) {
    if (isJson) {
      command.log(JSON.stringify({ error: 'No modules parsed from LLM response', parseErrors: errors }));
    } else {
      command.log(chalk.red('No modules parsed from LLM response.'));
    }
    return;
  }

  if (dryRun) {
    if (isJson) {
      command.log(
        JSON.stringify(
          {
            phase: 'tree',
            dryRun: true,
            proposedModules: parsedModules,
            parseErrors: errors,
          },
          null,
          2
        )
      );
    } else {
      command.log(chalk.gray(`  Proposed modules: ${parsedModules.length}`));
      command.log('');
      for (const mod of parsedModules) {
        const fullPath = `${mod.parentPath}.${mod.slug}`;
        command.log(chalk.cyan(`  ${fullPath}: ${mod.name}`));
        if (mod.description) {
          command.log(chalk.gray(`    ${mod.description}`));
        }
      }
    }
    return;
  }

  // Insert modules in order (parent before child)
  // Sort by parentPath length to ensure parents are created first
  const sortedModules = [...parsedModules].sort((a, b) => {
    const aDepth = a.parentPath.split('.').length;
    const bDepth = b.parentPath.split('.').length;
    return aDepth - bDepth;
  });

  let insertedCount = 0;
  for (const mod of sortedModules) {
    if (maxModules > 0 && db.modules.getCount() >= maxModules) {
      if (!isJson) {
        command.log(chalk.yellow(`  Reached max-modules limit (${maxModules}), stopping module creation`));
      }
      break;
    }

    const parent = db.modules.getByPath(mod.parentPath);
    if (!parent) {
      if (verbose && !isJson) {
        command.log(chalk.yellow(`  Skipping ${mod.slug}: parent ${mod.parentPath} not found`));
      }
      continue;
    }

    try {
      db.modules.insert(parent.id, mod.slug, mod.name, mod.description, mod.isTest);
      insertedCount++;
    } catch (error) {
      if (verbose && !isJson) {
        const message = getErrorMessage(error);
        command.log(chalk.yellow(`  Failed to insert ${mod.slug}: ${message}`));
      }
    }
  }

  if (!isJson) {
    command.log(chalk.green(`  Created ${insertedCount} modules`));
  }
}

/**
 * Build context for tree generation from database.
 */
export function buildTreeContext(db: IndexDatabase, maxModules?: number): TreeGenerationContext {
  // Get all annotated symbols
  const allSymbols = db.modules.getUnassigned();

  // Aggregate by domain
  const domainMap = new Map<
    string,
    {
      count: number;
      symbols: Array<{ name: string; kind: string; role: string | null }>;
    }
  >();

  for (const sym of allSymbols) {
    const domains = sym.domain ?? ['untagged'];
    for (const domain of domains) {
      const existing = domainMap.get(domain) ?? { count: 0, symbols: [] };
      existing.count++;
      if (existing.symbols.length < 10) {
        existing.symbols.push({ name: sym.name, kind: sym.kind, role: sym.role });
      }
      domainMap.set(domain, existing);
    }
  }

  // Convert to DomainSummary array, sorted by count
  const domains: DomainSummary[] = Array.from(domainMap.entries())
    .map(([domain, data]) => ({
      domain,
      count: data.count,
      sampleSymbols: data.symbols,
    }))
    .sort((a, b) => b.count - a.count);

  // Count symbols per leaf directory
  const dirCounts = new Map<string, number>();
  for (const sym of allSymbols) {
    const dir = sym.filePath.split('/').slice(0, -1).join('/');
    if (dir) dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1);
  }

  // Build DirectoryInfo[] — include all ancestor directories too, with cumulative counts
  const allDirs = new Set<string>();
  for (const sym of allSymbols) {
    const parts = sym.filePath.split('/');
    let dirPath = '';
    for (let i = 0; i < parts.length - 1; i++) {
      dirPath = dirPath ? `${dirPath}/${parts[i]}` : parts[i];
      allDirs.add(dirPath);
    }
  }

  const directoryStructure: DirectoryInfo[] = Array.from(allDirs)
    .sort()
    .map((dir) => ({
      path: dir,
      symbolCount: dirCounts.get(dir) ?? 0,
    }));

  return {
    totalSymbolCount: allSymbols.length,
    domains,
    directoryStructure,
    maxModules: maxModules && maxModules > 0 ? maxModules : undefined,
  };
}
