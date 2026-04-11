import type { GroundTruthContract } from '../../harness/types.js';

/**
 * Ground truth for the `contracts` and `contract_participants` tables after
 * running `squint ingest --to-stage contracts` against the bookstore-api fixture.
 *
 * The bookstore-api exposes 11 HTTP endpoints across 3 API controllers
 * (books, orders, sessions) plus the restock custom member route.
 *
 * NOTE: Rails routes are detected by the LLM contract extractor from the
 * routes.rb DSL and controller action definitions. The exact normalized
 * keys may vary (e.g., `/api/books` vs `/books`) depending on whether
 * the LLM resolves the namespace prefix. Contracts below are authored
 * COLD and will be calibrated against the first cold-run output.
 *
 * Async side effects (mailer, background job) are marked optional because
 * the LLM may or may not detect them as cross-process contracts.
 */
export const contracts: GroundTruthContract[] = [
  // ============================================================
  // HTTP — Books CRUD + restock (6)
  // ============================================================
  { protocol: 'http', normalizedKey: 'GET /books' },
  { protocol: 'http', normalizedKey: 'GET /books/{param}' },
  { protocol: 'http', normalizedKey: 'POST /books' },
  { protocol: 'http', normalizedKey: 'PUT /books/{param}' },
  { protocol: 'http', normalizedKey: 'DELETE /books/{param}' },
  { protocol: 'http', normalizedKey: 'POST /books/{param}/restock' },

  // ============================================================
  // HTTP — Orders (3)
  // ============================================================
  { protocol: 'http', normalizedKey: 'GET /orders' },
  { protocol: 'http', normalizedKey: 'GET /orders/{param}' },
  { protocol: 'http', normalizedKey: 'POST /orders' },

  // ============================================================
  // HTTP — Sessions (2)
  // ============================================================
  { protocol: 'http', normalizedKey: 'POST /sessions' },
  { protocol: 'http', normalizedKey: 'DELETE /sessions' },
];
