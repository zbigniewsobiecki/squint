/**
 * Coverage display utilities for LLM annotation.
 */

import chalk from 'chalk';

export interface CoverageInfo {
  aspect: string;
  covered: number;
  total: number;
  percentage: number;
}

export interface AnnotationResult {
  symbolId: number;
  symbolName: string;
  aspect: string;
  value: string;
  success: boolean;
  error?: string;
}

export interface RelationshipAnnotationResult {
  fromId: number;
  fromName: string;
  toId: number;
  toName: string;
  value: string;
  success: boolean;
  error?: string;
}

export interface RelationshipCoverageInfo {
  annotated: number;
  total: number;
  percentage: number;
}

export interface IterationSummary {
  iteration: number;
  results: AnnotationResult[];
  relationshipResults: RelationshipAnnotationResult[];
  coverage: CoverageInfo[];
  relationshipCoverage: RelationshipCoverageInfo;
  readyCount: number;
  blockedCount: number;
}

/**
 * Format coverage stats as a single line.
 */
export function formatCoverageLine(coverage: CoverageInfo): string {
  const percentage = coverage.percentage.toFixed(1);
  const percentColor = coverage.percentage >= 80 ? chalk.green : coverage.percentage >= 50 ? chalk.yellow : chalk.red;

  return `${coverage.aspect}: ${coverage.covered}/${coverage.total} (${percentColor(`${percentage}%`)})`;
}

/**
 * Format all coverage stats.
 */
export function formatCoverageStats(coverage: CoverageInfo[], previousCoverage?: CoverageInfo[]): string[] {
  const lines: string[] = [];

  for (const c of coverage) {
    let line = formatCoverageLine(c);

    // Add delta if we have previous coverage
    if (previousCoverage) {
      const prev = previousCoverage.find((p) => p.aspect === c.aspect);
      if (prev) {
        const delta = c.covered - prev.covered;
        if (delta > 0) {
          line += chalk.green(` [+${delta} this iteration]`);
        }
      }
    }

    lines.push(line);
  }

  return lines;
}

/**
 * Format iteration results.
 */
export function formatIterationResults(summary: IterationSummary): string[] {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold(`Iteration ${summary.iteration}:`));

  // Group symbol results by symbol
  const bySymbol = new Map<number, AnnotationResult[]>();
  for (const result of summary.results) {
    const existing = bySymbol.get(result.symbolId) || [];
    existing.push(result);
    bySymbol.set(result.symbolId, existing);
  }

  // Group relationship results by from symbol
  const relsBySymbol = new Map<number, RelationshipAnnotationResult[]>();
  for (const rel of summary.relationshipResults) {
    const existing = relsBySymbol.get(rel.fromId) || [];
    existing.push(rel);
    relsBySymbol.set(rel.fromId, existing);
  }

  // Output results grouped by symbol
  for (const [symbolId, results] of bySymbol) {
    const firstResult = results[0];
    const allSuccessful = results.every((r) => r.success);
    const icon = allSuccessful ? chalk.green('✓') : chalk.red('✗');

    // Show first successful value (usually purpose)
    const purposeResult = results.find((r) => r.aspect === 'purpose' && r.success);
    const displayValue = purposeResult ? `: "${purposeResult.value}"` : '';

    lines.push(`  ${icon} ${firstResult.symbolName}${displayValue}`);

    // Show aspect annotations (not purpose since it's already shown)
    for (const result of results) {
      if (result.success && result.aspect !== 'purpose') {
        lines.push(`    ${result.aspect}: ${result.value}`);
      }
    }

    // Show relationship annotations for this symbol
    const symbolRels = relsBySymbol.get(symbolId) || [];
    for (const rel of symbolRels) {
      if (rel.success) {
        lines.push(`    ${chalk.cyan('→')} ${rel.toName}: "${rel.value}"`);
      }
    }

    // Show any errors
    for (const result of results) {
      if (!result.success && result.error) {
        lines.push(`    ${chalk.red('└')} ${result.aspect}: ${result.error}`);
      }
    }
    for (const rel of symbolRels) {
      if (!rel.success && rel.error) {
        lines.push(`    ${chalk.red('└')} → ${rel.toName}: ${rel.error}`);
      }
    }
  }

  // Show errors for missing symbols
  const symbolIds = new Set(summary.results.map((r) => r.symbolId));
  if (symbolIds.size === 0 && summary.results.length === 0) {
    lines.push(`  ${chalk.yellow('No annotations received from LLM')}`);
  }

  lines.push('');

  // Coverage
  lines.push(chalk.dim('Coverage:'));
  for (const line of formatCoverageStats(summary.coverage)) {
    lines.push(`  ${line}`);
  }
  // Add relationship coverage
  const relCov = summary.relationshipCoverage;
  const relPercentColor = relCov.percentage >= 80 ? chalk.green : relCov.percentage >= 50 ? chalk.yellow : chalk.red;
  lines.push(
    `  relationships: ${relCov.annotated}/${relCov.total} (${relPercentColor(`${relCov.percentage.toFixed(1)}%`)})`
  );

  // Ready/blocked counts
  lines.push('');
  lines.push(
    `Ready: ${chalk.cyan(summary.readyCount)} symbols | Blocked: ${chalk.gray(summary.blockedCount)} (unmet deps)`
  );

  return lines;
}

/**
 * Format final summary.
 */
export function formatFinalSummary(
  totalAnnotations: number,
  totalRelationshipAnnotations: number,
  totalErrors: number,
  iterations: number,
  coverage: CoverageInfo[],
  relationshipCoverage: RelationshipCoverageInfo
): string[] {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold('═'.repeat(50)));
  lines.push(chalk.bold('Annotation Complete'));
  lines.push(chalk.bold('═'.repeat(50)));
  lines.push('');
  lines.push(`Total iterations: ${iterations}`);
  lines.push(`Symbol annotations created: ${chalk.green(totalAnnotations)}`);
  lines.push(`Relationship annotations created: ${chalk.green(totalRelationshipAnnotations)}`);
  if (totalErrors > 0) {
    lines.push(`Errors: ${chalk.red(totalErrors)}`);
  }
  lines.push('');
  lines.push(chalk.bold('Final Coverage:'));
  for (const c of coverage) {
    lines.push(`  ${formatCoverageLine(c)}`);
  }
  // Add relationship coverage
  const relPercentColor =
    relationshipCoverage.percentage >= 80
      ? chalk.green
      : relationshipCoverage.percentage >= 50
        ? chalk.yellow
        : chalk.red;
  lines.push(
    `  relationships: ${relationshipCoverage.annotated}/${relationshipCoverage.total} (${relPercentColor(`${relationshipCoverage.percentage.toFixed(1)}%`)})`
  );

  return lines;
}

/**
 * Build coverage info for specified aspects from database coverage data.
 */
export function filterCoverageForAspects(
  allCoverage: CoverageInfo[],
  aspects: string[],
  totalSymbols: number
): CoverageInfo[] {
  const result: CoverageInfo[] = [];

  for (const aspect of aspects) {
    const existing = allCoverage.find((c) => c.aspect === aspect);
    if (existing) {
      result.push(existing);
    } else {
      // Aspect not in use yet
      result.push({
        aspect,
        covered: 0,
        total: totalSymbols,
        percentage: 0,
      });
    }
  }

  return result;
}
