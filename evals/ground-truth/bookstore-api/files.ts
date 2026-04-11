import type { GroundTruthFile } from '../../harness/types.js';

/**
 * Ground truth for the `files` table after parsing the bookstore-api fixture.
 *
 * 18 Ruby files (17 .rb + config/routes.rb). The Gemfile is not parsed
 * (not a .rb extension). config/routes.rb is parsed but produces 0
 * definitions (DSL-only); it's included because squint indexes it.
 */
export const files: GroundTruthFile[] = [
  { path: 'app/controllers/api/base_controller.rb', language: 'ruby' },
  { path: 'app/controllers/api/books_controller.rb', language: 'ruby' },
  { path: 'app/controllers/api/orders_controller.rb', language: 'ruby' },
  { path: 'app/controllers/api/sessions_controller.rb', language: 'ruby' },
  { path: 'app/controllers/application_controller.rb', language: 'ruby' },
  { path: 'app/jobs/inventory_check_job.rb', language: 'ruby' },
  { path: 'app/mailers/order_mailer.rb', language: 'ruby' },
  { path: 'app/models/application_record.rb', language: 'ruby' },
  { path: 'app/models/author.rb', language: 'ruby' },
  { path: 'app/models/book.rb', language: 'ruby' },
  { path: 'app/models/order.rb', language: 'ruby' },
  { path: 'app/models/order_item.rb', language: 'ruby' },
  { path: 'app/models/user.rb', language: 'ruby' },
  { path: 'app/serializers/book_serializer.rb', language: 'ruby' },
  { path: 'app/serializers/order_serializer.rb', language: 'ruby' },
  { path: 'app/services/checkout_service.rb', language: 'ruby' },
  { path: 'app/services/inventory_service.rb', language: 'ruby' },
  { path: 'config/routes.rb', language: 'ruby' },
];
