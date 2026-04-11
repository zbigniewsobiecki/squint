import type { FeatureCohesionGroup } from '../../harness/types.js';

/**
 * Theme-search ground truth for the LLM-driven features stage.
 *
 * Each entry asserts that there exists a feature whose name+description
 * matches a target concept. The comparator iterates all produced features
 * and picks the best theme-judge match. Robust to LLM-picked feature names
 * — accepts "Authentication" / "User Auth" / "Identity Management" all as
 * valid matches for the auth concept.
 *
 * todo-api has 2 user-facing concept areas (auth + tasks), so we expect
 * at least 2 features. The LLM may bundle them into 1 "Application" feature
 * or split them into multiple sub-features — both are valid as long as
 * the auth and tasks concepts are each represented somewhere.
 *
 * Severity (compareFeatureCohesion):
 *   - No feature matches expected theme → CRITICAL
 */
export const featureCohesion: FeatureCohesionGroup[] = [
  {
    label: 'authentication-feature',
    expectedRole: 'Feature for user authentication, registration, login, and identity management',
  },
  {
    label: 'task-management-feature',
    expectedRole: 'Feature for task management — creating, updating, completing, and deleting tasks',
  },
];
