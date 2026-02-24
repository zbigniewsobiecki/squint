import { describe, expect, it } from 'vitest';
import { validateAnnotationValue } from '../../../src/commands/_shared/annotation-validators.js';
import type { DependencyContextEnhanced } from '../../../src/commands/llm/_shared/prompts.js';

describe('annotation-validators', () => {
  describe('validateAnnotationValue', () => {
    describe('domain aspect', () => {
      it('accepts valid JSON array of strings', () => {
        const result = validateAnnotationValue('domain', '["auth", "users"]');
        expect(result).toBeNull();
      });

      it('rejects non-array JSON', () => {
        const result = validateAnnotationValue('domain', '{"key": "value"}');
        expect(result).toBe('domain must be a JSON array');
      });

      it('rejects array with non-string elements', () => {
        const result = validateAnnotationValue('domain', '[1, 2, 3]');
        expect(result).toBe('domain array must contain only strings');
      });

      it('rejects invalid JSON', () => {
        const result = validateAnnotationValue('domain', '{invalid json');
        expect(result).toBe('domain must be valid JSON array');
      });
    });

    describe('pure aspect', () => {
      it('accepts "true" value', () => {
        const result = validateAnnotationValue('pure', 'true');
        expect(result).toBeNull();
      });

      it('accepts "false" value', () => {
        const result = validateAnnotationValue('pure', 'false');
        expect(result).toBeNull();
      });

      it('rejects non-boolean string', () => {
        const result = validateAnnotationValue('pure', 'maybe');
        expect(result).toBe('pure must be "true" or "false"');
      });

      it('overrides false to true for type declarations', () => {
        const result = validateAnnotationValue('pure', 'false', undefined, undefined, 'type');
        expect(result).toBe('overridden to true: type-level declaration');
      });

      it('overrides false to true for interface declarations', () => {
        const result = validateAnnotationValue('pure', 'false', undefined, undefined, 'interface');
        expect(result).toBe('overridden to true: type-level declaration');
      });

      it('overrides false to true for enum declarations', () => {
        const result = validateAnnotationValue('pure', 'false', undefined, undefined, 'enum');
        expect(result).toBe('overridden to true: type-level declaration');
      });

      it('overrides true to false for class', () => {
        const result = validateAnnotationValue('pure', 'true', undefined, undefined, 'class');
        expect(result).toBe('overridden to false: class (mutable instances)');
      });

      it('overrides true to false when source contains console.log', () => {
        const sourceCode = 'function test() { console.log("hello"); }';
        const result = validateAnnotationValue('pure', 'true', sourceCode);
        expect(result).toContain('overridden to false');
      });

      it('overrides true to false when calling impure dependency', () => {
        const deps: DependencyContextEnhanced[] = [
          {
            id: 1,
            name: 'impureFn',
            kind: 'function',
            filePath: 'src/impure.ts',
            line: 1,
            purpose: 'test',
            domains: null,
            role: null,
            pure: false,
          },
        ];
        const result = validateAnnotationValue('pure', 'true', undefined, deps);
        expect(result).toBe("overridden to false: calls impure dependency 'impureFn'");
      });

      it('allows true when all dependencies are pure', () => {
        const deps: DependencyContextEnhanced[] = [
          {
            id: 1,
            name: 'pureFn',
            kind: 'function',
            filePath: 'src/pure.ts',
            line: 1,
            purpose: 'test',
            domains: null,
            role: null,
            pure: true,
          },
        ];
        const result = validateAnnotationValue('pure', 'true', undefined, deps);
        expect(result).toBeNull();
      });

      it('allows true when dependencies have unknown purity', () => {
        const deps: DependencyContextEnhanced[] = [
          {
            id: 1,
            name: 'unknownFn',
            kind: 'function',
            filePath: 'src/unknown.ts',
            line: 1,
            purpose: 'test',
            domains: null,
            role: null,
            pure: null,
          },
        ];
        const result = validateAnnotationValue('pure', 'true', undefined, deps);
        expect(result).toBeNull();
      });
    });

    describe('purpose aspect', () => {
      it('accepts purpose with sufficient length', () => {
        const result = validateAnnotationValue('purpose', 'Handles user authentication');
        expect(result).toBeNull();
      });

      it('rejects purpose that is too short', () => {
        const result = validateAnnotationValue('purpose', 'test');
        expect(result).toBe('purpose must be at least 5 characters');
      });

      it('rejects empty purpose', () => {
        const result = validateAnnotationValue('purpose', '');
        expect(result).toBe('purpose must be at least 5 characters');
      });
    });

    describe('contracts aspect', () => {
      it('accepts null value', () => {
        const result = validateAnnotationValue('contracts', 'null');
        expect(result).toBeNull();
      });

      it('accepts valid contracts array', () => {
        const contracts = JSON.stringify([
          { protocol: 'http', role: 'provider', key: 'api' },
          { protocol: 'grpc', role: 'consumer', key: 'service' },
        ]);
        const result = validateAnnotationValue('contracts', contracts);
        expect(result).toBeNull();
      });

      it('rejects non-array JSON', () => {
        const result = validateAnnotationValue('contracts', '{"key": "value"}');
        expect(result).toBe('contracts must be a JSON array or "null"');
      });

      it('rejects contract entry without protocol', () => {
        const contracts = JSON.stringify([{ role: 'provider', key: 'api' }]);
        const result = validateAnnotationValue('contracts', contracts);
        expect(result).toBe('each contract entry must have a non-empty "protocol" string');
      });

      it('rejects contract entry without role', () => {
        const contracts = JSON.stringify([{ protocol: 'http', key: 'api' }]);
        const result = validateAnnotationValue('contracts', contracts);
        expect(result).toBe('each contract entry must have a non-empty "role" string');
      });

      it('rejects contract entry without key', () => {
        const contracts = JSON.stringify([{ protocol: 'http', role: 'provider' }]);
        const result = validateAnnotationValue('contracts', contracts);
        expect(result).toBe('each contract entry must have a non-empty "key" string');
      });

      it('rejects non-object array elements', () => {
        const contracts = JSON.stringify(['string', 'values']);
        const result = validateAnnotationValue('contracts', contracts);
        expect(result).toBe('each contract entry must be an object');
      });

      it('rejects invalid JSON', () => {
        const result = validateAnnotationValue('contracts', '{invalid json');
        expect(result).toBe('contracts must be valid JSON array or "null"');
      });
    });

    describe('unknown aspect', () => {
      it('returns null for unknown aspect (no validation)', () => {
        const result = validateAnnotationValue('custom_aspect', 'any value');
        expect(result).toBeNull();
      });
    });
  });
});
