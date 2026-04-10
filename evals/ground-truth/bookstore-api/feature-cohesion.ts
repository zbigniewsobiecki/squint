import type { FeatureCohesionGroup } from '../../harness/types.js';

/**
 * Theme-search ground truth for the LLM-driven features stage.
 *
 * The bookstore-api has 2 product features: catalog management and ordering.
 * Authentication may appear as a third feature or be folded into one of these.
 *
 * Severity (compareFeatureCohesion):
 *   - No feature matches expected theme → CRITICAL
 */
export const featureCohesion: FeatureCohesionGroup[] = [
  {
    label: 'catalog-feature',
    expectedRole: 'Feature for book catalog management: browsing, searching, CRUD operations on books and authors',
  },
  {
    label: 'ordering-feature',
    expectedRole: 'Feature for order placement: checkout, inventory management, order confirmation and notifications',
  },
];
