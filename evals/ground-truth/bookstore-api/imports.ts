import type { GroundTruthImport } from '../../harness/types.js';

/**
 * Ground truth for the `imports` table after parsing the bookstore-api fixture.
 *
 * Imports are detected via two passes:
 *   1. Constant-receiver analysis: `BookSerializer.new(book)` → BookSerializer
 *   2. PR3: ActiveRecord association DSLs in class bodies:
 *      `has_many :books` → Book, `belongs_to :author` → Author, etc.
 *
 * 25 resolved imports across 8+ files. All are `type: 'import'` (synthetic
 * from static analysis, not explicit require/require_relative).
 */
export const imports: GroundTruthImport[] = [
  // Controllers → models/services/serializers
  {
    fromFile: 'app/controllers/api/books_controller.rb',
    source: 'Book',
    type: 'import',
    symbols: [{ name: 'Book', kind: 'named' }],
  },
  {
    fromFile: 'app/controllers/api/books_controller.rb',
    source: 'BookSerializer',
    type: 'import',
    symbols: [{ name: 'BookSerializer', kind: 'named' }],
  },
  {
    fromFile: 'app/controllers/api/orders_controller.rb',
    source: 'CheckoutService',
    type: 'import',
    symbols: [{ name: 'CheckoutService', kind: 'named' }],
  },
  {
    fromFile: 'app/controllers/api/orders_controller.rb',
    source: 'OrderSerializer',
    type: 'import',
    symbols: [{ name: 'OrderSerializer', kind: 'named' }],
  },
  {
    fromFile: 'app/controllers/api/sessions_controller.rb',
    source: 'User',
    type: 'import',
    symbols: [{ name: 'User', kind: 'named' }],
  },
  {
    fromFile: 'app/controllers/application_controller.rb',
    source: 'User',
    type: 'import',
    symbols: [{ name: 'User', kind: 'named' }],
  },

  // Models → mailers/jobs (callback-triggered)
  {
    fromFile: 'app/models/order.rb',
    source: 'OrderMailer',
    type: 'import',
    symbols: [{ name: 'OrderMailer', kind: 'named' }],
  },
  {
    fromFile: 'app/models/order.rb',
    source: 'InventoryCheckJob',
    type: 'import',
    symbols: [{ name: 'InventoryCheckJob', kind: 'named' }],
  },

  // Services → models/services
  {
    fromFile: 'app/services/checkout_service.rb',
    source: 'Book',
    type: 'import',
    symbols: [{ name: 'Book', kind: 'named' }],
  },
  {
    fromFile: 'app/services/checkout_service.rb',
    source: 'InventoryService',
    type: 'import',
    symbols: [{ name: 'InventoryService', kind: 'named' }],
  },
  {
    fromFile: 'app/services/checkout_service.rb',
    source: 'Order',
    type: 'import',
    symbols: [{ name: 'Order', kind: 'named' }],
  },
  {
    fromFile: 'app/services/checkout_service.rb',
    source: 'OrderItem',
    type: 'import',
    symbols: [{ name: 'OrderItem', kind: 'named' }],
  },
  {
    fromFile: 'app/services/inventory_service.rb',
    source: 'Book',
    type: 'import',
    symbols: [{ name: 'Book', kind: 'named' }],
  },

  // Serializers → serializers
  {
    fromFile: 'app/serializers/order_serializer.rb',
    source: 'BookSerializer',
    type: 'import',
    symbols: [{ name: 'BookSerializer', kind: 'named' }],
  },

  // Jobs → services
  {
    fromFile: 'app/jobs/inventory_check_job.rb',
    source: 'InventoryService',
    type: 'import',
    symbols: [{ name: 'InventoryService', kind: 'named' }],
  },

  // ──────────────────────────────────────────────────────────────────
  // PR3: ActiveRecord association DSLs from class bodies
  // ──────────────────────────────────────────────────────────────────
  // Author → Book (has_many :books)
  {
    fromFile: 'app/models/author.rb',
    source: 'Book',
    type: 'import',
    symbols: [{ name: 'Book', kind: 'named' }],
  },
  // Book → Author (belongs_to :author)
  {
    fromFile: 'app/models/book.rb',
    source: 'Author',
    type: 'import',
    symbols: [{ name: 'Author', kind: 'named' }],
  },
  // Book → OrderItem (has_many :order_items)
  {
    fromFile: 'app/models/book.rb',
    source: 'OrderItem',
    type: 'import',
    symbols: [{ name: 'OrderItem', kind: 'named' }],
  },
  // Book → Order (has_many :orders, through: :order_items — only the immediate :orders symbol resolves)
  {
    fromFile: 'app/models/book.rb',
    source: 'Order',
    type: 'import',
    symbols: [{ name: 'Order', kind: 'named' }],
  },
  // Order → User (belongs_to :user)
  {
    fromFile: 'app/models/order.rb',
    source: 'User',
    type: 'import',
    symbols: [{ name: 'User', kind: 'named' }],
  },
  // Order → OrderItem (has_many :order_items)
  {
    fromFile: 'app/models/order.rb',
    source: 'OrderItem',
    type: 'import',
    symbols: [{ name: 'OrderItem', kind: 'named' }],
  },
  // Order → Book (has_many :books, through: :order_items — :books symbol resolves)
  {
    fromFile: 'app/models/order.rb',
    source: 'Book',
    type: 'import',
    symbols: [{ name: 'Book', kind: 'named' }],
  },
  // OrderItem → Order (belongs_to :order)
  {
    fromFile: 'app/models/order_item.rb',
    source: 'Order',
    type: 'import',
    symbols: [{ name: 'Order', kind: 'named' }],
  },
  // OrderItem → Book (belongs_to :book)
  {
    fromFile: 'app/models/order_item.rb',
    source: 'Book',
    type: 'import',
    symbols: [{ name: 'Book', kind: 'named' }],
  },
  // User → Order (has_many :orders)
  {
    fromFile: 'app/models/user.rb',
    source: 'Order',
    type: 'import',
    symbols: [{ name: 'Order', kind: 'named' }],
  },
];
