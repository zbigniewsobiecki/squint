import { type GroundTruthRelationship, defKey } from '../../harness/types.js';

/**
 * Ground truth for the `relationship_annotations` table after running
 * `squint ingest --to-stage relationships` against the bookstore-api fixture.
 *
 * Relationships are derived from two sources:
 *   1. AST-detected inheritance (extends) — 9 edges from parse stage
 *   2. LLM-annotated usage (uses) — discovered by the relationships stage
 *
 * The extends edges are deterministic. The uses edges are the LLM's
 * interpretation of which definitions depend on which — more variable.
 *
 * Severity (compareRelationshipAnnotations):
 *   - Missing GT relationship → CRITICAL
 *   - Semantic prose drift → MINOR
 */
export const relationships: GroundTruthRelationship[] = [
  // ============================================================
  // extends (9 — from AST, deterministic)
  // ============================================================
  {
    fromDef: defKey('app/controllers/api/base_controller.rb', 'BaseController'),
    toDef: defKey('app/controllers/application_controller.rb', 'ApplicationController'),
    relationshipType: 'extends',
    semanticReference:
      'API base controller inherits authentication and response infrastructure from the application controller',
  },
  {
    fromDef: defKey('app/controllers/api/books_controller.rb', 'BooksController'),
    toDef: defKey('app/controllers/api/base_controller.rb', 'BaseController'),
    relationshipType: 'extends',
    semanticReference:
      'Books controller inherits JSON response helpers and authentication from the API base controller',
  },
  {
    fromDef: defKey('app/controllers/api/orders_controller.rb', 'OrdersController'),
    toDef: defKey('app/controllers/api/base_controller.rb', 'BaseController'),
    relationshipType: 'extends',
    semanticReference:
      'Orders controller inherits JSON response helpers and authentication from the API base controller',
  },
  {
    fromDef: defKey('app/controllers/api/sessions_controller.rb', 'SessionsController'),
    toDef: defKey('app/controllers/api/base_controller.rb', 'BaseController'),
    relationshipType: 'extends',
    semanticReference: 'Sessions controller inherits JSON response helpers from the API base controller',
  },
  {
    fromDef: defKey('app/models/author.rb', 'Author'),
    toDef: defKey('app/models/application_record.rb', 'ApplicationRecord'),
    relationshipType: 'extends',
    semanticReference: 'Author model inherits ActiveRecord persistence from the application record base class',
  },
  {
    fromDef: defKey('app/models/book.rb', 'Book'),
    toDef: defKey('app/models/application_record.rb', 'ApplicationRecord'),
    relationshipType: 'extends',
    semanticReference: 'Book model inherits ActiveRecord persistence from the application record base class',
  },
  {
    fromDef: defKey('app/models/order.rb', 'Order'),
    toDef: defKey('app/models/application_record.rb', 'ApplicationRecord'),
    relationshipType: 'extends',
    semanticReference: 'Order model inherits ActiveRecord persistence from the application record base class',
  },
  {
    fromDef: defKey('app/models/order_item.rb', 'OrderItem'),
    toDef: defKey('app/models/application_record.rb', 'ApplicationRecord'),
    relationshipType: 'extends',
    semanticReference: 'OrderItem model inherits ActiveRecord persistence from the application record base class',
  },
  {
    fromDef: defKey('app/models/user.rb', 'User'),
    toDef: defKey('app/models/application_record.rb', 'ApplicationRecord'),
    relationshipType: 'extends',
    semanticReference: 'User model inherits ActiveRecord persistence from the application record base class',
  },

  // NOTE: No `uses` edges in this GT. Rails Zeitwerk autoloading means
  // there are 0 parse-time imports — squint has no static evidence to
  // build cross-file `uses` relationships from at the relationships stage.
  // Cross-file dependencies surface at the interactions stage (iter 6)
  // where the LLM infers module-pair edges from code analysis.
  // This is a genuine difference between Rails and Express — the TS
  // fixture has 36 imports → 27 uses edges; the Rails fixture has 0.
];
