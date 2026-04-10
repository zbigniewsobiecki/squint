import type { GroundTruthDefinition } from '../../harness/types.js';

/**
 * Ground truth for the `definitions` table after parsing the bookstore-api fixture.
 *
 * Calibrated against the produced DB from `squint ingest --to-stage parse`.
 * 97 definitions across 17 files (config/routes.rb produces 0 definitions).
 *
 * Key Ruby-specific observations:
 *   - `module Api` wrapper produces a module def in each controller file (4x)
 *   - `attr_reader :foo` produces a method def named 'foo'
 *   - Class names inside `module Api ... end` are just the inner name
 *     (e.g. 'BaseController' not 'Api::BaseController')
 *   - `InsufficientStockError` in book.rb is a separate class def
 *   - Scopes are NOT extracted as definitions (they're DSL, not method defs)
 *   - `has_secure_password`, `validates`, `belongs_to` etc. are NOT defs
 */
export const definitions: GroundTruthDefinition[] = [
  // ============================================================
  // app/controllers/api/base_controller.rb (6 defs)
  // ============================================================
  {
    file: 'app/controllers/api/base_controller.rb',
    name: 'Api',
    kind: 'module',
    isExported: true,
    line: 1,
    endLine: 25,
  },
  {
    file: 'app/controllers/api/base_controller.rb',
    name: 'BaseController',
    kind: 'class',
    isExported: true,
    line: 2,
    endLine: 24,
    extendsName: 'ApplicationController',
  },
  {
    file: 'app/controllers/api/base_controller.rb',
    name: 'render_success',
    kind: 'method',
    isExported: false,
    line: 7,
    endLine: 9,
  },
  {
    file: 'app/controllers/api/base_controller.rb',
    name: 'render_error',
    kind: 'method',
    isExported: false,
    line: 11,
    endLine: 13,
  },
  {
    file: 'app/controllers/api/base_controller.rb',
    name: 'render_not_found',
    kind: 'method',
    isExported: false,
    line: 15,
    endLine: 17,
  },
  {
    file: 'app/controllers/api/base_controller.rb',
    name: 'paginate',
    kind: 'method',
    isExported: false,
    line: 19,
    endLine: 23,
  },

  // ============================================================
  // app/controllers/api/books_controller.rb (11 defs)
  // ============================================================
  {
    file: 'app/controllers/api/books_controller.rb',
    name: 'Api',
    kind: 'module',
    isExported: true,
    line: 1,
    endLine: 59,
  },
  {
    file: 'app/controllers/api/books_controller.rb',
    name: 'BooksController',
    kind: 'class',
    isExported: true,
    line: 2,
    endLine: 58,
    extendsName: 'BaseController',
  },
  {
    file: 'app/controllers/api/books_controller.rb',
    name: 'index',
    kind: 'method',
    isExported: true,
    line: 7,
    endLine: 10,
  },
  {
    file: 'app/controllers/api/books_controller.rb',
    name: 'show',
    kind: 'method',
    isExported: true,
    line: 12,
    endLine: 14,
  },
  {
    file: 'app/controllers/api/books_controller.rb',
    name: 'create',
    kind: 'method',
    isExported: true,
    line: 16,
    endLine: 23,
  },
  {
    file: 'app/controllers/api/books_controller.rb',
    name: 'update',
    kind: 'method',
    isExported: true,
    line: 25,
    endLine: 31,
  },
  {
    file: 'app/controllers/api/books_controller.rb',
    name: 'destroy',
    kind: 'method',
    isExported: true,
    line: 33,
    endLine: 36,
  },
  {
    file: 'app/controllers/api/books_controller.rb',
    name: 'restock',
    kind: 'method',
    isExported: true,
    line: 38,
    endLine: 42,
  },
  {
    file: 'app/controllers/api/books_controller.rb',
    name: 'set_book',
    kind: 'method',
    isExported: false,
    line: 46,
    endLine: 49,
  },
  {
    file: 'app/controllers/api/books_controller.rb',
    name: 'book_params',
    kind: 'method',
    isExported: false,
    line: 51,
    endLine: 53,
  },
  {
    file: 'app/controllers/api/books_controller.rb',
    name: 'require_admin!',
    kind: 'method',
    isExported: false,
    line: 55,
    endLine: 57,
  },

  // ============================================================
  // app/controllers/api/orders_controller.rb (7 defs)
  // ============================================================
  {
    file: 'app/controllers/api/orders_controller.rb',
    name: 'Api',
    kind: 'module',
    isExported: true,
    line: 1,
    endLine: 40,
  },
  {
    file: 'app/controllers/api/orders_controller.rb',
    name: 'OrdersController',
    kind: 'class',
    isExported: true,
    line: 2,
    endLine: 39,
    extendsName: 'BaseController',
  },
  {
    file: 'app/controllers/api/orders_controller.rb',
    name: 'index',
    kind: 'method',
    isExported: true,
    line: 5,
    endLine: 8,
  },
  {
    file: 'app/controllers/api/orders_controller.rb',
    name: 'show',
    kind: 'method',
    isExported: true,
    line: 10,
    endLine: 12,
  },
  {
    file: 'app/controllers/api/orders_controller.rb',
    name: 'create',
    kind: 'method',
    isExported: true,
    line: 14,
    endLine: 27,
  },
  {
    file: 'app/controllers/api/orders_controller.rb',
    name: 'set_order',
    kind: 'method',
    isExported: false,
    line: 31,
    endLine: 34,
  },
  {
    file: 'app/controllers/api/orders_controller.rb',
    name: 'order_params',
    kind: 'method',
    isExported: false,
    line: 36,
    endLine: 38,
  },

  // ============================================================
  // app/controllers/api/sessions_controller.rb (6 defs)
  // ============================================================
  {
    file: 'app/controllers/api/sessions_controller.rb',
    name: 'Api',
    kind: 'module',
    isExported: true,
    line: 1,
    endLine: 33,
  },
  {
    file: 'app/controllers/api/sessions_controller.rb',
    name: 'SessionsController',
    kind: 'class',
    isExported: true,
    line: 2,
    endLine: 32,
    extendsName: 'BaseController',
  },
  {
    file: 'app/controllers/api/sessions_controller.rb',
    name: 'create',
    kind: 'method',
    isExported: true,
    line: 5,
    endLine: 14,
  },
  {
    file: 'app/controllers/api/sessions_controller.rb',
    name: 'destroy',
    kind: 'method',
    isExported: true,
    line: 16,
    endLine: 19,
  },
  {
    file: 'app/controllers/api/sessions_controller.rb',
    name: 'session_params',
    kind: 'method',
    isExported: false,
    line: 23,
    endLine: 25,
  },
  {
    file: 'app/controllers/api/sessions_controller.rb',
    name: 'generate_auth_token',
    kind: 'method',
    isExported: false,
    line: 27,
    endLine: 31,
  },

  // ============================================================
  // app/controllers/application_controller.rb (4 defs)
  // ============================================================
  {
    file: 'app/controllers/application_controller.rb',
    name: 'ApplicationController',
    kind: 'class',
    isExported: true,
    line: 1,
    endLine: 20,
    extendsName: 'ActionController::API',
  },
  {
    file: 'app/controllers/application_controller.rb',
    name: 'current_user',
    kind: 'method',
    isExported: false,
    line: 6,
    endLine: 11,
  },
  {
    file: 'app/controllers/application_controller.rb',
    name: 'authenticate!',
    kind: 'method',
    isExported: false,
    line: 13,
    endLine: 15,
  },
  {
    file: 'app/controllers/application_controller.rb',
    name: 'set_request_id',
    kind: 'method',
    isExported: false,
    line: 17,
    endLine: 19,
  },

  // ============================================================
  // app/jobs/inventory_check_job.rb (3 defs)
  // ============================================================
  {
    file: 'app/jobs/inventory_check_job.rb',
    name: 'InventoryCheckJob',
    kind: 'class',
    isExported: true,
    line: 1,
    endLine: 22,
    extendsName: 'ApplicationJob',
  },
  { file: 'app/jobs/inventory_check_job.rb', name: 'perform', kind: 'method', isExported: true, line: 4, endLine: 15 },
  {
    file: 'app/jobs/inventory_check_job.rb',
    name: 'notify_admin',
    kind: 'method',
    isExported: false,
    line: 19,
    endLine: 21,
  },

  // ============================================================
  // app/mailers/order_mailer.rb (3 defs)
  // ============================================================
  {
    file: 'app/mailers/order_mailer.rb',
    name: 'OrderMailer',
    kind: 'class',
    isExported: true,
    line: 1,
    endLine: 22,
    extendsName: 'ApplicationMailer',
  },
  { file: 'app/mailers/order_mailer.rb', name: 'confirmation', kind: 'method', isExported: true, line: 2, endLine: 11 },
  {
    file: 'app/mailers/order_mailer.rb',
    name: 'cancellation',
    kind: 'method',
    isExported: true,
    line: 13,
    endLine: 21,
  },

  // ============================================================
  // app/models/application_record.rb (2 defs)
  // ============================================================
  {
    file: 'app/models/application_record.rb',
    name: 'ApplicationRecord',
    kind: 'class',
    isExported: true,
    line: 1,
    endLine: 7,
    extendsName: 'ActiveRecord::Base',
  },
  { file: 'app/models/application_record.rb', name: 'recent', kind: 'method', isExported: true, line: 4, endLine: 6 },

  // ============================================================
  // app/models/author.rb (4 defs)
  // ============================================================
  {
    file: 'app/models/author.rb',
    name: 'Author',
    kind: 'class',
    isExported: true,
    line: 1,
    endLine: 22,
    extendsName: 'ApplicationRecord',
  },
  { file: 'app/models/author.rb', name: 'book_count', kind: 'method', isExported: true, line: 9, endLine: 11 },
  { file: 'app/models/author.rb', name: 'full_display_name', kind: 'method', isExported: true, line: 13, endLine: 15 },
  { file: 'app/models/author.rb', name: 'normalize_name', kind: 'method', isExported: false, line: 19, endLine: 21 },

  // ============================================================
  // app/models/book.rb (6 defs)
  // ============================================================
  {
    file: 'app/models/book.rb',
    name: 'Book',
    kind: 'class',
    isExported: true,
    line: 1,
    endLine: 35,
    extendsName: 'ApplicationRecord',
  },
  { file: 'app/models/book.rb', name: 'price', kind: 'method', isExported: true, line: 16, endLine: 18 },
  { file: 'app/models/book.rb', name: 'in_stock?', kind: 'method', isExported: true, line: 20, endLine: 22 },
  { file: 'app/models/book.rb', name: 'reserve_stock!', kind: 'method', isExported: true, line: 24, endLine: 28 },
  { file: 'app/models/book.rb', name: 'log_new_book', kind: 'method', isExported: false, line: 32, endLine: 34 },
  {
    file: 'app/models/book.rb',
    name: 'InsufficientStockError',
    kind: 'class',
    isExported: true,
    line: 37,
    endLine: 37,
    extendsName: 'StandardError',
  },

  // ============================================================
  // app/models/order.rb (10 defs)
  // ============================================================
  {
    file: 'app/models/order.rb',
    name: 'Order',
    kind: 'class',
    isExported: true,
    line: 1,
    endLine: 46,
    extendsName: 'ApplicationRecord',
  },
  { file: 'app/models/order.rb', name: 'STATUS_PENDING', kind: 'const', isExported: true, line: 2 },
  { file: 'app/models/order.rb', name: 'STATUS_CONFIRMED', kind: 'const', isExported: true, line: 3 },
  { file: 'app/models/order.rb', name: 'STATUS_CANCELLED', kind: 'const', isExported: true, line: 4 },
  { file: 'app/models/order.rb', name: 'STATUSES', kind: 'const', isExported: true, line: 6 },
  { file: 'app/models/order.rb', name: 'confirm!', kind: 'method', isExported: true, line: 21, endLine: 23 },
  { file: 'app/models/order.rb', name: 'cancel!', kind: 'method', isExported: true, line: 25, endLine: 31 },
  { file: 'app/models/order.rb', name: 'item_count', kind: 'method', isExported: true, line: 33, endLine: 35 },
  {
    file: 'app/models/order.rb',
    name: 'send_confirmation_email',
    kind: 'method',
    isExported: false,
    line: 39,
    endLine: 41,
  },
  {
    file: 'app/models/order.rb',
    name: 'enqueue_inventory_check',
    kind: 'method',
    isExported: false,
    line: 43,
    endLine: 45,
  },

  // ============================================================
  // app/models/order_item.rb (3 defs)
  // ============================================================
  {
    file: 'app/models/order_item.rb',
    name: 'OrderItem',
    kind: 'class',
    isExported: true,
    line: 1,
    endLine: 19,
    extendsName: 'ApplicationRecord',
  },
  { file: 'app/models/order_item.rb', name: 'subtotal_cents', kind: 'method', isExported: true, line: 10, endLine: 12 },
  {
    file: 'app/models/order_item.rb',
    name: 'set_unit_price',
    kind: 'method',
    isExported: false,
    line: 16,
    endLine: 18,
  },

  // ============================================================
  // app/models/user.rb (5 defs)
  // ============================================================
  {
    file: 'app/models/user.rb',
    name: 'User',
    kind: 'class',
    isExported: true,
    line: 1,
    endLine: 30,
    extendsName: 'ApplicationRecord',
  },
  { file: 'app/models/user.rb', name: 'authenticate', kind: 'method', isExported: true, line: 10, endLine: 15 },
  { file: 'app/models/user.rb', name: 'total_spent', kind: 'method', isExported: true, line: 17, endLine: 19 },
  { file: 'app/models/user.rb', name: 'admin?', kind: 'method', isExported: true, line: 21, endLine: 23 },
  { file: 'app/models/user.rb', name: 'downcase_email', kind: 'method', isExported: false, line: 27, endLine: 29 },

  // ============================================================
  // app/serializers/book_serializer.rb (5 defs)
  // ============================================================
  {
    file: 'app/serializers/book_serializer.rb',
    name: 'BookSerializer',
    kind: 'class',
    isExported: true,
    line: 1,
    endLine: 28,
  },
  { file: 'app/serializers/book_serializer.rb', name: 'book', kind: 'method', isExported: true, line: 2 },
  {
    file: 'app/serializers/book_serializer.rb',
    name: 'initialize',
    kind: 'method',
    isExported: true,
    line: 4,
    endLine: 6,
  },
  {
    file: 'app/serializers/book_serializer.rb',
    name: 'as_json',
    kind: 'method',
    isExported: true,
    line: 8,
    endLine: 19,
  },
  {
    file: 'app/serializers/book_serializer.rb',
    name: 'author_summary',
    kind: 'method',
    isExported: false,
    line: 23,
    endLine: 27,
  },

  // ============================================================
  // app/serializers/order_serializer.rb (6 defs)
  // ============================================================
  {
    file: 'app/serializers/order_serializer.rb',
    name: 'OrderSerializer',
    kind: 'class',
    isExported: true,
    line: 1,
    endLine: 34,
  },
  { file: 'app/serializers/order_serializer.rb', name: 'order', kind: 'method', isExported: true, line: 2 },
  {
    file: 'app/serializers/order_serializer.rb',
    name: 'initialize',
    kind: 'method',
    isExported: true,
    line: 4,
    endLine: 6,
  },
  {
    file: 'app/serializers/order_serializer.rb',
    name: 'as_json',
    kind: 'method',
    isExported: true,
    line: 8,
    endLine: 17,
  },
  {
    file: 'app/serializers/order_serializer.rb',
    name: 'serialize_items',
    kind: 'method',
    isExported: false,
    line: 21,
    endLine: 29,
  },
  {
    file: 'app/serializers/order_serializer.rb',
    name: 'format_price',
    kind: 'method',
    isExported: false,
    line: 31,
    endLine: 33,
  },

  // ============================================================
  // app/services/checkout_service.rb (10 defs)
  // ============================================================
  {
    file: 'app/services/checkout_service.rb',
    name: 'CheckoutService',
    kind: 'class',
    isExported: true,
    line: 1,
    endLine: 68,
  },
  { file: 'app/services/checkout_service.rb', name: 'user', kind: 'method', isExported: true, line: 2 },
  { file: 'app/services/checkout_service.rb', name: 'items', kind: 'method', isExported: true, line: 2 },
  { file: 'app/services/checkout_service.rb', name: 'order', kind: 'method', isExported: true, line: 2 },
  { file: 'app/services/checkout_service.rb', name: 'error', kind: 'method', isExported: true, line: 2 },
  {
    file: 'app/services/checkout_service.rb',
    name: 'initialize',
    kind: 'method',
    isExported: true,
    line: 4,
    endLine: 9,
  },
  { file: 'app/services/checkout_service.rb', name: 'call', kind: 'method', isExported: true, line: 11, endLine: 44 },
  {
    file: 'app/services/checkout_service.rb',
    name: 'success?',
    kind: 'method',
    isExported: true,
    line: 46,
    endLine: 48,
  },
  {
    file: 'app/services/checkout_service.rb',
    name: 'load_and_validate_books',
    kind: 'method',
    isExported: false,
    line: 52,
    endLine: 62,
  },
  {
    file: 'app/services/checkout_service.rb',
    name: 'failure',
    kind: 'method',
    isExported: false,
    line: 64,
    endLine: 67,
  },

  // ============================================================
  // app/services/inventory_service.rb (6 defs)
  // ============================================================
  {
    file: 'app/services/inventory_service.rb',
    name: 'InventoryService',
    kind: 'class',
    isExported: true,
    line: 1,
    endLine: 25,
  },
  { file: 'app/services/inventory_service.rb', name: 'LOW_STOCK_THRESHOLD', kind: 'const', isExported: true, line: 2 },
  {
    file: 'app/services/inventory_service.rb',
    name: 'check_stock',
    kind: 'method',
    isExported: true,
    line: 4,
    endLine: 12,
  },
  {
    file: 'app/services/inventory_service.rb',
    name: 'reserve',
    kind: 'method',
    isExported: true,
    line: 14,
    endLine: 16,
  },
  {
    file: 'app/services/inventory_service.rb',
    name: 'low_stock_books',
    kind: 'method',
    isExported: true,
    line: 18,
    endLine: 20,
  },
  {
    file: 'app/services/inventory_service.rb',
    name: 'out_of_stock_books',
    kind: 'method',
    isExported: true,
    line: 22,
    endLine: 24,
  },
];
