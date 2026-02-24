import type { DependencyContextEnhanced } from '../llm/_shared/prompts.js';
import { detectImpurePatterns } from '../llm/_shared/pure-check.js';

/**
 * Validate a value for a specific aspect.
 * Returns null if valid, or an error message string if invalid.
 *
 * For pure aspect validation, may return special override messages:
 * - "overridden to true: ..." - LLM said false, but should be true
 * - "overridden to false: ..." - LLM said true, but should be false
 * - "overridden: ..." - generic override
 */
export function validateAnnotationValue(
  aspect: string,
  value: string,
  sourceCode?: string,
  deps?: DependencyContextEnhanced[],
  kind?: string
): string | null {
  switch (aspect) {
    case 'domain':
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
          return 'domain must be a JSON array';
        }
        if (!parsed.every((d) => typeof d === 'string')) {
          return 'domain array must contain only strings';
        }
      } catch {
        return 'domain must be valid JSON array';
      }
      break;

    case 'pure':
      if (value !== 'true' && value !== 'false') {
        return 'pure must be "true" or "false"';
      }
      // Gate 0: type-level declarations are always pure
      if (value === 'false' && kind && (kind === 'type' || kind === 'interface' || kind === 'enum')) {
        return 'overridden to true: type-level declaration';
      }
      // Gate 0b: classes are always impure (instances have mutable state)
      if (value === 'true' && kind === 'class') {
        return 'overridden to false: class (mutable instances)';
      }
      // Gate 1: override LLM's "true" if source code contains impure patterns
      if (value === 'true' && sourceCode) {
        const impureReasons = detectImpurePatterns(sourceCode);
        if (impureReasons.length > 0) {
          return `overridden to false: ${impureReasons[0]}`;
        }
      }
      // Gate 2: transitive impurity — if any dependency is pure:false, this can't be pure:true
      if (value === 'true' && deps && deps.length > 0) {
        const impureDep = deps.find((d) => d.pure === false);
        if (impureDep) {
          return `overridden to false: calls impure dependency '${impureDep.name}'`;
        }
      }
      break;

    case 'purpose':
      if (!value || value.length < 5) {
        return 'purpose must be at least 5 characters';
      }
      break;

    case 'contracts':
      if (value === 'null') break;
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
          return 'contracts must be a JSON array or "null"';
        }
        for (const entry of parsed) {
          if (typeof entry !== 'object' || entry === null) {
            return 'each contract entry must be an object';
          }
          if (!entry.protocol || typeof entry.protocol !== 'string') {
            return 'each contract entry must have a non-empty "protocol" string';
          }
          if (!entry.role || typeof entry.role !== 'string') {
            return 'each contract entry must have a non-empty "role" string';
          }
          if (!entry.key || typeof entry.key !== 'string') {
            return 'each contract entry must have a non-empty "key" string';
          }
        }
      } catch {
        return 'contracts must be valid JSON array or "null"';
      }
      break;
  }

  return null;
}
