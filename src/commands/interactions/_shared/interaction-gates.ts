import type { IndexDatabase } from '../../../db/database-facade.js';
import type { Module } from '../../../db/schema.js';

const TYPE_KINDS = new Set(['interface', 'type', 'enum']);

/**
 * Check if a module contains only type definitions (interfaces, types, enums).
 * Type-only modules should never be the initiator of an interaction.
 */
export function isTypeOnlyModule(moduleId: number, db: IndexDatabase): boolean {
  const members = db.modules.getSymbols(moduleId);
  if (members.length === 0) return false;
  return members.every((m) => TYPE_KINDS.has(m.kind));
}

/**
 * Structural gate for inferred interactions.
 * Rejects duplicates, self-loops, reverse-of-AST interactions, and type-only initiators.
 */
export function gateInferredInteraction(
  fromModule: Module,
  toModule: Module,
  existingInteractionPairs: Set<string>,
  db: IndexDatabase
): { pass: boolean; reason?: string } {
  // Gate A — Duplicate
  const pairKey = `${fromModule.id}->${toModule.id}`;
  if (existingInteractionPairs.has(pairKey)) {
    return { pass: false, reason: 'duplicate' };
  }

  // Gate B — Self-loop
  if (fromModule.id === toModule.id) {
    return { pass: false, reason: 'self-loop' };
  }

  // Gate C — Reverse-of-AST
  const reverseInteraction = db.interactions.getByModules(toModule.id, fromModule.id);
  if (reverseInteraction && (reverseInteraction.source === 'ast' || reverseInteraction.source === 'ast-import')) {
    return { pass: false, reason: 'reverse-of-ast' };
  }

  // Gate D — Type-only module as initiator
  if (isTypeOnlyModule(fromModule.id, db)) {
    return { pass: false, reason: 'type-only-initiator' };
  }

  return { pass: true };
}
