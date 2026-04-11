import { describe, expect, it } from 'vitest';
import type { RowDiff } from '../types.js';
import { countDiffsBySeverity, tableDiffPassed } from './severity.js';

const diff = (severity: RowDiff['severity'], kind: RowDiff['kind'] = 'mismatch'): RowDiff => ({
  kind,
  severity,
  naturalKey: 'k',
  details: 'd',
});

describe('countDiffsBySeverity', () => {
  it('returns all-zeros on empty input', () => {
    expect(countDiffsBySeverity([])).toEqual({ critical: 0, major: 0, minor: 0 });
  });

  it('counts each severity correctly', () => {
    expect(countDiffsBySeverity([diff('critical'), diff('critical'), diff('major'), diff('minor')])).toEqual({
      critical: 2,
      major: 1,
      minor: 1,
    });
  });

  it('excludes prose-drift diffs from severity counting', () => {
    expect(countDiffsBySeverity([diff('minor', 'prose-drift'), diff('minor'), diff('major', 'prose-drift')])).toEqual({
      critical: 0,
      major: 0,
      minor: 1,
    });
  });
});

describe('tableDiffPassed', () => {
  it('returns true on empty diffs', () => {
    expect(tableDiffPassed([])).toBe(true);
  });

  it('returns true when only minor diffs are present', () => {
    expect(tableDiffPassed([diff('minor'), diff('minor')])).toBe(true);
  });

  it('returns false on a single major diff', () => {
    expect(tableDiffPassed([diff('major')])).toBe(false);
  });

  it('returns false on a single critical diff', () => {
    expect(tableDiffPassed([diff('critical')])).toBe(false);
  });

  it('returns true when only prose drifts are present (they are informational)', () => {
    expect(tableDiffPassed([diff('minor', 'prose-drift'), diff('major', 'prose-drift')])).toBe(true);
  });
});
