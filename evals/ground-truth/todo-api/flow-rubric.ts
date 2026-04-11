import type { FlowRubricEntry } from '../../harness/types.js';

/**
 * Theme-search ground truth for the LLM-driven flows stage.
 *
 * The flows stage produces a small number of HIGH-LEVEL journey descriptions
 * with LLM-picked names, slugs, and entry paths — none of which are
 * deterministic. The rubric uses theme-search matching: for each entry, the
 * comparator finds the produced flow whose name+description best matches
 * the expected role and verifies its stakeholder.
 *
 * todo-api has 2 user-facing concept areas (auth + tasks). The rubric
 * asserts at least one user-stakeholder flow per area. Iter-by-iter the
 * LLM may produce additional system/external flows for middleware,
 * router, base controller, etc. — those are extras (ignored).
 *
 * Severity (compareFlowRubric):
 *   - No flow matches expected theme  → CRITICAL
 *   - Best match's stakeholder wrong  → MAJOR
 */
export const flowRubric: FlowRubricEntry[] = [
  {
    label: 'user-authentication',
    expectedRole: 'A user-facing journey for authentication: registration, login, or identity lookup',
    // Accept 'user' OR 'external' — the LLM sometimes tags an
    // authentication journey as 'external' (the external actor calling in)
    // and sometimes as 'user' (the human behind that actor).
    acceptableStakeholders: ['user', 'external'],
  },
  {
    label: 'user-task-management',
    expectedRole:
      'A user-facing journey for task management: listing, creating, updating, completing, or deleting tasks',
    acceptableStakeholders: ['user', 'external'],
  },
];
