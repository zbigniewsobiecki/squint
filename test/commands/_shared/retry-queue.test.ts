import { describe, expect, it } from 'vitest';
import { RelationshipRetryQueue } from '../../../src/commands/_shared/retry-queue.js';

describe('retry-queue', () => {
  describe('RelationshipRetryQueue', () => {
    it('adds failures and tracks attempts', () => {
      const queue = new RelationshipRetryQueue();

      queue.add(1, 2, 'Failed to parse');
      queue.add(1, 2, 'Failed to parse again');
      queue.add(3, 4, 'Different error');

      expect(queue.size).toBe(2);
    });

    it('increments attempt count for duplicate entries', () => {
      const queue = new RelationshipRetryQueue();

      queue.add(1, 2, 'Error 1');
      queue.add(1, 2, 'Error 2');
      queue.add(1, 2, 'Error 3');

      const retryable = queue.getRetryable(3);
      expect(retryable).toHaveLength(0); // 3 attempts, max is 3, so not retryable
    });

    it('returns retryable entries below max attempts', () => {
      const queue = new RelationshipRetryQueue();

      queue.add(1, 2, 'Error');
      queue.add(1, 2, 'Error');
      queue.add(3, 4, 'Error');
      queue.add(5, 6, 'Error');
      queue.add(5, 6, 'Error');
      queue.add(5, 6, 'Error');

      const retryable = queue.getRetryable(3);

      expect(retryable).toHaveLength(2);
      expect(retryable).toContainEqual({ fromId: 1, toId: 2 });
      expect(retryable).toContainEqual({ fromId: 3, toId: 4 });
    });

    it('clears all failures', () => {
      const queue = new RelationshipRetryQueue();

      queue.add(1, 2, 'Error');
      queue.add(3, 4, 'Error');

      expect(queue.size).toBe(2);

      queue.clear();

      expect(queue.size).toBe(0);
      expect(queue.getRetryable()).toEqual([]);
    });

    it('uses default max attempts of 3', () => {
      const queue = new RelationshipRetryQueue();

      queue.add(1, 2, 'Error');
      queue.add(1, 2, 'Error');

      const retryable = queue.getRetryable();
      expect(retryable).toHaveLength(1);

      queue.add(1, 2, 'Error');

      const retryableAfter = queue.getRetryable();
      expect(retryableAfter).toHaveLength(0);
    });

    it('handles empty queue', () => {
      const queue = new RelationshipRetryQueue();

      expect(queue.size).toBe(0);
      expect(queue.getRetryable()).toEqual([]);
    });

    it('distinguishes between different from/to pairs', () => {
      const queue = new RelationshipRetryQueue();

      queue.add(1, 2, 'Error');
      queue.add(2, 1, 'Error'); // Different pair (reversed)
      queue.add(1, 3, 'Error'); // Different toId

      expect(queue.size).toBe(3);

      const retryable = queue.getRetryable();
      expect(retryable).toHaveLength(3);
    });

    it('updates error message on re-add', () => {
      const queue = new RelationshipRetryQueue();

      queue.add(1, 2, 'First error');
      queue.add(1, 2, 'Updated error');

      expect(queue.size).toBe(1);
      // Error message should be updated (though we can't directly inspect it in the public API)
    });

    it('handles custom max attempts', () => {
      const queue = new RelationshipRetryQueue();

      queue.add(1, 2, 'Error');

      expect(queue.getRetryable(1)).toHaveLength(0); // 1 attempt, max 1
      expect(queue.getRetryable(2)).toHaveLength(1); // 1 attempt, max 2
    });
  });
});
