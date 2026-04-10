import { type GroundTruthDefinitionMetadata, defKey } from '../../harness/types.js';

/**
 * Ground truth for the `definition_metadata` table after running
 * `squint ingest --to-stage symbols` against the bookstore-api fixture.
 *
 * Three metadata aspects per definition:
 *   - purpose: LLM-generated description (proseReference, minor drift)
 *   - domain: LLM-generated tags (themeReference, minor drift)
 *   - pure: deterministic boolean (exactValue, major mismatch)
 *
 * Only class-level and significant method-level definitions get full
 * coverage. Minor utility methods (format_price, normalize_name) are
 * included for completeness but with looser thresholds.
 */
export const definitionMetadata: GroundTruthDefinitionMetadata[] = [
  // ============================================================
  // Models
  // ============================================================

  // ApplicationRecord
  {
    defKey: defKey('app/models/application_record.rb', 'ApplicationRecord'),
    key: 'purpose',
    proseReference: 'Abstract base class for all ActiveRecord models with shared query helpers',
  },
  {
    defKey: defKey('app/models/application_record.rb', 'ApplicationRecord'),
    key: 'domain',
    themeReference: 'tags should reflect a database or persistence base class',
  },
  { defKey: defKey('app/models/application_record.rb', 'ApplicationRecord'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/models/application_record.rb', 'recent'),
    key: 'purpose',
    proseReference: 'Query helper that returns recent records ordered by creation date',
  },
  { defKey: defKey('app/models/application_record.rb', 'recent'), key: 'pure', exactValue: 'true' },

  // Book
  {
    defKey: defKey('app/models/book.rb', 'Book'),
    key: 'purpose',
    proseReference: 'ActiveRecord model for books with title, ISBN, pricing, stock tracking, and author association',
  },
  {
    defKey: defKey('app/models/book.rb', 'Book'),
    key: 'domain',
    themeReference: 'tags should reflect a catalog or inventory model for books in a bookstore',
  },
  { defKey: defKey('app/models/book.rb', 'Book'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/models/book.rb', 'price'),
    key: 'purpose',
    proseReference: 'Converts price from cents to decimal dollars',
  },
  { defKey: defKey('app/models/book.rb', 'price'), key: 'pure', exactValue: 'true' },
  {
    defKey: defKey('app/models/book.rb', 'in_stock?'),
    key: 'purpose',
    proseReference: 'Returns whether the book has available stock',
  },
  { defKey: defKey('app/models/book.rb', 'in_stock?'), key: 'pure', exactValue: 'true' },
  {
    defKey: defKey('app/models/book.rb', 'reserve_stock!'),
    key: 'purpose',
    proseReference: 'Decrements stock count by a given quantity, raising an error if insufficient stock',
  },
  { defKey: defKey('app/models/book.rb', 'reserve_stock!'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/models/book.rb', 'InsufficientStockError'),
    key: 'purpose',
    proseReference: 'Custom error class raised when trying to reserve more stock than available',
  },
  { defKey: defKey('app/models/book.rb', 'InsufficientStockError'), key: 'pure', exactValue: 'false' },

  // Author
  {
    defKey: defKey('app/models/author.rb', 'Author'),
    key: 'purpose',
    proseReference: 'ActiveRecord model for book authors with name, bio, and association to books',
  },
  {
    defKey: defKey('app/models/author.rb', 'Author'),
    key: 'domain',
    themeReference: 'tags should reflect a catalog or author model for a bookstore',
  },
  { defKey: defKey('app/models/author.rb', 'Author'), key: 'pure', exactValue: 'false' },
  { defKey: defKey('app/models/author.rb', 'book_count'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/models/author.rb', 'full_display_name'),
    key: 'purpose',
    proseReference: 'Returns a formatted display name combining the author name and truncated bio',
  },
  { defKey: defKey('app/models/author.rb', 'full_display_name'), key: 'pure', exactValue: 'true' },

  // User
  {
    defKey: defKey('app/models/user.rb', 'User'),
    key: 'purpose',
    proseReference: 'ActiveRecord model for user accounts with password authentication and order associations',
  },
  {
    defKey: defKey('app/models/user.rb', 'User'),
    key: 'domain',
    themeReference: 'tags should reflect user authentication or identity',
  },
  { defKey: defKey('app/models/user.rb', 'User'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/models/user.rb', 'authenticate'),
    key: 'purpose',
    proseReference: 'Class method that looks up a user by email and verifies the password, returning the user or nil',
  },
  { defKey: defKey('app/models/user.rb', 'authenticate'), key: 'pure', exactValue: 'false' },
  { defKey: defKey('app/models/user.rb', 'total_spent'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/models/user.rb', 'admin?'),
    key: 'purpose',
    proseReference: 'Checks whether the user has the admin role',
  },
  { defKey: defKey('app/models/user.rb', 'admin?'), key: 'pure', exactValue: 'true' },

  // Order
  {
    defKey: defKey('app/models/order.rb', 'Order'),
    key: 'purpose',
    proseReference:
      'ActiveRecord model for purchase orders with status management, item associations, and post-creation hooks for email and inventory checks',
  },
  {
    defKey: defKey('app/models/order.rb', 'Order'),
    key: 'domain',
    themeReference: 'tags should reflect order management or e-commerce purchasing',
  },
  { defKey: defKey('app/models/order.rb', 'Order'), key: 'pure', exactValue: 'false' },
  { defKey: defKey('app/models/order.rb', 'confirm!'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/models/order.rb', 'cancel!'),
    key: 'purpose',
    proseReference: 'Cancels the order and restores stock quantities for each order item',
  },
  { defKey: defKey('app/models/order.rb', 'cancel!'), key: 'pure', exactValue: 'false' },
  { defKey: defKey('app/models/order.rb', 'item_count'), key: 'pure', exactValue: 'false' },

  // OrderItem
  {
    defKey: defKey('app/models/order_item.rb', 'OrderItem'),
    key: 'purpose',
    proseReference: 'ActiveRecord join model between orders and books with quantity and unit price tracking',
  },
  {
    defKey: defKey('app/models/order_item.rb', 'OrderItem'),
    key: 'domain',
    themeReference: 'tags should reflect order line items or cart items in a purchase',
  },
  { defKey: defKey('app/models/order_item.rb', 'OrderItem'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/models/order_item.rb', 'subtotal_cents'),
    key: 'purpose',
    proseReference: 'Computes the subtotal by multiplying quantity by unit price',
  },
  { defKey: defKey('app/models/order_item.rb', 'subtotal_cents'), key: 'pure', exactValue: 'true' },

  // ============================================================
  // Controllers
  // ============================================================

  // ApplicationController
  {
    defKey: defKey('app/controllers/application_controller.rb', 'ApplicationController'),
    key: 'purpose',
    proseReference: 'Base API controller with authentication helpers and request ID tracking',
  },
  {
    defKey: defKey('app/controllers/application_controller.rb', 'ApplicationController'),
    key: 'domain',
    themeReference: 'tags should reflect HTTP or API base controller infrastructure',
  },
  {
    defKey: defKey('app/controllers/application_controller.rb', 'ApplicationController'),
    key: 'pure',
    exactValue: 'false',
  },
  {
    defKey: defKey('app/controllers/application_controller.rb', 'authenticate!'),
    key: 'purpose',
    proseReference: 'Before-action filter that rejects unauthenticated requests with 401',
  },
  { defKey: defKey('app/controllers/application_controller.rb', 'authenticate!'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/controllers/application_controller.rb', 'current_user'),
    key: 'purpose',
    proseReference: 'Extracts and memoizes the authenticated user from the Authorization header token',
  },
  { defKey: defKey('app/controllers/application_controller.rb', 'current_user'), key: 'pure', exactValue: 'false' },

  // Api::BaseController
  {
    defKey: defKey('app/controllers/api/base_controller.rb', 'BaseController'),
    key: 'purpose',
    proseReference: 'Namespaced API base controller with shared JSON response helpers and pagination',
  },
  {
    defKey: defKey('app/controllers/api/base_controller.rb', 'BaseController'),
    key: 'domain',
    themeReference: 'tags should reflect API controller infrastructure or HTTP response helpers',
  },
  { defKey: defKey('app/controllers/api/base_controller.rb', 'BaseController'), key: 'pure', exactValue: 'false' },

  // Api::BooksController
  {
    defKey: defKey('app/controllers/api/books_controller.rb', 'BooksController'),
    key: 'purpose',
    proseReference: 'REST controller for book catalog CRUD endpoints with admin authorization and serialization',
  },
  {
    defKey: defKey('app/controllers/api/books_controller.rb', 'BooksController'),
    key: 'domain',
    themeReference: 'tags should reflect book catalog management or API endpoints',
  },
  { defKey: defKey('app/controllers/api/books_controller.rb', 'BooksController'), key: 'pure', exactValue: 'false' },

  // Api::OrdersController
  {
    defKey: defKey('app/controllers/api/orders_controller.rb', 'OrdersController'),
    key: 'purpose',
    proseReference: 'REST controller for order endpoints that delegates checkout to the CheckoutService',
  },
  {
    defKey: defKey('app/controllers/api/orders_controller.rb', 'OrdersController'),
    key: 'domain',
    themeReference: 'tags should reflect order management or purchasing API',
  },
  { defKey: defKey('app/controllers/api/orders_controller.rb', 'OrdersController'), key: 'pure', exactValue: 'false' },

  // Api::SessionsController
  {
    defKey: defKey('app/controllers/api/sessions_controller.rb', 'SessionsController'),
    key: 'purpose',
    proseReference: 'REST controller for authentication sessions: login with email/password and logout',
  },
  {
    defKey: defKey('app/controllers/api/sessions_controller.rb', 'SessionsController'),
    key: 'domain',
    themeReference: 'tags should reflect authentication or session management',
  },
  {
    defKey: defKey('app/controllers/api/sessions_controller.rb', 'SessionsController'),
    key: 'pure',
    exactValue: 'false',
  },

  // ============================================================
  // Services
  // ============================================================

  // CheckoutService
  {
    defKey: defKey('app/services/checkout_service.rb', 'CheckoutService'),
    key: 'purpose',
    proseReference:
      'Service object that orchestrates checkout: validates stock, creates order with items, reserves inventory, and triggers async side effects',
  },
  {
    defKey: defKey('app/services/checkout_service.rb', 'CheckoutService'),
    key: 'domain',
    themeReference: 'tags should reflect checkout or order processing business logic',
  },
  { defKey: defKey('app/services/checkout_service.rb', 'CheckoutService'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/services/checkout_service.rb', 'call'),
    key: 'purpose',
    proseReference:
      'Executes the checkout flow: loads books, checks stock, creates order and items, confirms the order',
  },
  { defKey: defKey('app/services/checkout_service.rb', 'call'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/services/checkout_service.rb', 'success?'),
    key: 'purpose',
    proseReference: 'Returns whether the checkout completed without errors',
  },
  { defKey: defKey('app/services/checkout_service.rb', 'success?'), key: 'pure', exactValue: 'true' },

  // InventoryService
  {
    defKey: defKey('app/services/inventory_service.rb', 'InventoryService'),
    key: 'purpose',
    proseReference: 'Service for checking stock levels, reserving inventory, and finding low or out-of-stock books',
  },
  {
    defKey: defKey('app/services/inventory_service.rb', 'InventoryService'),
    key: 'domain',
    themeReference: 'tags should reflect inventory management or stock tracking',
  },
  { defKey: defKey('app/services/inventory_service.rb', 'InventoryService'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/services/inventory_service.rb', 'check_stock'),
    key: 'purpose',
    proseReference: 'Returns a hash of stock information for a given book including stock count and low-stock flag',
  },
  { defKey: defKey('app/services/inventory_service.rb', 'check_stock'), key: 'pure', exactValue: 'true' },
  {
    defKey: defKey('app/services/inventory_service.rb', 'reserve'),
    key: 'purpose',
    proseReference: 'Delegates to the book model to decrement stock by the requested quantity',
  },
  { defKey: defKey('app/services/inventory_service.rb', 'reserve'), key: 'pure', exactValue: 'false' },

  // ============================================================
  // Serializers
  // ============================================================

  {
    defKey: defKey('app/serializers/book_serializer.rb', 'BookSerializer'),
    key: 'purpose',
    proseReference: 'Serializes a Book model into a JSON hash for API responses including author summary',
  },
  {
    defKey: defKey('app/serializers/book_serializer.rb', 'BookSerializer'),
    key: 'domain',
    themeReference: 'tags should reflect API serialization or data presentation for books',
  },
  { defKey: defKey('app/serializers/book_serializer.rb', 'BookSerializer'), key: 'pure', exactValue: 'false' },

  {
    defKey: defKey('app/serializers/order_serializer.rb', 'OrderSerializer'),
    key: 'purpose',
    proseReference: 'Serializes an Order model into a JSON hash with nested items using BookSerializer',
  },
  {
    defKey: defKey('app/serializers/order_serializer.rb', 'OrderSerializer'),
    key: 'domain',
    themeReference: 'tags should reflect API serialization or data presentation for orders',
  },
  { defKey: defKey('app/serializers/order_serializer.rb', 'OrderSerializer'), key: 'pure', exactValue: 'false' },

  // ============================================================
  // Mailer
  // ============================================================

  {
    defKey: defKey('app/mailers/order_mailer.rb', 'OrderMailer'),
    key: 'purpose',
    proseReference: 'Mailer for order-related emails: confirmation after creation and cancellation notification',
  },
  {
    defKey: defKey('app/mailers/order_mailer.rb', 'OrderMailer'),
    key: 'domain',
    themeReference: 'tags should reflect email notifications or order communications',
  },
  { defKey: defKey('app/mailers/order_mailer.rb', 'OrderMailer'), key: 'pure', exactValue: 'false' },

  // ============================================================
  // Job
  // ============================================================

  {
    defKey: defKey('app/jobs/inventory_check_job.rb', 'InventoryCheckJob'),
    key: 'purpose',
    proseReference:
      'Background job that checks stock levels for all items in a completed order and alerts on low stock',
  },
  {
    defKey: defKey('app/jobs/inventory_check_job.rb', 'InventoryCheckJob'),
    key: 'domain',
    themeReference: 'tags should reflect background processing or inventory monitoring',
  },
  { defKey: defKey('app/jobs/inventory_check_job.rb', 'InventoryCheckJob'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/jobs/inventory_check_job.rb', 'perform'),
    key: 'purpose',
    proseReference: 'Iterates over order items, checks stock for each book, and notifies admin of low stock',
  },
  { defKey: defKey('app/jobs/inventory_check_job.rb', 'perform'), key: 'pure', exactValue: 'false' },

  // ============================================================
  // Api module (wraps namespaced controllers — 4x duplicate)
  // ============================================================
  {
    defKey: defKey('app/controllers/api/base_controller.rb', 'Api'),
    key: 'purpose',
    proseReference: 'Ruby module namespace wrapping the API controllers',
  },
  { defKey: defKey('app/controllers/api/base_controller.rb', 'Api'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/controllers/api/books_controller.rb', 'Api'),
    key: 'purpose',
    proseReference: 'Ruby module namespace wrapping the API controllers',
  },
  { defKey: defKey('app/controllers/api/books_controller.rb', 'Api'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/controllers/api/orders_controller.rb', 'Api'),
    key: 'purpose',
    proseReference: 'Ruby module namespace wrapping the API controllers',
  },
  { defKey: defKey('app/controllers/api/orders_controller.rb', 'Api'), key: 'pure', exactValue: 'false' },
  {
    defKey: defKey('app/controllers/api/sessions_controller.rb', 'Api'),
    key: 'purpose',
    proseReference: 'Ruby module namespace wrapping the API controllers',
  },
  { defKey: defKey('app/controllers/api/sessions_controller.rb', 'Api'), key: 'pure', exactValue: 'false' },
];
