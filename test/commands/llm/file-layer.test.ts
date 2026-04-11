import { describe, expect, it } from 'vitest';
import { describeFileLayer } from '../../../src/commands/llm/_shared/file-layer.js';

/**
 * PR4/2: file-path-derived layer hints. These tests freeze the rules table
 * so unintentional reorderings (which could change which rule wins) are
 * caught.
 */
describe('describeFileLayer', () => {
  describe('Rails / Ruby', () => {
    it('detects Rails models', () => {
      expect(describeFileLayer('app/models/author.rb')).toBe('Rails ActiveRecord model layer');
      expect(describeFileLayer('app/models/user.rb')).toBe('Rails ActiveRecord model layer');
    });

    it('detects Rails API controllers BEFORE generic controllers (specificity)', () => {
      expect(describeFileLayer('app/controllers/api/books_controller.rb')).toBe('Rails API controller layer');
      expect(describeFileLayer('app/controllers/application_controller.rb')).toBe('Rails controller layer');
    });

    it('detects Rails services, serializers, mailers, jobs', () => {
      expect(describeFileLayer('app/services/checkout_service.rb')).toBe('Rails service object layer');
      expect(describeFileLayer('app/serializers/book_serializer.rb')).toBe('Rails serializer layer');
      expect(describeFileLayer('app/mailers/order_mailer.rb')).toBe('Rails mailer layer');
      expect(describeFileLayer('app/jobs/inventory_check_job.rb')).toBe('Rails background job layer');
    });
  });

  describe('TypeScript / Node', () => {
    it('detects controllers, services, repositories, middleware', () => {
      expect(describeFileLayer('src/controllers/tasks.controller.ts')).toBe('HTTP controller layer');
      expect(describeFileLayer('src/services/auth.service.ts')).toBe('business service layer');
      expect(describeFileLayer('src/repositories/tasks.repository.ts')).toBe('persistence repository layer');
      expect(describeFileLayer('src/middleware/auth.middleware.ts')).toBe('HTTP middleware layer');
    });

    it('detects events layer', () => {
      expect(describeFileLayer('src/events/event-bus.ts')).toBe('event/messaging layer');
    });

    it('detects framework file by exact match', () => {
      expect(describeFileLayer('src/framework.ts')).toBe('in-fixture HTTP framework');
    });

    it('detects shared type definitions', () => {
      expect(describeFileLayer('src/types.ts')).toBe('shared type definition layer');
      expect(describeFileLayer('src/types/task.ts')).toBe('shared type definition layer');
    });
  });

  describe('Frontend client', () => {
    it('detects client/, web/, ui/', () => {
      expect(describeFileLayer('client/tasks.client.ts')).toBe('frontend client layer');
      expect(describeFileLayer('web/components/Header.tsx')).toBe('frontend web layer');
      expect(describeFileLayer('ui/screens/Home.tsx')).toBe('frontend UI layer');
    });
  });

  describe('No-match cases', () => {
    it('returns null for unrecognized paths', () => {
      expect(describeFileLayer('random/file.ts')).toBeNull();
      expect(describeFileLayer('foo/bar/baz.rb')).toBeNull();
    });

    it('returns null for empty path', () => {
      expect(describeFileLayer('')).toBeNull();
    });
  });
});
