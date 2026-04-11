import type { GroundTruthImport } from '../../harness/types.js';

/**
 * Ground truth for the `imports` table after parsing the bookstore-api fixture.
 *
 * These imports are detected via constant-receiver analysis: when Ruby code
 * calls `BookSerializer.new(book)`, squint resolves `BookSerializer` to
 * `app/serializers/book_serializer.rb` via Rails Zeitwerk conventions.
 *
 * 15 resolved imports across 8 files. All are `type: 'import'` (synthetic
 * from constant-receiver detection, not explicit require/require_relative).
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
];
