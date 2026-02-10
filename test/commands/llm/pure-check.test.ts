import { describe, expect, it } from 'vitest';
import { detectImpurePatterns } from '../../../src/commands/llm/_shared/pure-check.js';

describe('detectImpurePatterns', () => {
  describe('await detection', () => {
    it('detects await expression', () => {
      const source = `async function fetchData() {
        const result = await fetch('/api/data');
        return result.json();
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('async I/O (await)');
    });

    it('ignores await in comments', () => {
      const source = `// await fetch('/api')
function pure(x: number) { return x + 1; }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toEqual([]);
    });
  });

  describe('yield detection', () => {
    it('detects yield expression', () => {
      const source = `function* gen() {
        yield 1;
        yield 2;
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('generator side effect (yield)');
    });
  });

  describe('outer-scope mutation', () => {
    it('detects mutation of non-local variable', () => {
      const source = `function resetCounter() {
        counter = 0;
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('outer-scope mutation (counter)');
    });

    it('does NOT flag local variable mutation', () => {
      const source = `function compute() {
        let x = 0;
        x = 1;
        return x;
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toEqual([]);
    });

    it('detects mutation of non-local object property', () => {
      const source = `function setName() {
        outerObj.name = 'test';
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('outer-scope mutation (outerObj)');
    });

    it('does NOT flag local object property mutation', () => {
      const source = `function build() {
        const obj = {};
        obj.x = 1;
        return obj;
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toEqual([]);
    });

    it('does NOT flag this.x assignment', () => {
      const source = `function setVal() {
        this.x = 42;
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toEqual([]);
    });

    it('detects update expression (++) on non-local', () => {
      const source = `function increment() {
        counter++;
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('outer-scope mutation (counter)');
    });

    it('does NOT flag update expression on local variable', () => {
      const source = `function loop() {
        let i = 0;
        i++;
        return i;
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toEqual([]);
    });

    it('detects augmented assignment (+=) on non-local', () => {
      const source = `function add() {
        total += 10;
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('outer-scope mutation (total)');
    });
  });

  describe('new Date() detection', () => {
    it('detects new Date() with no args', () => {
      const source = `function getTimestamp() {
        return { createdAt: new Date() };
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('non-deterministic (new Date())');
    });

    it('does NOT flag new Date(timestamp) with args', () => {
      const source = `function fromTimestamp(ts: number) {
        return new Date(ts);
      }`;
      const reasons = detectImpurePatterns(source);
      const dateReasons = reasons.filter((r) => r.includes('new Date'));
      expect(dateReasons).toEqual([]);
    });
  });

  describe('Math.random() detection', () => {
    it('detects Math.random()', () => {
      const source = 'function randomId() { return Math.random().toString(36); }';
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('non-deterministic (Math.random)');
    });

    it('does NOT flag Math.floor()', () => {
      const source = 'function roundDown(x: number) { return Math.floor(x); }';
      const reasons = detectImpurePatterns(source);
      const mathReasons = reasons.filter((r) => r.includes('Math'));
      expect(mathReasons).toEqual([]);
    });
  });

  describe('ambient global detection', () => {
    it('detects console.log() call', () => {
      const source = 'function debug(msg: string) { console.log(msg); }';
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('ambient global I/O (console.log)');
    });

    it('detects console.error() call', () => {
      const source = "console.error('fail');";
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('ambient global I/O (console.error)');
    });

    it('detects process.env access', () => {
      const source = 'const port = process.env.PORT || 3000;';
      const reasons = detectImpurePatterns(source);
      expect(reasons.some((r) => r.includes('process.env'))).toBe(true);
    });

    it('detects localStorage.getItem() call', () => {
      const source = "function getToken() { return localStorage.getItem('token'); }";
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('ambient global I/O (localStorage.getItem)');
    });

    it('detects document.getElementById() call', () => {
      const source = "function getEl() { return document.getElementById('app'); }";
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('ambient global I/O (document.getElementById)');
    });

    it('detects sessionStorage access', () => {
      const source = "sessionStorage.setItem('key', 'val');";
      const reasons = detectImpurePatterns(source);
      expect(reasons.some((r) => r.includes('sessionStorage'))).toBe(true);
    });
  });

  describe('import.meta.env detection', () => {
    it('detects import.meta.env', () => {
      const source = 'const apiUrl = import.meta.env.VITE_API_URL;';
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('environment dependency (import.meta.env)');
    });
  });

  describe('comments ignored', () => {
    it('ignores impure patterns only in single-line comments', () => {
      const source = `// await fetch('/api')
// console.log('hi')
function pure(x: number) { return x + 1; }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toEqual([]);
    });

    it('ignores impure patterns only in multi-line comments', () => {
      const source = `/*
 * This function does NOT use:
 * - new Date()
 * - process.env
 * - await fetch()
 */
function pure(x: number) { return x * 2; }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toEqual([]);
    });
  });

  describe('pure code returns empty', () => {
    it('simple arithmetic function', () => {
      const source = 'function add(a: number, b: number): number { return a + b; }';
      expect(detectImpurePatterns(source)).toEqual([]);
    });

    it('string transformation', () => {
      const source = 'function toUpperCase(s: string): string { return s.toUpperCase(); }';
      expect(detectImpurePatterns(source)).toEqual([]);
    });

    it('simple object creation', () => {
      const source = 'function createUser(name: string) { return { name, active: true }; }';
      expect(detectImpurePatterns(source)).toEqual([]);
    });

    it('array operations', () => {
      const source = 'function filterEven(nums: number[]) { return nums.filter(n => n % 2 === 0); }';
      expect(detectImpurePatterns(source)).toEqual([]);
    });

    it('parameter destructuring with local mutation', () => {
      const source = `function swap({ a, b }: { a: number; b: number }) {
        let temp = a;
        temp = b;
        return { a: b, b: temp };
      }`;
      expect(detectImpurePatterns(source)).toEqual([]);
    });
  });

  describe('multiple reasons', () => {
    it('returns all detected reasons', () => {
      const source = `async function init() {
        const port = process.env.PORT;
        const data = await fetch('/api');
        console.log('started');
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons.length).toBeGreaterThanOrEqual(3);
      expect(reasons).toContain('async I/O (await)');
      expect(reasons.some((r) => r.includes('process'))).toBe(true);
      expect(reasons.some((r) => r.includes('console'))).toBe(true);
    });
  });

  describe('real-world regression: resetCustomerIdCounter', () => {
    it('detects outer-scope mutation in reset*IdCounter pattern', () => {
      const source = `export function resetCustomerIdCounter(): void {
        nextId = 1;
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('outer-scope mutation (nextId)');
    });

    it('detects new Date() in factory function returning object', () => {
      const source = `export function createVehicle(dto: CreateVehicleDto) {
        return {
          ...dto,
          id: generateId(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('non-deterministic (new Date())');
    });
  });

  describe('non-function snippets (no false positives)', () => {
    it('interface returns empty', () => {
      const source = 'interface User { name: string; age: number; }';
      expect(detectImpurePatterns(source)).toEqual([]);
    });

    it('type alias returns empty', () => {
      const source = 'type ID = string | number;';
      expect(detectImpurePatterns(source)).toEqual([]);
    });

    it('enum returns empty', () => {
      const source = 'enum Color { Red, Green, Blue }';
      expect(detectImpurePatterns(source)).toEqual([]);
    });
  });

  describe('module-scope side effect detection', () => {
    it('detects module-scope call to imported function (rateLimit)', () => {
      const source = 'const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });';
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('module-scope side effect (rateLimit())');
    });

    it('detects module-scope call to imported function (createPool)', () => {
      const source = `const pool = createPool({ host: 'localhost', port: 5432 });`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('module-scope side effect (createPool())');
    });

    it('does NOT flag module-scope call to pure built-in (parseInt)', () => {
      const source = `const x = parseInt("42");`;
      const reasons = detectImpurePatterns(source);
      const moduleScopeReasons = reasons.filter((r) => r.includes('module-scope'));
      expect(moduleScopeReasons).toEqual([]);
    });

    it('does NOT flag module-scope new RegExp (pure built-in constructor)', () => {
      const source = `const regex = new RegExp("abc");`;
      const reasons = detectImpurePatterns(source);
      const moduleScopeReasons = reasons.filter((r) => r.includes('module-scope'));
      expect(moduleScopeReasons).toEqual([]);
    });

    it('detects module-scope new of non-builtin class (QueryClient)', () => {
      const source = 'const client = new QueryClient();';
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('module-scope side effect (new QueryClient())');
    });

    it('does NOT flag calls inside a function body', () => {
      const source = 'function setup() { const limiter = rateLimit({ max: 100 }); return limiter; }';
      const reasons = detectImpurePatterns(source);
      const moduleScopeReasons = reasons.filter((r) => r.includes('module-scope'));
      expect(moduleScopeReasons).toEqual([]);
    });

    it('detects module-scope express() call', () => {
      const source = 'const app = express();';
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('module-scope side effect (express())');
    });
  });

  describe('edge cases', () => {
    it('empty string returns empty', () => {
      expect(detectImpurePatterns('')).toEqual([]);
    });

    it('whitespace-only returns empty', () => {
      expect(detectImpurePatterns('   \n\n  ')).toEqual([]);
    });

    it('arrow function with export', () => {
      const source = `export const reset = () => {
        counter = 0;
      };`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('outer-scope mutation (counter)');
    });

    it('for-of loop variable is local', () => {
      const source = `function sum(items: number[]) {
        let total = 0;
        for (const item of items) {
          total += item;
        }
        return total;
      }`;
      // 'total' and 'item' are both local — no outer-scope mutation
      expect(detectImpurePatterns(source)).toEqual([]);
    });
  });
});
