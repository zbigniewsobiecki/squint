import { Flags } from '@oclif/core';
import chalk from 'chalk';
import { LlmFlags, SharedFlags } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import { extractCsvContent, parseRow, splitCsvLines } from '../llm/_shared/csv-utils.js';
import { completeWithLogging } from '../llm/_shared/llm-utils.js';

interface MergeGroup {
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

const ALLOWED_RELATIONSHIP_TYPES = new Set(['abbreviation', 'plural', 'separator', 'spelling']);

/**
 * Deterministic guard: reject pairs where one name is a prefix of the other
 * followed by a separator (-, _, space). This catches parent/child groupings
 * like `api` vs `api-client` while allowing `auth` vs `authentication` (next
 * char is `e`, not a separator) and `user-management` vs `user management`
 * (normalised forms are equal).
 */
function isPrefixRelationship(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[-_ ]+/g, '-');
  const na = normalize(a);
  const nb = normalize(b);

  // If they normalise to the same string, they're separator variants — not prefix
  if (na === nb) return false;

  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];

  if (!longer.startsWith(shorter)) return false;

  const nextChar = longer[shorter.length];
  return nextChar === '-'; // after normalisation all separators are '-'
}

export default class Consolidate extends BaseLlmCommand {
  static override description = 'Detect and suggest domain merges using LLM synonym grouping';

  static override examples = [
    '<%= config.bin %> domains consolidate',
    '<%= config.bin %> domains consolidate --fix',
    '<%= config.bin %> domains consolidate --min-group-size 3',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    ...LlmFlags,
    fix: Flags.boolean({
      description: 'Execute suggested merges automatically',
      default: false,
    }),
    'min-group-size': Flags.integer({
      description: 'Minimum group size to suggest merge (default: 2)',
      default: 2,
    }),
  };

  protected async execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, model } = ctx;
    const fix = flags.fix as boolean;
    const minGroupSize = (flags['min-group-size'] as number) ?? 2;

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
      // Even with no in-use domains, sync from metadata to register any annotated domains
      const synced = db.domains.syncFromMetadata();
      if (synced.length > 0 && !isJson) {
        this.log(chalk.green(`Registered ${synced.length} domain(s) from metadata.`));
      } else {
        this.log(chalk.gray('No domains in use.'));
      }
      return;
    }

    // Use LLM to group synonymous domains
    const mergeGroups = await this.groupDomainsWithLlm(inUseDomains, model, isJson, minGroupSize);

    if (mergeGroups.length === 0) {
      // Still sync domains from metadata even when no merges are needed
      const synced = db.domains.syncFromMetadata();

      if (isJson) {
        this.log(JSON.stringify({ suggestions: [], merged: 0, synced: synced.length }, null, 2));
      } else {
        this.log(chalk.green('No domain consolidation suggestions found.'));
        if (synced.length > 0) {
          this.log(chalk.green(`Registered ${synced.length} domain(s) from metadata.`));
        }
      }
      return;
    }

    if (isJson) {
      const output = {
        suggestions: mergeGroups.map((g) => ({
          canonical: g.canonical,
          variants: g.variants,
          counts: Object.fromEntries(g.counts),
          reason: g.reason,
        })),
        merged: 0,
      };

      if (fix) {
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

      // Sync domains from metadata into the domains table (JSON path)
      db.domains.syncFromMetadata();

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

    if (fix) {
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

    // Sync all domains from metadata into the domains table
    const synced = db.domains.syncFromMetadata();
    if (synced.length > 0 && !isJson) {
      this.log(chalk.green(`Registered ${synced.length} domain(s) from metadata.`));
    }
  }

  /**
   * Use LLM to identify groups of synonymous domain names.
   */
  private async groupDomainsWithLlm(
    inUseDomains: Map<string, number>,
    model: string,
    isJson: boolean,
    minGroupSize: number
  ): Promise<MergeGroup[]> {
    const systemPrompt = `You identify TRUE SYNONYM pairs among domain labels.

A synonym is ONLY one of these 4 relationship types:
1. abbreviation — one name is a shortened form of the other (auth/authentication, config/configuration, env/environment)
2. plural — singular vs plural of the same word (error/errors, module/modules, test/tests)
3. separator — identical words with different separators (user-management/user_management/user management)
4. spelling — alternate spellings of the same word (color/colour, canceled/cancelled)

CRITICAL RULES:
- If name A is a prefix of name B followed by a separator (-, _, space), they are NOT synonyms.
  WRONG: api + api-client, ui + ui-components, auth + auth-middleware, payment + payment-processing
- Parent/child or broader/narrower concepts are NOT synonyms.
  WRONG: api + api-routes, database + database-migrations, user + user-profile
- Related but distinct concepts are NOT synonyms.
  WRONG: api + api-client, http + fetch, state + store, ui + components
- When in doubt, do NOT group.

Output CSV with header row:
canonical,variant,relationship_type,reason

- canonical: the most descriptive name for the pair
- variant: the other name in the pair
- relationship_type: one of abbreviation, plural, separator, spelling
- reason: brief explanation

One row per synonym pair. Skip domains that have no true synonyms.
Do NOT invent domains — only use exact names from the input list.`;

    const domainLines = [...inUseDomains.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => `${name} (${count} symbols)`)
      .join('\n');

    const userPrompt = `Only output pairs that are TRUE SYNONYMS (abbreviation, plural, separator variant, or spelling variant). Do NOT group parent/child or related-but-distinct concepts.\n\n${domainLines}`;

    if (!isJson) {
      this.log(chalk.gray(`Classifying ${inUseDomains.size} domains with LLM...`));
    }

    const response = await completeWithLogging({
      model,
      systemPrompt,
      userPrompt,
      temperature: 0,
      command: this,
      isJson,
    });

    return this.parseLlmSynonymResponse(response, inUseDomains, minGroupSize);
  }

  /**
   * Parse LLM CSV response into MergeGroup[].
   */
  private parseLlmSynonymResponse(
    response: string,
    inUseDomains: Map<string, number>,
    minGroupSize: number
  ): MergeGroup[] {
    const csv = extractCsvContent(response);
    const lines = splitCsvLines(csv).filter((l) => l.trim() && !l.startsWith('canonical,'));

    // Build canonical → { variants, reasons } map
    const groupMap = new Map<string, { variants: Set<string>; reasons: Map<string, string> }>();

    for (const line of lines) {
      const fields = parseRow(line);
      if (!fields || fields.length < 4) continue;

      const canonical = fields[0].trim();
      const variant = fields[1].trim();
      const relationshipType = fields[2].trim().toLowerCase();
      const reason = fields[3].trim();

      // Validate relationship_type is one of the 4 allowed values
      if (!ALLOWED_RELATIONSHIP_TYPES.has(relationshipType)) continue;

      // Require BOTH canonical and variant to exist in the input domain list
      if (!inUseDomains.has(canonical) || !inUseDomains.has(variant)) continue;

      // Deterministic prefix guard: reject parent/child pairs
      if (isPrefixRelationship(canonical, variant)) continue;

      if (!groupMap.has(canonical)) {
        groupMap.set(canonical, { variants: new Set([canonical]), reasons: new Map() });
      }
      const group = groupMap.get(canonical)!;
      group.variants.add(variant);
      group.reasons.set(variant, reason);
    }

    // Convert to MergeGroup[]
    const mergeGroups: MergeGroup[] = [];
    for (const [llmCanonical, group] of groupMap) {
      const allVariants = [...group.variants].sort();
      if (allVariants.length < minGroupSize) continue;

      const counts = new Map<string, number>();
      for (const v of allVariants) {
        counts.set(v, inUseDomains.get(v) ?? 0);
      }

      // Use LLM's canonical pick, but if it has 0 symbols prefer the most-used variant
      let canonical = llmCanonical;
      if ((counts.get(canonical) ?? 0) === 0) {
        canonical = pickCanonical(allVariants, counts);
      }

      // Build combined reason from per-variant reasons
      const reasons = [...group.reasons.values()].filter(Boolean);
      const reason = reasons.length > 0 ? reasons[0] : 'LLM synonym grouping';

      mergeGroups.push({
        variants: allVariants,
        counts,
        canonical,
        reason,
      });
    }

    return mergeGroups;
  }
}
