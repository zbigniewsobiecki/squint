import type { GroundTruthRelationship } from '../../harness/types.js';
import { assertedRelationship } from '../_shared/assertion-builders.js';

/**
 * Ground truth for the `relationship_annotations` table after running
 * `squint ingest --to-stage relationships` against the bookstore-api fixture.
 *
 * PR4: migrated from `semanticReference` prose-similarity to property-based
 * assertions. Each `extends` edge asserts factual properties about the
 * inheritance relationship's semantic field — what concepts must appear,
 * what concepts must NOT appear — instead of trying to paraphrase the LLM's
 * exact wording.
 *
 * 9 extends edges (deterministic from AST). No `uses` edges in this GT
 * because Rails Zeitwerk autoloading means there are 0 parse-time imports —
 * cross-file deps surface at the interactions stage (iter 6).
 *
 * Severity (compareRelationshipAnnotations):
 *   - Missing GT relationship → CRITICAL
 *   - Assertion failure → MINOR (counted in proseChecks.failed)
 */
export const relationships: GroundTruthRelationship[] = [
  // ============================================================
  // Controller inheritance (4 edges)
  // ============================================================
  assertedRelationship(
    'app/controllers/api/base_controller.rb',
    'BaseController',
    'app/controllers/application_controller.rb',
    'ApplicationController',
    'extends',
    {
      anyOf: ['inherit', 'shared', 'common', 'controller'],
    }
  ),
  assertedRelationship(
    'app/controllers/api/books_controller.rb',
    'BooksController',
    'app/controllers/api/base_controller.rb',
    'BaseController',
    'extends',
    {
      anyOf: ['inherit', 'shared', 'json', 'response', 'helper', 'controller'],
    }
  ),
  assertedRelationship(
    'app/controllers/api/orders_controller.rb',
    'OrdersController',
    'app/controllers/api/base_controller.rb',
    'BaseController',
    'extends',
    {
      anyOf: ['inherit', 'shared', 'json', 'response', 'helper', 'controller'],
    }
  ),
  assertedRelationship(
    'app/controllers/api/sessions_controller.rb',
    'SessionsController',
    'app/controllers/api/base_controller.rb',
    'BaseController',
    'extends',
    {
      anyOf: ['inherit', 'shared', 'json', 'response', 'helper', 'controller'],
    }
  ),

  // ============================================================
  // Model inheritance from ApplicationRecord (5 edges)
  // ============================================================
  // PR4 calibration: the LLM writes generic descriptions like "Inherits
  // ActiveRecord features..." without naming the child class. We rely on
  // the anyOf to capture the inheritance intent, no `mentions:`.
  assertedRelationship(
    'app/models/author.rb',
    'Author',
    'app/models/application_record.rb',
    'ApplicationRecord',
    'extends',
    {
      anyOf: ['inherit', 'active', 'persist', 'database', 'orm', 'feature', 'callback', 'query'],
    }
  ),
  assertedRelationship(
    'app/models/book.rb',
    'Book',
    'app/models/application_record.rb',
    'ApplicationRecord',
    'extends',
    {
      anyOf: ['inherit', 'active', 'persist', 'database', 'orm', 'feature', 'callback', 'query'],
    }
  ),
  assertedRelationship(
    'app/models/order.rb',
    'Order',
    'app/models/application_record.rb',
    'ApplicationRecord',
    'extends',
    {
      anyOf: ['inherit', 'active', 'persist', 'database', 'orm', 'feature', 'callback', 'query'],
    }
  ),
  assertedRelationship(
    'app/models/order_item.rb',
    'OrderItem',
    'app/models/application_record.rb',
    'ApplicationRecord',
    'extends',
    {
      anyOf: ['inherit', 'active', 'persist', 'database', 'orm', 'feature', 'callback', 'query'],
    }
  ),
  assertedRelationship(
    'app/models/user.rb',
    'User',
    'app/models/application_record.rb',
    'ApplicationRecord',
    'extends',
    {
      anyOf: ['inherit', 'active', 'persist', 'database', 'orm', 'feature', 'callback', 'query'],
    }
  ),

  // NOTE: No `uses` edges in this GT (see file header).
];
