import type { FlowRubricEntry } from '../../harness/types.js';

/**
 * Theme-search ground truth for the LLM-driven flows stage.
 *
 * The bookstore-api's flows stage produces a mix of system inheritance flows
 * (model→ApplicationRecord) and external-stakeholder CRUD flows (create book,
 * create order). The rubric matches the two external-facing flows since those
 * are the cross-cutting journeys that exercise the interaction pipeline.
 *
 * Severity (compareFlowRubric):
 *   - No flow matches expected theme → CRITICAL
 *   - Best match's stakeholder wrong → MAJOR
 */
export const flowRubric: FlowRubricEntry[] = [
  {
    label: 'external-book-management',
    expectedRole: 'A flow for creating or managing books in the catalog',
    acceptableStakeholders: ['user', 'admin', 'external', 'system'],
  },
  {
    label: 'external-order-creation',
    expectedRole: 'A flow for creating or placing an order',
    acceptableStakeholders: ['user', 'external', 'system'],
  },
];
