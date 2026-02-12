/**
 * Shared utility for grouping modules by business entity.
 * Uses LLM-classified entity overrides when available, falls back to
 * extracting entities from module descriptions, then '_generic'.
 */

import type { Module } from '../../../db/schema.js';

/**
 * Extract an entity name from a module's description field.
 * Looks for the first meaningful noun-like word in the description.
 */
function extractEntityFromDescription(description: string | null): string | null {
  if (!description) return null;

  // Remove common prefixes and clean up
  const cleaned = description
    .replace(/^(manages?|handles?|provides?|contains?|implements?|defines?)\s+/i, '')
    .replace(/^(the|a|an)\s+/i, '')
    .trim();

  if (!cleaned) return null;

  // Take the first word as the entity candidate
  const firstWord = cleaned.split(/\s+/)[0]?.replace(/[^a-zA-Z]/g, '');
  if (!firstWord || firstWord.length < 3) return null;

  // Skip overly generic words
  const skipWords = new Set([
    'module',
    'component',
    'service',
    'utility',
    'helper',
    'shared',
    'common',
    'core',
    'base',
    'main',
    'index',
    'internal',
    'general',
    'various',
    'all',
    'other',
    'misc',
    'data',
    'logic',
    'code',
    'file',
    'type',
    'types',
    'interface',
    'config',
    'configuration',
    'state',
    'store',
    'context',
    'provider',
    'wrapper',
    'container',
    'layout',
    'root',
    'app',
    'application',
  ]);

  if (skipWords.has(firstWord.toLowerCase())) return null;

  // Capitalize first letter for consistency
  return firstWord.charAt(0).toUpperCase() + firstWord.slice(1).toLowerCase();
}

/**
 * Group modules by entity name.
 *
 * Priority:
 * 1. moduleEntityOverrides (from LLM classification) — highest priority
 * 2. Module description keyword extraction — fallback
 * 3. '_generic' — last resort
 *
 * Returns a Map where keys are entity names (or '_generic' for non-entity modules).
 */
export function groupModulesByEntity(
  modules: Module[],
  moduleEntityOverrides?: Map<number, string>
): Map<string, Module[]> {
  const groups = new Map<string, Module[]>();

  for (const mod of modules) {
    let entity: string | null = null;

    // Priority 1: LLM-classified override
    if (moduleEntityOverrides) {
      const override = moduleEntityOverrides.get(mod.id);
      if (override) {
        entity = override.charAt(0).toUpperCase() + override.slice(1).toLowerCase();
      }
    }

    // Priority 2: Extract from module description
    if (!entity) {
      entity = extractEntityFromDescription(mod.description);
    }

    // Priority 3: Fall back to '_generic'
    const key = entity ?? '_generic';

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(mod);
  }

  // Sort to put _generic last
  const sorted = new Map<string, Module[]>();
  for (const [key, value] of [...groups.entries()].sort((a, b) => {
    if (a[0] === '_generic') return 1;
    if (b[0] === '_generic') return -1;
    return a[0].localeCompare(b[0]);
  })) {
    sorted.set(key, value);
  }

  return sorted;
}
