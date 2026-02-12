import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { SharedFlags, withDatabase } from '../_shared/index.js';

/** Common abbreviation → full form expansions. */
const ABBREVIATION_MAP: Record<string, string> = {
  auth: 'authentication',
  authn: 'authentication',
  authz: 'authorization',
  config: 'configuration',
  db: 'database',
  err: 'error',
  fmt: 'formatting',
  func: 'function',
  gen: 'generation',
  init: 'initialization',
  mgmt: 'management',
  msg: 'message',
  nav: 'navigation',
  perf: 'performance',
  perm: 'permission',
  pkg: 'package',
  proc: 'processing',
  repo: 'repository',
  req: 'request',
  res: 'response',
  sess: 'session',
  util: 'utility',
  utils: 'utility',
  val: 'validation',
};

interface MergeGroup {
  /** The normalized key used for grouping. */
  normalizedKey: string;
  /** All domain name variants in this group. */
  variants: string[];
  /** Symbol count per variant. */
  counts: Map<string, number>;
  /** The suggested canonical domain name. */
  canonical: string;
  /** Reason for the merge suggestion. */
  reason: string;
}

/**
 * Normalize a domain name for grouping:
 * - Expand known abbreviations
 * - Lowercase
 */
function normalizeDomain(name: string): string {
  let normalized = name.toLowerCase();

  // Expand abbreviations (check full domain and individual parts)
  if (ABBREVIATION_MAP[normalized]) {
    return ABBREVIATION_MAP[normalized];
  }

  // Try expanding parts separated by hyphens
  const parts = normalized.split('-');
  const expanded = parts.map((p) => ABBREVIATION_MAP[p] ?? p);
  normalized = expanded.join('-');

  return normalized;
}

/**
 * Pick the canonical name from a group of variants:
 * prefer the most-used variant.
 */
function pickCanonical(variants: string[], counts: Map<string, number>): string {
  let best = variants[0];
  let bestCount = counts.get(best) ?? 0;
  for (const v of variants) {
    const c = counts.get(v) ?? 0;
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

/**
 * Detect the reason for grouping.
 */
function detectReason(variants: string[]): string {
  // Check abbreviation
  for (const v of variants) {
    const parts = v.split('-');
    for (const part of parts) {
      if (ABBREVIATION_MAP[part.toLowerCase()]) {
        return `abbreviation (${part} → ${ABBREVIATION_MAP[part.toLowerCase()]})`;
      }
    }
  }

  return 'similar names';
}

export default class Consolidate extends Command {
  static override description = 'Detect and suggest domain merges for abbreviation synonyms';

  static override examples = [
    '<%= config.bin %> domains consolidate',
    '<%= config.bin %> domains consolidate --fix',
    '<%= config.bin %> domains consolidate --min-group-size 3',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    fix: Flags.boolean({
      description: 'Execute suggested merges automatically',
      default: false,
    }),
    'min-group-size': Flags.integer({
      description: 'Minimum group size to suggest merge (default: 2)',
      default: 2,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Consolidate);
    const minGroupSize = flags['min-group-size'] ?? 2;

    await withDatabase(flags.database, this, async (db) => {
      // Get all domains in use with counts
      const allDomains = db.domains.getAllWithCounts();
      const inUseDomains = new Map<string, number>();

      // Also count unregistered domains
      const unregistered = db.domains.getUnregistered();
      for (const domain of unregistered) {
        const count = db.domains.getSymbolsByDomain(domain).length;
        inUseDomains.set(domain, count);
      }
      for (const d of allDomains) {
        inUseDomains.set(d.name, d.symbolCount);
      }

      if (inUseDomains.size === 0) {
        this.log(chalk.gray('No domains in use.'));
        return;
      }

      // Group by normalized form
      const normalizedGroups = new Map<string, string[]>();
      for (const domain of inUseDomains.keys()) {
        const key = normalizeDomain(domain);
        if (!normalizedGroups.has(key)) normalizedGroups.set(key, []);
        normalizedGroups.get(key)!.push(domain);
      }

      // Build merge suggestions
      const mergeGroups: MergeGroup[] = [];
      for (const [key, variants] of normalizedGroups) {
        if (variants.length < minGroupSize) continue;

        const counts = new Map<string, number>();
        for (const v of variants) {
          counts.set(v, inUseDomains.get(v) ?? 0);
        }

        mergeGroups.push({
          normalizedKey: key,
          variants: variants.sort(),
          counts,
          canonical: pickCanonical(variants, counts),
          reason: detectReason(variants),
        });
      }

      if (mergeGroups.length === 0) {
        if (flags.json) {
          this.log(JSON.stringify({ suggestions: [], merged: 0 }, null, 2));
        } else {
          this.log(chalk.green('No domain consolidation suggestions found.'));
        }
        return;
      }

      if (flags.json) {
        const output = {
          suggestions: mergeGroups.map((g) => ({
            canonical: g.canonical,
            variants: g.variants,
            counts: Object.fromEntries(g.counts),
            reason: g.reason,
          })),
          merged: 0,
        };

        if (flags.fix) {
          let totalMerged = 0;
          for (const group of mergeGroups) {
            for (const variant of group.variants) {
              if (variant === group.canonical) continue;
              const result = db.domains.merge(variant, group.canonical);
              totalMerged += result.symbolsUpdated;
            }
          }
          output.merged = totalMerged;
        }

        this.log(JSON.stringify(output, null, 2));
        return;
      }

      // Display suggestions
      this.log(chalk.bold(`Found ${mergeGroups.length} consolidation suggestion(s):\n`));

      for (const group of mergeGroups) {
        this.log(`  ${chalk.cyan(group.canonical)} ← ${group.reason}`);
        for (const variant of group.variants) {
          const count = group.counts.get(variant) ?? 0;
          const marker = variant === group.canonical ? chalk.green(' (canonical)') : '';
          this.log(`    ${variant} (${count} symbol${count !== 1 ? 's' : ''})${marker}`);
        }
        this.log('');
      }

      if (flags.fix) {
        let totalMerged = 0;
        for (const group of mergeGroups) {
          for (const variant of group.variants) {
            if (variant === group.canonical) continue;
            const result = db.domains.merge(variant, group.canonical);
            if (result.symbolsUpdated > 0) {
              this.log(
                chalk.green(
                  `  Merged ${chalk.yellow(variant)} → ${chalk.cyan(group.canonical)} (${result.symbolsUpdated} symbols)`
                )
              );
            }
            totalMerged += result.symbolsUpdated;
          }
        }
        this.log('');
        this.log(chalk.green.bold(`Consolidated ${totalMerged} symbol domain assignments.`));
      } else {
        this.log(chalk.gray('Run with --fix to execute these merges.'));
      }
    });
  }
}
