import { type InteractionRubricEntry, type InteractionSource, defKey } from '../../harness/types.js';

/**
 * Anchor-based ground truth for the LLM-driven interactions stage.
 *
 * Each entry asserts that the module containing FROM_ANCHOR has an
 * interaction edge to the module containing TO_ANCHOR. The actual module
 * full_paths are LLM-picked, so we use definitions as deterministic
 * anchors and let the comparator resolve them at compare time.
 *
 * IMPORTANT: Rails Zeitwerk autoloading means there are 0 parse-time
 * imports → 0 AST-derived interaction edges. ALL cross-module edges
 * come from the LLM inference step. The acceptableSources must include
 * 'llm-inferred' (unlike the TS fixture which uses AST-only defaults).
 * This is a genuine architectural difference, not a quality gap.
 *
 * Authored COLD. If any edge turns out to be a self-loop (both anchors
 * in the same module), it will be triaged and removed/adjusted.
 */
const ACCEPTABLE_SOURCES: InteractionSource[] = ['ast', 'ast-import', 'contract-matched', 'llm-inferred'];

export const interactionRubric: InteractionRubricEntry[] = [
  {
    label: 'books-controller-uses-serializer',
    fromAnchor: defKey('app/controllers/api/books_controller.rb', 'BooksController'),
    toAnchor: defKey('app/serializers/book_serializer.rb', 'BookSerializer'),
    acceptableSources: ACCEPTABLE_SOURCES,
    semanticReference: 'Books controller serializes book data for API responses using BookSerializer',
  },
  {
    label: 'orders-controller-uses-checkout',
    fromAnchor: defKey('app/controllers/api/orders_controller.rb', 'OrdersController'),
    toAnchor: defKey('app/services/checkout_service.rb', 'CheckoutService'),
    acceptableSources: ACCEPTABLE_SOURCES,
    semanticReference: 'Orders controller delegates order creation to the checkout service',
  },
  {
    label: 'checkout-uses-inventory',
    fromAnchor: defKey('app/services/checkout_service.rb', 'CheckoutService'),
    toAnchor: defKey('app/services/inventory_service.rb', 'InventoryService'),
    acceptableSources: ACCEPTABLE_SOURCES,
    semanticReference: 'Checkout service validates and reserves stock via the inventory service',
  },
  {
    label: 'sessions-controller-uses-user',
    fromAnchor: defKey('app/controllers/api/sessions_controller.rb', 'SessionsController'),
    toAnchor: defKey('app/models/user.rb', 'User'),
    acceptableSources: ACCEPTABLE_SOURCES,
    semanticReference: 'Sessions controller authenticates users via the User model',
  },
  {
    label: 'order-triggers-mailer',
    fromAnchor: defKey('app/models/order.rb', 'Order'),
    toAnchor: defKey('app/mailers/order_mailer.rb', 'OrderMailer'),
    acceptableSources: ACCEPTABLE_SOURCES,
    semanticReference: 'Order model triggers confirmation email on creation via after_create callback',
  },
];
