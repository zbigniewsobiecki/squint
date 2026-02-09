import { describe, expect, it } from 'vitest';
import {
  calculatePercentage,
  createLookup,
  generateUniqueSlug,
  getErrorMessage,
  groupBy,
  processBatches,
} from '../../../src/commands/llm/_shared/llm-utils.js';

describe('llm-utils', () => {
  // ============================================
  // getErrorMessage
  // ============================================
  describe('getErrorMessage', () => {
    it('extracts message from Error instance', () => {
      expect(getErrorMessage(new Error('boom'))).toBe('boom');
    });

    it('converts string to string', () => {
      expect(getErrorMessage('string error')).toBe('string error');
    });

    it('converts number to string', () => {
      expect(getErrorMessage(42)).toBe('42');
    });

    it('converts null to string', () => {
      expect(getErrorMessage(null)).toBe('null');
    });

    it('converts undefined to string', () => {
      expect(getErrorMessage(undefined)).toBe('undefined');
    });

    it('converts object to string', () => {
      expect(getErrorMessage({ code: 500 })).toBe('[object Object]');
    });
  });

  // ============================================
  // calculatePercentage
  // ============================================
  describe('calculatePercentage', () => {
    it('calculates correct percentage', () => {
      expect(calculatePercentage(50, 100)).toBe(50);
    });

    it('returns 0 for zero total (division by zero)', () => {
      expect(calculatePercentage(5, 0)).toBe(0);
    });

    it('rounds to specified decimals', () => {
      expect(calculatePercentage(1, 3, 2)).toBe(33.33);
    });

    it('defaults to 1 decimal', () => {
      expect(calculatePercentage(1, 3)).toBe(33.3);
    });

    it('handles 100% correctly', () => {
      expect(calculatePercentage(100, 100)).toBe(100);
    });

    it('handles value > total', () => {
      expect(calculatePercentage(150, 100)).toBe(150);
    });

    it('handles zero value', () => {
      expect(calculatePercentage(0, 100)).toBe(0);
    });
  });

  // ============================================
  // createLookup
  // ============================================
  describe('createLookup', () => {
    it('creates a lookup map', () => {
      const items = [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ];
      const map = createLookup(items, (i) => i.id);
      expect(map.size).toBe(2);
      expect(map.get(1)?.name).toBe('a');
      expect(map.get(2)?.name).toBe('b');
    });

    it('handles empty array', () => {
      const map = createLookup([], (i: number) => i);
      expect(map.size).toBe(0);
    });

    it('last value wins for duplicate keys', () => {
      const items = [
        { id: 1, val: 'first' },
        { id: 1, val: 'second' },
      ];
      const map = createLookup(items, (i) => i.id);
      expect(map.get(1)?.val).toBe('second');
    });

    it('supports string keys', () => {
      const items = [{ type: 'user' }, { type: 'admin' }];
      const map = createLookup(items, (i) => i.type);
      expect(map.has('user')).toBe(true);
      expect(map.has('admin')).toBe(true);
    });
  });

  // ============================================
  // groupBy
  // ============================================
  describe('groupBy', () => {
    it('groups items by key', () => {
      const items = [
        { type: 'a', val: 1 },
        { type: 'b', val: 2 },
        { type: 'a', val: 3 },
      ];
      const map = groupBy(items, (i) => i.type);
      expect(map.get('a')).toHaveLength(2);
      expect(map.get('b')).toHaveLength(1);
    });

    it('handles empty array', () => {
      const map = groupBy([], (i: number) => i);
      expect(map.size).toBe(0);
    });

    it('handles single group', () => {
      const items = [{ k: 'x' }, { k: 'x' }, { k: 'x' }];
      const map = groupBy(items, (i) => i.k);
      expect(map.get('x')).toHaveLength(3);
    });
  });

  // ============================================
  // processBatches
  // ============================================
  describe('processBatches', () => {
    it('processes all items in batches', async () => {
      const items = [1, 2, 3, 4, 5];
      const results = await processBatches({
        items,
        batchSize: 2,
        processBatch: async (batch) => batch.map((x) => x * 2),
      });
      expect(results).toEqual([2, 4, 6, 8, 10]);
    });

    it('handles empty items', async () => {
      const results = await processBatches({
        items: [],
        batchSize: 10,
        processBatch: async (batch) => batch,
      });
      expect(results).toEqual([]);
    });

    it('calls onBatchComplete callback', async () => {
      const completedBatches: number[] = [];
      await processBatches({
        items: [1, 2, 3, 4],
        batchSize: 2,
        processBatch: async (batch) => batch,
        onBatchComplete: (_results, batchIndex, _total) => {
          completedBatches.push(batchIndex);
        },
      });
      expect(completedBatches).toEqual([0, 1]);
    });

    it('uses onBatchError fallback', async () => {
      const results = await processBatches({
        items: [1, 2, 3],
        batchSize: 2,
        processBatch: async (batch) => {
          if (batch.includes(1)) throw new Error('fail');
          return batch;
        },
        onBatchError: () => [-1],
      });
      expect(results).toEqual([-1, 3]);
    });

    it('re-throws when no onBatchError handler', async () => {
      await expect(
        processBatches({
          items: [1],
          batchSize: 1,
          processBatch: async () => {
            throw new Error('fail');
          },
        })
      ).rejects.toThrow('fail');
    });

    it('onBatchError returning null omits results', async () => {
      const results = await processBatches({
        items: [1, 2, 3, 4],
        batchSize: 2,
        processBatch: async (batch) => {
          if (batch.includes(1)) throw new Error('fail');
          return batch;
        },
        onBatchError: () => null,
      });
      expect(results).toEqual([3, 4]);
    });

    it('handles batch size larger than items', async () => {
      const results = await processBatches({
        items: [1, 2],
        batchSize: 100,
        processBatch: async (batch) => batch,
      });
      expect(results).toEqual([1, 2]);
    });
  });

  // ============================================
  // generateUniqueSlug
  // ============================================
  describe('generateUniqueSlug', () => {
    it('generates kebab-case slug from camelCase', () => {
      const used = new Set<string>();
      expect(generateUniqueSlug('MyComponent', used)).toBe('my-component');
    });

    it('generates slug from PascalCase', () => {
      const used = new Set<string>();
      expect(generateUniqueSlug('UserController', used)).toBe('user-controller');
    });

    it('removes special characters', () => {
      const used = new Set<string>();
      expect(generateUniqueSlug('hello_world!', used)).toBe('hello-world');
    });

    it('strips leading and trailing hyphens', () => {
      const used = new Set<string>();
      expect(generateUniqueSlug('--test--', used)).toBe('test');
    });

    it('appends counter for duplicates', () => {
      const used = new Set(['my-slug']);
      expect(generateUniqueSlug('my-slug', used)).toBe('my-slug-1');
    });

    it('increments counter for multiple duplicates', () => {
      const used = new Set(['test', 'test-1', 'test-2']);
      expect(generateUniqueSlug('test', used)).toBe('test-3');
    });

    it('adds slug to used set', () => {
      const used = new Set<string>();
      generateUniqueSlug('test', used);
      expect(used.has('test')).toBe(true);
    });

    it('adds unique variant to used set', () => {
      const used = new Set(['test']);
      generateUniqueSlug('test', used);
      expect(used.has('test-1')).toBe(true);
    });
  });
});
