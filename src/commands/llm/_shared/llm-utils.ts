/**
 * Shared utilities for LLM commands.
 * Consolidates duplicate patterns from flows.ts, interactions.ts, annotate.ts, etc.
 */

import type { Command } from '@oclif/core';
import chalk from 'chalk';
import { type LLMMessage, LLMist, type TokenUsage, resolveModel } from 'llmist';

/**
 * Safely extract error message from unknown error type.
 * Replaces the duplicated `error instanceof Error ? error.message : String(error)` pattern.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Calculate percentage with safety for division by zero.
 */
export function calculatePercentage(value: number, total: number, decimals = 1): number {
  if (total === 0) return 0;
  return Number(((value / total) * 100).toFixed(decimals));
}

/**
 * Create a lookup map from an array using a key function.
 */
export function createLookup<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T> {
  const map = new Map<K, T>();
  for (const item of items) {
    map.set(keyFn(item), item);
  }
  return map;
}

/**
 * Create a multi-value lookup map (groupBy) from an array.
 */
export function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const existing = map.get(key) ?? [];
    existing.push(item);
    map.set(key, existing);
  }
  return map;
}

/**
 * LLM request/response logging utilities.
 */
export interface LlmLogOptions {
  showRequests: boolean;
  showResponses: boolean;
  isJson: boolean;
}

/**
 * Display LLM request details if enabled.
 */
export function logLlmRequest(
  command: Command,
  methodName: string,
  systemPrompt: string,
  userPrompt: string,
  options: LlmLogOptions
): void {
  if (options.isJson || !options.showRequests) return;

  command.log('');
  command.log(chalk.bold.cyan('═'.repeat(60)));
  command.log(chalk.bold.cyan(`LLM REQUEST - ${methodName}`));
  command.log(chalk.bold.cyan('═'.repeat(60)));
  command.log('');
  command.log(chalk.cyan('System Prompt:'));
  command.log(chalk.gray(systemPrompt));
  command.log('');
  command.log(chalk.cyan('User Prompt:'));
  command.log(chalk.gray(userPrompt));
  command.log('');
}

/**
 * Display LLM response details if enabled.
 */
export function logLlmResponse(command: Command, methodName: string, response: string, options: LlmLogOptions): void {
  if (options.isJson || !options.showResponses) return;

  command.log('');
  command.log(chalk.bold.green('═'.repeat(60)));
  command.log(chalk.bold.green(`LLM RESPONSE - ${methodName}`));
  command.log(chalk.bold.green('═'.repeat(60)));
  command.log('');
  command.log(chalk.gray(response));
  command.log('');
}

/**
 * Log a warning message (for both JSON and non-JSON modes).
 */
export function logWarning(command: Command, message: string, isJson: boolean): void {
  if (isJson) {
    command.log(JSON.stringify({ warning: message }));
  } else {
    command.log(chalk.yellow(message));
  }
}

/**
 * Log an error message (for both JSON and non-JSON modes).
 */
export function logError(command: Command, message: string, hint: string | null, isJson: boolean): void {
  if (isJson) {
    command.log(JSON.stringify({ error: message, ...(hint && { hint }) }));
  } else {
    command.log(chalk.red(message));
    if (hint) {
      command.log(chalk.gray(hint));
    }
  }
}

/**
 * Log a step header for non-JSON output.
 */
export function logStep(command: Command, step: number, title: string, isJson: boolean): void {
  if (!isJson) {
    if (step > 1) command.log('');
    command.log(chalk.bold(`Step ${step}: ${title}`));
  }
}

/**
 * Log verbose progress message.
 */
export function logVerbose(command: Command, message: string, verbose: boolean, isJson: boolean): void {
  if (!isJson && verbose) {
    command.log(chalk.gray(message));
  }
}

/**
 * Log a section header.
 */
export function logSection(command: Command, title: string, isJson: boolean): void {
  if (!isJson) {
    command.log('');
    command.log(chalk.bold(title));
  }
}

/**
 * Batch processing helper - processes items in batches with progress reporting.
 */
export interface BatchProcessOptions<T, R> {
  items: T[];
  batchSize: number;
  processBatch: (batch: T[], batchIndex: number) => Promise<R[]>;
  onBatchComplete?: (results: R[], batchIndex: number, totalBatches: number) => void;
  onBatchError?: (error: unknown, batch: T[], batchIndex: number) => R[] | null;
}

export async function processBatches<T, R>(options: BatchProcessOptions<T, R>): Promise<R[]> {
  const { items, batchSize, processBatch, onBatchComplete, onBatchError } = options;
  const results: R[] = [];
  const totalBatches = Math.ceil(items.length / batchSize);

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchIndex = Math.floor(i / batchSize);

    try {
      const batchResults = await processBatch(batch, batchIndex);
      results.push(...batchResults);

      if (onBatchComplete) {
        onBatchComplete(batchResults, batchIndex, totalBatches);
      }
    } catch (error) {
      if (onBatchError) {
        const fallbackResults = onBatchError(error, batch, batchIndex);
        if (fallbackResults) {
          results.push(...fallbackResults);
        }
      } else {
        throw error;
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// completeWithLogging – wraps every LLM call with one-line before/after logs
// ---------------------------------------------------------------------------

let _client: LLMist | null = null;
function getClient(): LLMist {
  if (!_client) _client = new LLMist();
  return _client;
}

export interface CompleteWithLoggingOptions {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxTokens?: number;
  command: Command;
  isJson: boolean;
  iteration?: { current: number; max: number }; // max=0 means unlimited
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

function formatIterationTag(iter?: { current: number; max: number }): string {
  if (!iter) return '';
  if (iter.max === 0) return `  [${iter.current}]`;
  return `  [${iter.current}/${iter.max}]`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export async function completeWithLogging(options: CompleteWithLoggingOptions): Promise<string> {
  const { model, systemPrompt, userPrompt, temperature, maxTokens, command, isJson, iteration } = options;

  const estTokens = Math.round((systemPrompt.length + userPrompt.length) / 4);
  const iterTag = formatIterationTag(iteration);

  if (!isJson) {
    command.log(chalk.gray(`  → LLM  ${model}  ~${formatNumber(estTokens)} tok${iterTag}`));
  }

  const resolvedModel = resolveModel(model);
  const messages: LLMMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  const client = getClient();
  const startTime = Date.now();
  let text = '';
  let usage: TokenUsage | undefined;

  const stream = client.stream({
    model: resolvedModel,
    messages,
    ...(temperature !== undefined && { temperature }),
    ...(maxTokens !== undefined && { maxTokens }),
  });

  for await (const chunk of stream) {
    text += chunk.text;
    if (chunk.usage) {
      usage = chunk.usage;
    }
  }

  const duration = Date.now() - startTime;

  if (!isJson) {
    const inputTokens = usage?.inputTokens ?? 0;
    const outputTokens = usage?.outputTokens ?? 0;
    const cachedTokens = usage?.cachedInputTokens ?? 0;

    const costEstimate = client.modelRegistry.estimateCost(resolvedModel, inputTokens, outputTokens, cachedTokens);
    const costStr = costEstimate ? formatCost(costEstimate.totalCost) : '?';

    const parts = [
      `  ← LLM  ${formatDuration(duration)}`,
      `in: ${formatNumber(inputTokens)}`,
      `out: ${formatNumber(outputTokens)}`,
      `cached: ${formatNumber(cachedTokens)}`,
      costStr,
    ];

    command.log(chalk.gray(parts.join('  ') + iterTag));
  }

  return text.trim();
}

/**
 * Generate a unique slug from a name, handling duplicates.
 */
export function generateUniqueSlug(baseName: string, usedSlugs: Set<string>): string {
  const slug = baseName
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  if (!usedSlugs.has(slug)) {
    usedSlugs.add(slug);
    return slug;
  }

  let counter = 1;
  while (usedSlugs.has(`${slug}-${counter}`)) {
    counter++;
  }
  const uniqueSlug = `${slug}-${counter}`;
  usedSlugs.add(uniqueSlug);
  return uniqueSlug;
}
