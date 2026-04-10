import type { FlowRubricEntry } from '../../harness/types.js';

/**
 * Theme-search ground truth for the LLM-driven flows stage.
 *
 * The bookstore-api has 2 user-facing concept areas: book catalog + orders.
 * Authentication is simpler here (just sessions) so may or may not generate
 * a separate flow.
 *
 * Severity (compareFlowRubric):
 *   - No flow matches expected theme → CRITICAL
 *   - Best match's stakeholder wrong → MAJOR
 */
export const flowRubric: FlowRubricEntry[] = [
  {
    label: 'user-catalog-browsing',
    expectedRole:
      'A user-facing journey for browsing the book catalog: listing, searching, viewing book details, or managing books',
    acceptableStakeholders: ['user', 'admin', 'external'],
  },
  {
    label: 'user-checkout',
    expectedRole: 'A user-facing journey for placing an order: selecting books, checkout, and order confirmation',
    acceptableStakeholders: ['user', 'external'],
  },
];
