import type { Command } from '@oclif/core';
import { describe, expect, it, vi } from 'vitest';
import { formatLineNumber, outputJsonOrPlain, tableSeparator, truncate } from '../../../src/commands/_shared/output.js';

describe('output utilities', () => {
  describe('outputJsonOrPlain', () => {
    it('outputs JSON when json flag is true', () => {
      const logOutput: string[] = [];
      const mockCommand = {
        log: vi.fn((msg: string) => logOutput.push(msg)),
      } as unknown as Command;

      const data = { foo: 'bar', count: 42 };
      const plainFn = vi.fn();

      outputJsonOrPlain(mockCommand, true, data, plainFn);

      expect(plainFn).not.toHaveBeenCalled();
      expect(logOutput).toHaveLength(1);
      expect(JSON.parse(logOutput[0])).toEqual(data);
    });

    it('calls plainFn when json flag is false', () => {
      const mockCommand = {
        log: vi.fn(),
      } as unknown as Command;

      const data = { foo: 'bar' };
      const plainFn = vi.fn();

      outputJsonOrPlain(mockCommand, false, data, plainFn);

      expect(plainFn).toHaveBeenCalledOnce();
      expect(mockCommand.log).not.toHaveBeenCalled();
    });

    it('formats JSON with 2-space indentation', () => {
      const logOutput: string[] = [];
      const mockCommand = {
        log: vi.fn((msg: string) => logOutput.push(msg)),
      } as unknown as Command;

      const data = { nested: { value: 1 } };

      outputJsonOrPlain(mockCommand, true, data, vi.fn());

      expect(logOutput[0]).toContain('  ');
      expect(logOutput[0]).toMatch(/"nested":\s*\{/);
    });

    it('handles arrays in JSON output', () => {
      const logOutput: string[] = [];
      const mockCommand = {
        log: vi.fn((msg: string) => logOutput.push(msg)),
      } as unknown as Command;

      const data = [1, 2, 3];

      outputJsonOrPlain(mockCommand, true, data, vi.fn());

      expect(JSON.parse(logOutput[0])).toEqual([1, 2, 3]);
    });

    it('handles null data in JSON output', () => {
      const logOutput: string[] = [];
      const mockCommand = {
        log: vi.fn((msg: string) => logOutput.push(msg)),
      } as unknown as Command;

      outputJsonOrPlain(mockCommand, true, null, vi.fn());

      expect(JSON.parse(logOutput[0])).toBeNull();
    });
  });

  describe('truncate', () => {
    it('returns original string if shorter than max length', () => {
      const result = truncate('short', 10);
      expect(result).toBe('short');
    });

    it('returns original string if exactly max length', () => {
      const result = truncate('exactly10!', 10);
      expect(result).toBe('exactly10!');
    });

    it('truncates and adds ellipsis for long strings', () => {
      const result = truncate('this is a very long string', 10);
      expect(result).toBe('this is...');
      expect(result.length).toBe(10);
    });

    it('handles empty string', () => {
      const result = truncate('', 10);
      expect(result).toBe('');
    });

    it('handles maxLen of 3 (minimum for ellipsis)', () => {
      const result = truncate('long', 3);
      expect(result).toBe('...');
    });

    it('handles maxLen of 4', () => {
      const result = truncate('longer', 4);
      expect(result).toBe('l...');
    });
  });

  describe('tableSeparator', () => {
    it('creates separator line with default character', () => {
      const result = tableSeparator(5);
      expect(result).toBe('─────');
      expect(result.length).toBe(5);
    });

    it('creates separator line with custom character', () => {
      const result = tableSeparator(3, '=');
      expect(result).toBe('===');
    });

    it('handles width of 0', () => {
      const result = tableSeparator(0);
      expect(result).toBe('');
    });

    it('handles width of 1', () => {
      const result = tableSeparator(1, '-');
      expect(result).toBe('-');
    });
  });

  describe('formatLineNumber', () => {
    it('pads single digit with default width', () => {
      const result = formatLineNumber(5);
      expect(result).toBe('    5');
      expect(result.length).toBe(5);
    });

    it('pads multi-digit number with default width', () => {
      const result = formatLineNumber(123);
      expect(result).toBe('  123');
      expect(result.length).toBe(5);
    });

    it('handles number exactly at default width', () => {
      const result = formatLineNumber(12345);
      expect(result).toBe('12345');
      expect(result.length).toBe(5);
    });

    it('handles number exceeding default width', () => {
      const result = formatLineNumber(123456);
      expect(result).toBe('123456');
      expect(result.length).toBe(6);
    });

    it('uses custom width', () => {
      const result = formatLineNumber(42, 8);
      expect(result).toBe('      42');
      expect(result.length).toBe(8);
    });

    it('handles width of 1', () => {
      const result = formatLineNumber(7, 1);
      expect(result).toBe('7');
    });

    it('handles line number 0', () => {
      const result = formatLineNumber(0);
      expect(result).toBe('    0');
    });
  });
});
