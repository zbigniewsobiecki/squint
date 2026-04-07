import type { DiffReport, RowDiff, Severity, TableDiff } from '../types.js';

/**
 * Render a DiffReport as a human-readable Markdown document for triage.
 */
export function renderMarkdownReport(report: DiffReport): string {
  const badge = report.passed ? '✅ PASS' : '❌ FAIL';
  const lines: string[] = [];

  lines.push(`# Squint Eval Report — ${report.fixtureName} — ${badge}`);
  lines.push('');
  if (report.squintCommit) {
    lines.push(`**Squint commit**: \`${report.squintCommit}\``);
  }
  lines.push(`**Duration**: ${report.durationMs}ms`);
  lines.push(`**Scope**: ${report.scope.join(', ')}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Critical: ${report.summary.critical}`);
  lines.push(`- Major: ${report.summary.major}`);
  lines.push(`- Minor: ${report.summary.minor}`);
  if (report.summary.proseChecks.passed + report.summary.proseChecks.failed > 0) {
    lines.push(
      `- Prose checks: ${report.summary.proseChecks.passed} passed, ${report.summary.proseChecks.failed} failed`
    );
  }
  lines.push('');

  for (const table of report.tables) {
    lines.push(...renderTableSection(table));
    lines.push('');
  }

  return lines.join('\n');
}

function renderTableSection(table: TableDiff): string[] {
  const status = table.passed ? '✅' : '❌';
  const lines: string[] = [];
  lines.push(`## Table: ${table.table} ${status} (${table.producedCount}/${table.expectedCount})`);
  lines.push('');

  if (table.diffs.length === 0) {
    lines.push('All rows matched.');
    return lines;
  }

  // Group by severity in display order
  const order: Severity[] = ['critical', 'major', 'minor'];
  const labels: Record<Severity, string> = {
    critical: '### 🔴 CRITICAL',
    major: '### 🟠 Major',
    minor: '### 🟡 Minor',
  };

  for (const sev of order) {
    const subset = table.diffs.filter((d) => d.severity === sev);
    if (subset.length === 0) continue;
    lines.push(labels[sev]);
    lines.push('');
    for (const d of subset) {
      lines.push(...renderRowDiff(d));
    }
    lines.push('');
  }

  return lines;
}

function renderRowDiff(d: RowDiff): string[] {
  const lines: string[] = [];
  lines.push(`- **${d.kind}** \`${d.naturalKey}\``);
  lines.push(`  - ${d.details}`);
  if (d.fixHintId) {
    lines.push(`  - Fix hint: \`${d.fixHintId}\``);
  }
  return lines;
}

/**
 * Render a DiffReport as pretty-printed JSON for the baseline scoreboard / CI.
 */
export function renderJsonReport(report: DiffReport): string {
  return JSON.stringify(report, null, 2);
}
