import { type ModuleCohesionGroup, defKey } from '../../harness/types.js';

/**
 * Cohesion rubric for the LLM-driven modules stage.
 *
 * Each group asserts that semantically related definitions land in the same
 * module, and that module's LLM-picked name+description matches the expected
 * role. Uses `majority` for groups where base classes may split across parent/
 * child modules.
 *
 * Severity:
 *   - Member unassigned to any module → CRITICAL
 *   - Cohesion violated (strict/majority) → MAJOR
 *   - Role prose drift → MINOR
 */
export const moduleCohesion: ModuleCohesionGroup[] = [
  {
    label: 'catalog-models',
    members: [defKey('app/models/book.rb', 'Book'), defKey('app/models/author.rb', 'Author')],
    expectedRole: 'Domain models for the book catalog: books and authors',
    cohesion: 'majority',
  },
  {
    label: 'order-models',
    members: [defKey('app/models/order.rb', 'Order'), defKey('app/models/order_item.rb', 'OrderItem')],
    expectedRole: 'Domain models for purchase orders and their line items',
    cohesion: 'majority',
  },
  {
    label: 'auth-model',
    members: [defKey('app/models/user.rb', 'User')],
    expectedRole: 'User model for authentication and identity',
  },
  {
    label: 'books-api',
    members: [defKey('app/controllers/api/books_controller.rb', 'BooksController')],
    expectedRole: 'REST API controller for book catalog CRUD endpoints',
  },
  {
    label: 'orders-api',
    members: [defKey('app/controllers/api/orders_controller.rb', 'OrdersController')],
    expectedRole: 'REST API controller for order management endpoints',
  },
  {
    label: 'sessions-api',
    members: [defKey('app/controllers/api/sessions_controller.rb', 'SessionsController')],
    expectedRole: 'REST API controller for authentication session endpoints',
  },
  {
    label: 'controller-base',
    members: [
      defKey('app/controllers/application_controller.rb', 'ApplicationController'),
      defKey('app/controllers/api/base_controller.rb', 'BaseController'),
    ],
    expectedRole: 'Base controller hierarchy with authentication and JSON response helpers',
    cohesion: 'majority',
  },
  {
    label: 'checkout-services',
    members: [
      defKey('app/services/checkout_service.rb', 'CheckoutService'),
      defKey('app/services/inventory_service.rb', 'InventoryService'),
    ],
    expectedRole: 'Business logic services for checkout and inventory management',
    cohesion: 'majority',
  },
  {
    label: 'serializers',
    members: [
      defKey('app/serializers/book_serializer.rb', 'BookSerializer'),
      defKey('app/serializers/order_serializer.rb', 'OrderSerializer'),
    ],
    expectedRole: 'JSON serialization layer for API responses',
    cohesion: 'majority',
  },
  {
    label: 'async-effects',
    members: [
      defKey('app/mailers/order_mailer.rb', 'OrderMailer'),
      defKey('app/jobs/inventory_check_job.rb', 'InventoryCheckJob'),
    ],
    expectedRole: 'Asynchronous side effects: email notifications and background inventory checks',
    cohesion: 'majority',
  },
  {
    label: 'base-record',
    members: [defKey('app/models/application_record.rb', 'ApplicationRecord')],
    expectedRole: 'Abstract ActiveRecord base class for all application models',
  },
];
