/**
 * Shared utility for grouping modules by business entity.
 * Extracted from interactions.ts for reuse in flow-validator.ts.
 */

import type { Module } from '../../../db/schema.js';

/**
 * Common entity patterns to extract from module paths.
 */
const entityPatterns = [
  /\.(users?|accounts?|auth)[-.]?/i,
  /\.(customers?|clients?)[-.]?/i,
  /\.(products?|items?|inventory)[-.]?/i,
  /\.(orders?|purchases?)[-.]?/i,
  /\.(sales?)[-.]?/i,
  /\.(vehicles?)[-.]?/i,
  /\.(payments?|billing)[-.]?/i,
  /\.(notifications?|alerts?)[-.]?/i,
  /\.(reports?|analytics?)[-.]?/i,
  /\.(settings?|config)[-.]?/i,
];

/**
 * Normalize entity names for grouping.
 */
function normalizeEntity(match: string): string {
  const entity = match.replace(/^\./, '').replace(/[-.]$/, '').toLowerCase();
  if (/^(users?|accounts?|auth)$/i.test(entity)) return 'User';
  if (/^(customers?|clients?)$/i.test(entity)) return 'Customer';
  if (/^(products?|items?|inventory)$/i.test(entity)) return 'Product';
  if (/^(orders?|purchases?)$/i.test(entity)) return 'Order';
  if (/^(sales?)$/i.test(entity)) return 'Sales';
  if (/^(vehicles?)$/i.test(entity)) return 'Vehicle';
  if (/^(payments?|billing)$/i.test(entity)) return 'Payment';
  if (/^(notifications?|alerts?)$/i.test(entity)) return 'Notification';
  if (/^(reports?|analytics?)$/i.test(entity)) return 'Report';
  if (/^(settings?|config)$/i.test(entity)) return 'Settings';
  return entity.charAt(0).toUpperCase() + entity.slice(1);
}

/**
 * Group modules by entity name extracted from their path.
 * Returns a Map where keys are entity names (or '_generic' for non-entity modules).
 */
export function groupModulesByEntity(modules: Module[]): Map<string, Module[]> {
  const groups = new Map<string, Module[]>();

  for (const mod of modules) {
    let entityFound = false;

    for (const pattern of entityPatterns) {
      const match = mod.fullPath.match(pattern);
      if (match) {
        const entity = normalizeEntity(match[0]);
        if (!groups.has(entity)) {
          groups.set(entity, []);
        }
        groups.get(entity)!.push(mod);
        entityFound = true;
        break;
      }
    }

    if (!entityFound) {
      if (!groups.has('_generic')) {
        groups.set('_generic', []);
      }
      groups.get('_generic')!.push(mod);
    }
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
