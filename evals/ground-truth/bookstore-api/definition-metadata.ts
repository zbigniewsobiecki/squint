import type { GroundTruthDefinitionMetadata } from '../../harness/types.js';
import { assertedDomain, assertedPurpose, exactPure } from '../_shared/assertion-builders.js';

/**
 * Ground truth for the `definition_metadata` table after running
 * `squint ingest --to-stage symbols` against the bookstore-api fixture.
 *
 * PR4: migrated from prose-similarity grading to property-based assertions.
 * Each entry asserts factual properties about the produced output (does it
 * mention the right concepts; does it ban the wrong ones) instead of trying
 * to paraphrase the LLM's exact phrasing. This catches the Author→user-management
 * bug class while letting any defensible LLM phrasing pass.
 *
 * Three metadata aspects per definition:
 *   - purpose: assertedPurpose with `mentions`/`anyOf`/`forbids`
 *   - domain:  assertedDomain with `anyOf`/`noneOf`
 *   - pure:    exactPure with a boolean
 *
 * Only class-level and significant method-level definitions get full
 * coverage. Minor utility methods get purpose-only.
 */
export const definitionMetadata: GroundTruthDefinitionMetadata[] = [
  // ============================================================
  // Models — ApplicationRecord
  // ============================================================
  assertedPurpose('app/models/application_record.rb', 'ApplicationRecord', {
    anyOf: ['base', 'abstract', 'parent'],
    mentions: ['active'], // ActiveRecord-specific
    forbids: ['concrete instance', 'specific entity'],
  }),
  assertedDomain('app/models/application_record.rb', 'ApplicationRecord', {
    anyOf: ['persistence', 'database', 'base', 'orm', 'active'],
    noneOf: ['catalog', 'order', 'auth', 'session', 'controller'],
  }),
  exactPure('app/models/application_record.rb', 'ApplicationRecord', false),
  assertedPurpose('app/models/application_record.rb', 'recent', {
    anyOf: ['recent', 'newest', 'order', 'created', 'date'],
  }),
  // recent.pure omitted: LLM flip-flops (returns a scope — lazy vs. executes a query)

  // ============================================================
  // Models — Book
  // ============================================================
  assertedPurpose('app/models/book.rb', 'Book', {
    mentions: ['book'],
    anyOf: ['catalog', 'inventory', 'stock', 'isbn', 'title', 'price'],
    forbids: ['user account', 'authentication'],
  }),
  assertedDomain('app/models/book.rb', 'Book', {
    anyOf: ['catalog', 'inventory', 'book', 'product', 'bookstore'],
    noneOf: ['user', 'auth', 'session', 'identity', 'profile', 'account'],
  }),
  exactPure('app/models/book.rb', 'Book', false),
  assertedPurpose('app/models/book.rb', 'price', {
    anyOf: ['price', 'cents', 'dollar', 'currency', 'amount'],
  }),
  exactPure('app/models/book.rb', 'price', true),
  assertedPurpose('app/models/book.rb', 'in_stock?', {
    anyOf: ['stock', 'available', 'in stock', 'inventory'],
  }),
  exactPure('app/models/book.rb', 'in_stock?', true),
  assertedPurpose('app/models/book.rb', 'reserve_stock!', {
    anyOf: ['stock', 'reserve', 'decrement', 'reduce', 'inventory'],
  }),
  exactPure('app/models/book.rb', 'reserve_stock!', false),
  assertedPurpose('app/models/book.rb', 'InsufficientStockError', {
    anyOf: ['error', 'stock', 'insufficient', 'exception', 'raised'],
  }),
  exactPure('app/models/book.rb', 'InsufficientStockError', false),

  // ============================================================
  // Models — Author (the canonical PR4 motivating case)
  // ============================================================
  assertedPurpose('app/models/author.rb', 'Author', {
    mentions: ['author'],
    anyOf: ['book', 'name', 'bio', 'catalog'],
    forbids: ['user account', 'authentication', 'login', 'password'],
  }),
  // The PR4 canary: the LLM keeps tagging Author as ['database-models',
  // 'user-management']. We accept ANY defensible tag (concept-specific OR
  // type-specific), and ban the specific phrases the LLM uses incorrectly.
  // - 'user-management' is wrong (Author isn't a user)
  // - 'database-models' is fine (Author IS an AR model)
  assertedDomain('app/models/author.rb', 'Author', {
    anyOf: [
      'author',
      'catalog',
      'book',
      'bookstore',
      'library',
      'model',
      'persistence',
      'database',
      'active-record',
      'entity',
      'storage',
    ],
    noneOf: ['user-management', 'authentication', 'login', 'password', 'session-management'],
  }),
  exactPure('app/models/author.rb', 'Author', false),
  // book_count.pure omitted: LLM flip-flops (calls `books.count` — AR scope query vs. plain count)
  assertedPurpose('app/models/author.rb', 'full_display_name', {
    anyOf: ['name', 'display', 'format', 'bio', 'truncate'],
  }),
  exactPure('app/models/author.rb', 'full_display_name', true),

  // ============================================================
  // Models — User (the inverse case for any-of/none-of)
  // ============================================================
  assertedPurpose('app/models/user.rb', 'User', {
    mentions: ['user'],
    anyOf: ['account', 'authentication', 'password', 'order'],
  }),
  assertedDomain('app/models/user.rb', 'User', {
    anyOf: ['user', 'auth', 'identity', 'account', 'authentication'],
    noneOf: ['catalog', 'inventory', 'book'],
  }),
  exactPure('app/models/user.rb', 'User', false),
  assertedPurpose('app/models/user.rb', 'authenticate', {
    mentions: ['user'],
    anyOf: ['authenticate', 'password', 'verify', 'lookup', 'email'],
  }),
  exactPure('app/models/user.rb', 'authenticate', false),
  // total_spent.pure omitted: LLM flip-flops (calls `orders.where(...).sum(...)` — AR query vs. aggregation)
  assertedPurpose('app/models/user.rb', 'admin?', {
    anyOf: ['admin', 'role', 'check'],
  }),
  exactPure('app/models/user.rb', 'admin?', true),

  // ============================================================
  // Models — Order
  // ============================================================
  assertedPurpose('app/models/order.rb', 'Order', {
    mentions: ['order'],
    anyOf: ['purchase', 'status', 'item', 'checkout'],
  }),
  assertedDomain('app/models/order.rb', 'Order', {
    anyOf: ['order', 'purchase', 'commerce', 'shopping', 'checkout'],
    noneOf: ['user-management', 'session', 'identity', 'auth'],
  }),
  exactPure('app/models/order.rb', 'Order', false),
  exactPure('app/models/order.rb', 'confirm!', false),
  assertedPurpose('app/models/order.rb', 'cancel!', {
    anyOf: ['cancel', 'restore', 'rollback', 'order'],
  }),
  exactPure('app/models/order.rb', 'cancel!', false),
  // item_count.pure omitted: LLM flip-flops (delegates to .sum() — query vs. aggregation)

  // ============================================================
  // Models — OrderItem
  // ============================================================
  assertedPurpose('app/models/order_item.rb', 'OrderItem', {
    anyOf: ['order', 'item', 'line', 'join', 'quantity'],
  }),
  assertedDomain('app/models/order_item.rb', 'OrderItem', {
    anyOf: ['order', 'item', 'line', 'cart', 'commerce', 'purchase'],
    noneOf: ['user', 'auth', 'session', 'identity'],
  }),
  exactPure('app/models/order_item.rb', 'OrderItem', false),
  assertedPurpose('app/models/order_item.rb', 'subtotal_cents', {
    anyOf: ['subtotal', 'multiply', 'quantity', 'price', 'cents'],
  }),
  exactPure('app/models/order_item.rb', 'subtotal_cents', true),

  // ============================================================
  // Controllers — ApplicationController
  // ============================================================
  assertedPurpose('app/controllers/application_controller.rb', 'ApplicationController', {
    mentions: ['controller'],
    anyOf: ['base', 'authentication', 'request', 'api'],
  }),
  assertedDomain('app/controllers/application_controller.rb', 'ApplicationController', {
    anyOf: ['controller', 'http', 'api', 'base', 'request'],
    noneOf: ['catalog', 'inventory', 'order', 'cart'],
  }),
  exactPure('app/controllers/application_controller.rb', 'ApplicationController', false),
  assertedPurpose('app/controllers/application_controller.rb', 'authenticate!', {
    anyOf: ['authenticate', 'reject', '401', 'unauthorized', 'before_action', 'before action', 'filter'],
  }),
  exactPure('app/controllers/application_controller.rb', 'authenticate!', false),
  assertedPurpose('app/controllers/application_controller.rb', 'current_user', {
    mentions: ['user'],
    anyOf: ['authenticated', 'token', 'authorization', 'header', 'memoiz'],
  }),
  exactPure('app/controllers/application_controller.rb', 'current_user', false),

  // ============================================================
  // Controllers — Api::BaseController
  // ============================================================
  assertedPurpose('app/controllers/api/base_controller.rb', 'BaseController', {
    mentions: ['controller'],
    anyOf: ['base', 'shared', 'api', 'json', 'response', 'helper'],
  }),
  assertedDomain('app/controllers/api/base_controller.rb', 'BaseController', {
    anyOf: ['controller', 'api', 'http', 'base', 'response'],
    noneOf: ['catalog', 'order', 'cart', 'auth-only'],
  }),
  exactPure('app/controllers/api/base_controller.rb', 'BaseController', false),

  // ============================================================
  // Controllers — Api::BooksController
  // ============================================================
  assertedPurpose('app/controllers/api/books_controller.rb', 'BooksController', {
    mentions: ['book'],
    anyOf: ['controller', 'crud', 'rest', 'api', 'endpoint', 'manage', 'handle', 'http', 'request'],
  }),
  assertedDomain('app/controllers/api/books_controller.rb', 'BooksController', {
    anyOf: ['book', 'catalog', 'controller', 'api', 'inventory', 'resource', 'management', 'http', 'rest'],
    noneOf: ['user-management', 'session-management', 'authentication-only'],
  }),
  exactPure('app/controllers/api/books_controller.rb', 'BooksController', false),

  // ============================================================
  // Controllers — Api::OrdersController
  // ============================================================
  assertedPurpose('app/controllers/api/orders_controller.rb', 'OrdersController', {
    mentions: ['order'],
    anyOf: [
      'controller',
      'rest',
      'endpoint',
      'checkout',
      'service',
      'manage',
      'handle',
      'http',
      'request',
      'api',
      'interface',
    ],
  }),
  assertedDomain('app/controllers/api/orders_controller.rb', 'OrdersController', {
    anyOf: ['order', 'purchase', 'controller', 'api', 'commerce', 'management', 'resource', 'http', 'rest'],
    noneOf: ['user-management', 'session-management', 'authentication-only', 'identity-management'],
  }),
  exactPure('app/controllers/api/orders_controller.rb', 'OrdersController', false),

  // ============================================================
  // Controllers — Api::SessionsController
  // ============================================================
  assertedPurpose('app/controllers/api/sessions_controller.rb', 'SessionsController', {
    anyOf: ['session', 'login', 'logout', 'authentication', 'authenticate'],
  }),
  assertedDomain('app/controllers/api/sessions_controller.rb', 'SessionsController', {
    anyOf: ['session', 'auth', 'login', 'identity'],
    noneOf: ['catalog', 'inventory', 'book', 'cart'],
  }),
  exactPure('app/controllers/api/sessions_controller.rb', 'SessionsController', false),

  // ============================================================
  // Services — CheckoutService
  // ============================================================
  assertedPurpose('app/services/checkout_service.rb', 'CheckoutService', {
    mentions: ['checkout'],
    anyOf: ['order', 'service', 'orchestrate', 'stock', 'inventory'],
  }),
  assertedDomain('app/services/checkout_service.rb', 'CheckoutService', {
    anyOf: ['checkout', 'order', 'service', 'business', 'commerce'],
    noneOf: ['user-management', 'auth-only', 'session'],
  }),
  exactPure('app/services/checkout_service.rb', 'CheckoutService', false),
  assertedPurpose('app/services/checkout_service.rb', 'call', {
    anyOf: ['checkout', 'order', 'execute', 'orchestrate', 'stock', 'flow'],
  }),
  exactPure('app/services/checkout_service.rb', 'call', false),
  assertedPurpose('app/services/checkout_service.rb', 'success?', {
    anyOf: ['success', 'complete', 'error', 'check'],
  }),
  exactPure('app/services/checkout_service.rb', 'success?', true),

  // ============================================================
  // Services — InventoryService
  // ============================================================
  assertedPurpose('app/services/inventory_service.rb', 'InventoryService', {
    mentions: ['stock'],
    anyOf: ['inventory', 'reserve', 'check', 'low'],
  }),
  assertedDomain('app/services/inventory_service.rb', 'InventoryService', {
    anyOf: ['inventory', 'stock', 'service', 'business'],
    noneOf: ['user-management', 'auth-only', 'session'],
  }),
  exactPure('app/services/inventory_service.rb', 'InventoryService', false),
  assertedPurpose('app/services/inventory_service.rb', 'check_stock', {
    mentions: ['stock'],
    anyOf: ['book', 'low', 'check', 'count', 'hash', 'inventory'],
  }),
  exactPure('app/services/inventory_service.rb', 'check_stock', true),
  assertedPurpose('app/services/inventory_service.rb', 'reserve', {
    anyOf: ['stock', 'decrement', 'reduce', 'reserve', 'book'],
  }),
  exactPure('app/services/inventory_service.rb', 'reserve', false),

  // ============================================================
  // Serializers
  // ============================================================
  assertedPurpose('app/serializers/book_serializer.rb', 'BookSerializer', {
    mentions: ['book'],
    anyOf: ['serialize', 'json', 'hash', 'api', 'response', 'format', 'data'],
  }),
  assertedDomain('app/serializers/book_serializer.rb', 'BookSerializer', {
    anyOf: ['serialization', 'serializer', 'api', 'json', 'presentation', 'book', 'catalog', 'data', 'format'],
    noneOf: ['user-management', 'authentication-only', 'identity-management'],
  }),
  exactPure('app/serializers/book_serializer.rb', 'BookSerializer', false),

  assertedPurpose('app/serializers/order_serializer.rb', 'OrderSerializer', {
    mentions: ['order'],
    anyOf: ['serialize', 'json', 'hash', 'api', 'response', 'item', 'format', 'data'],
  }),
  assertedDomain('app/serializers/order_serializer.rb', 'OrderSerializer', {
    anyOf: ['serialization', 'serializer', 'api', 'json', 'presentation', 'order', 'data', 'format'],
    noneOf: ['user-management', 'authentication-only', 'identity-management'],
  }),
  exactPure('app/serializers/order_serializer.rb', 'OrderSerializer', false),

  // ============================================================
  // Mailer
  // ============================================================
  assertedPurpose('app/mailers/order_mailer.rb', 'OrderMailer', {
    mentions: ['order'],
    anyOf: ['mail', 'email', 'notification', 'confirmation', 'cancel'],
  }),
  assertedDomain('app/mailers/order_mailer.rb', 'OrderMailer', {
    anyOf: ['mail', 'email', 'notification', 'communication', 'order'],
    noneOf: ['user-management', 'auth', 'session', 'inventory'],
  }),
  exactPure('app/mailers/order_mailer.rb', 'OrderMailer', false),

  // ============================================================
  // Job
  // ============================================================
  assertedPurpose('app/jobs/inventory_check_job.rb', 'InventoryCheckJob', {
    mentions: ['stock'],
    anyOf: ['inventory', 'background', 'job', 'check', 'low', 'order'],
  }),
  assertedDomain('app/jobs/inventory_check_job.rb', 'InventoryCheckJob', {
    anyOf: ['background', 'job', 'inventory', 'monitoring', 'async'],
    noneOf: ['user-management', 'auth', 'session'],
  }),
  exactPure('app/jobs/inventory_check_job.rb', 'InventoryCheckJob', false),
  assertedPurpose('app/jobs/inventory_check_job.rb', 'perform', {
    anyOf: ['stock', 'check', 'iterate', 'order', 'item', 'low', 'notify'],
  }),
  exactPure('app/jobs/inventory_check_job.rb', 'perform', false),

  // PR1/1: removed the 8 Api-namespace metadata rows. The Ruby parser no longer
  // emits namespace-only `module Api ... end` definitions because the symbols
  // stage was mis-summarizing them as the contained controller class.
];
