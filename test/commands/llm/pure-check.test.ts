import { describe, expect, it } from 'vitest';
import { detectImpurePatterns } from '../../../src/commands/llm/_shared/pure-check.js';

describe('detectImpurePatterns', () => {
  describe('detects impure patterns', () => {
    it('detects await keyword', () => {
      const source = `async function fetchData() {
        const result = await fetch('/api/data');
        return result.json();
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('async I/O (await)');
    });

    it('detects vi.fn()', () => {
      const source = 'const mock = vi.fn(() => 42);';
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('mock factory (vi.fn/jest.fn)');
    });

    it('detects jest.fn()', () => {
      const source = 'const spy = jest.fn();';
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('mock factory (vi.fn/jest.fn)');
    });

    it('detects new Date()', () => {
      const source = `function getTimestamp() {
        return { createdAt: new Date() };
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('non-deterministic (new Date())');
    });

    it('detects process.env', () => {
      const source = 'const port = process.env.PORT || 3000;';
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('environment dependency (process.env)');
    });

    it('detects import.meta.env', () => {
      const source = 'const apiUrl = import.meta.env.VITE_API_URL;';
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('environment dependency (import.meta.env)');
    });

    it('detects localStorage', () => {
      const source = "function getToken() { return localStorage.getItem('token'); }";
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('browser storage I/O');
    });

    it('detects sessionStorage', () => {
      const source = "sessionStorage.setItem('key', 'val');";
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('browser storage I/O');
    });

    it('detects Math.random()', () => {
      const source = 'function randomId() { return Math.random().toString(36); }';
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('non-deterministic (Math.random)');
    });

    it('detects console.log()', () => {
      const source = 'function debug(msg: string) { console.log(msg); }';
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('I/O side effect (console)');
    });

    it('detects console.error()', () => {
      const source = "console.error('fail');";
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('I/O side effect (console)');
    });

    it('detects React hooks', () => {
      const source = 'function App() { const [state, setState] = useState(0); }';
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('stateful React hook');
    });

    it('detects useEffect', () => {
      const source = "useEffect(() => { document.title = 'hi'; }, []);";
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('stateful React hook');
    });

    it('detects fetch calls', () => {
      const source = "fetch('/api/users').then(r => r.json());";
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('HTTP I/O (fetch/axios)');
    });

    it('detects axios calls', () => {
      const source = "const res = axios.get('/api/users');";
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('HTTP I/O (fetch/axios)');
    });

    it('detects fs operations', () => {
      const source = "const data = fs.readFileSync('config.json', 'utf-8');";
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('filesystem I/O (fs)');
    });
  });

  describe('ignores patterns in comments', () => {
    it('ignores single-line comments', () => {
      const source = `// await fetch('/api')
function pure(x: number) { return x + 1; }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toEqual([]);
    });

    it('ignores multi-line comments', () => {
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

  describe('returns empty for pure code', () => {
    it('simple arithmetic function', () => {
      const source = 'function add(a: number, b: number): number { return a + b; }';
      expect(detectImpurePatterns(source)).toEqual([]);
    });

    it('string transformation', () => {
      const source = 'function toUpperCase(s: string): string { return s.toUpperCase(); }';
      expect(detectImpurePatterns(source)).toEqual([]);
    });

    it('type definition', () => {
      const source = 'interface User { name: string; age: number; }';
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
  });

  describe('detects multiple patterns', () => {
    it('returns all detected reasons', () => {
      const source = `async function init() {
        const port = process.env.PORT;
        const data = await fetch('/api');
        console.log('started');
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons.length).toBeGreaterThanOrEqual(3);
      expect(reasons).toContain('async I/O (await)');
      expect(reasons).toContain('environment dependency (process.env)');
      expect(reasons).toContain('I/O side effect (console)');
    });
  });

  describe('real-world patterns from car-dealership analysis', () => {
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

    it('detects vi.fn() in test helper', () => {
      const source = `export function createMockService() {
        return {
          findAll: vi.fn().mockResolvedValue([]),
          findById: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({}),
        };
      }`;
      const reasons = detectImpurePatterns(source);
      expect(reasons).toContain('mock factory (vi.fn/jest.fn)');
    });
  });
});
