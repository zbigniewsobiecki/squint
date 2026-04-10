import type { GroundTruthModule } from '../../harness/types.js';

/**
 * Legacy module ground truth — not used by the module_cohesion comparator
 * but kept for backward compatibility with older strategies.
 *
 * The bookstore-api uses the moduleCohesion rubric (virtual table) instead
 * of strict module matching, so this array is intentionally empty.
 */
export const modules: GroundTruthModule[] = [];
