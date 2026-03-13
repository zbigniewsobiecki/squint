import type { Command } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase } from '../../../db/database-facade.js';
import type { EnrichedModuleCallEdge } from '../../../db/schema.js';
import { getErrorMessage } from '../../llm/_shared/llm-utils.js';
import { type InteractionSuggestion, createDefaultInteraction, generateAstSemantics } from './ast-semantics.js';

/**
 * Process a list of enriched edges through the LLM batch loop to produce
 * InteractionSuggestion[]. Falls back to createDefaultInteraction() on error.
 */
export async function processBatchSemantics(
  enrichedEdges: EnrichedModuleCallEdge[],
  batchSize: number,
  model: string,
  db: IndexDatabase,
  command: Command,
  isJson: boolean,
  verbose: boolean
): Promise<InteractionSuggestion[]> {
  const interactions: InteractionSuggestion[] = [];

  for (let i = 0; i < enrichedEdges.length; i += batchSize) {
    const batch = enrichedEdges.slice(i, i + batchSize);
    try {
      const batchIdx = Math.floor(i / batchSize);
      const totalBatches = Math.ceil(enrichedEdges.length / batchSize);
      const suggestions = await generateAstSemantics(batch, model, db, command, isJson, batchIdx + 1, totalBatches);
      interactions.push(...suggestions);

      if (!isJson && verbose) {
        command.log(
          chalk.gray(`  Batch ${Math.floor(i / batchSize) + 1}: Generated ${suggestions.length} interactions`)
        );
      }
    } catch (error) {
      const message = getErrorMessage(error);
      if (!isJson) {
        command.log(chalk.yellow(`  Batch ${Math.floor(i / batchSize) + 1} failed: ${message}`));
      }
      for (const edge of batch) {
        interactions.push(createDefaultInteraction(edge));
      }
    }
  }

  return interactions;
}

/**
 * Tag interactions involving test modules by overriding their pattern to
 * 'test-internal' in-place. Optionally logs the count when verbose is true.
 */
export function tagTestInternalInteractions(
  interactions: InteractionSuggestion[],
  testModuleIds: Set<number>,
  opts?: { command?: Command; isJson?: boolean; verbose?: boolean }
): void {
  if (testModuleIds.size === 0) return;

  for (const interaction of interactions) {
    if (testModuleIds.has(interaction.fromModuleId) || testModuleIds.has(interaction.toModuleId)) {
      interaction.pattern = 'test-internal';
    }
  }

  if (opts?.command && opts?.verbose && !opts?.isJson) {
    const testInternalCount = interactions.filter((i) => i.pattern === 'test-internal').length;
    if (testInternalCount > 0) {
      opts.command.log(chalk.gray(`  Tagged ${testInternalCount} interactions as test-internal`));
    }
  }
}

/**
 * Persist interactions to the database via upsert, then sync inheritance
 * interactions. No-ops when dryRun is true.
 */
export function persistInteractions(
  db: IndexDatabase,
  interactions: InteractionSuggestion[],
  verbose: boolean,
  isJson: boolean,
  dryRun: boolean,
  command?: Command
): void {
  if (dryRun) return;

  for (const interaction of interactions) {
    try {
      db.interactions.upsert(interaction.fromModuleId, interaction.toModuleId, {
        weight: interaction.weight,
        pattern: interaction.pattern,
        symbols: interaction.symbols,
        semantic: interaction.semantic,
      });
    } catch {
      if (verbose && !isJson && command) {
        command.log(chalk.yellow(`  Skipping duplicate: ${interaction.fromModulePath} → ${interaction.toModulePath}`));
      }
    }
  }

  // Create inheritance-based interactions (extends/implements)
  const inheritanceResult = db.interactionAnalysis.syncInheritanceInteractions();
  if (!isJson && verbose && inheritanceResult.created > 0 && command) {
    command.log(chalk.gray(`  Inheritance edges: ${inheritanceResult.created}`));
  }
}
