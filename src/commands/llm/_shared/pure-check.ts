/**
 * Deterministic impure pattern detection for pure annotation gating.
 * Checks source code for patterns that indicate impurity (side effects, non-determinism).
 */

/**
 * Strip comments from source code to avoid false positives on commented-out code.
 */
function stripComments(source: string): string {
  // Remove single-line comments
  let result = source.replace(/\/\/.*$/gm, '');
  // Remove multi-line comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');
  return result;
}

/**
 * Detect impure patterns in source code.
 * Returns a list of reasons why the code is impure (empty = possibly pure).
 */
export function detectImpurePatterns(sourceCode: string): string[] {
  const reasons: string[] = [];
  const code = stripComments(sourceCode);

  const patterns: Array<{ regex: RegExp; reason: string }> = [
    { regex: /\bawait\b/, reason: 'async I/O (await)' },
    { regex: /\b(?:vi|jest)\.fn\b/, reason: 'mock factory (vi.fn/jest.fn)' },
    { regex: /\bnew\s+Date\s*\(/, reason: 'non-deterministic (new Date())' },
    { regex: /\bprocess\.env\b/, reason: 'environment dependency (process.env)' },
    { regex: /\bimport\.meta\.env\b/, reason: 'environment dependency (import.meta.env)' },
    { regex: /\b(?:localStorage|sessionStorage)\b/, reason: 'browser storage I/O' },
    { regex: /\bMath\.random\s*\(/, reason: 'non-deterministic (Math.random)' },
    { regex: /\bconsole\.\w+\s*\(/, reason: 'I/O side effect (console)' },
    { regex: /\buse[A-Z]\w*\s*\(/, reason: 'stateful React hook' },
    { regex: /\b(?:fetch|axios)\s*[.(]/, reason: 'HTTP I/O (fetch/axios)' },
    { regex: /\bfs\.\w+/, reason: 'filesystem I/O (fs)' },
  ];

  for (const { regex, reason } of patterns) {
    if (regex.test(code)) {
      reasons.push(reason);
    }
  }

  return reasons;
}
