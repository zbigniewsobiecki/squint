import { Flags } from '@oclif/core';
import chalk from 'chalk';
import type { IndexDatabase, ReadySymbolInfo } from '../../db/database.js';
import { LlmFlags, SharedFlags, readSourceAsString } from '../_shared/index.js';
import { BaseLlmCommand, type LlmContext } from '../llm/_shared/base-llm-command.js';
import { filterCoverageForAspects } from '../llm/_shared/coverage.js';
import { parseCombinedCsv } from '../llm/_shared/csv.js';
import { completeWithLogging } from '../llm/_shared/llm-utils.js';
import {
  type DependencyContextEnhanced,
  type IncomingDependencyContext,
  type RelationshipToAnnotate,
  type SymbolContextEnhanced,
  buildSystemPrompt,
  buildUserPromptEnhanced,
} from '../llm/_shared/prompts.js';
import { verifyAnnotationContent } from '../llm/_shared/verify/content-verifier.js';
import { checkAnnotationCoverage } from '../llm/_shared/verify/coverage-checker.js';
import type { VerifyReport } from '../llm/_shared/verify/verify-types.js';

interface EnhancedSymbol extends ReadySymbolInfo {
  sourceCode: string;
  isExported: boolean;
  dependencies: DependencyContextEnhanced[];
  relationshipsToAnnotate: RelationshipToAnnotate[];
  incomingDependencies: IncomingDependencyContext[];
  incomingDependencyCount: number;
}

export default class Verify extends BaseLlmCommand {
  static override description = 'Verify existing symbol annotations';

  static override examples = [
    '<%= config.bin %> symbols verify --aspect purpose',
    '<%= config.bin %> symbols verify --aspect purpose --aspect domain',
    '<%= config.bin %> symbols verify --aspect purpose --fix',
    '<%= config.bin %> symbols verify --aspect purpose --batch-size 10',
  ];

  static override flags = {
    database: SharedFlags.database,
    json: SharedFlags.json,
    ...LlmFlags,
    aspect: Flags.string({
      char: 'a',
      description: 'Metadata key to verify (can be repeated)',
      required: true,
      multiple: true,
    }),
    fix: Flags.boolean({
      description: 'Auto-fix structural issues found during verification',
      default: false,
    }),
    'batch-size': Flags.integer({
      char: 'b',
      description: 'Number of symbols per LLM call',
      default: 10,
    }),
    'max-iterations': Flags.integer({
      description: 'Maximum iterations (0 = unlimited)',
      default: 0,
    }),
  };

  protected async execute(ctx: LlmContext, flags: Record<string, unknown>): Promise<void> {
    const { db, isJson, dryRun } = ctx;
    const aspects = flags.aspect as string[];
    const batchSize = (flags['batch-size'] as number) || 10;
    const maxIterations = (flags['max-iterations'] as number) || 0;
    const shouldFix = flags.fix as boolean;

    if (!isJson) {
      this.log(chalk.bold('Annotation Verification'));
      this.log(chalk.gray(`Aspects: ${aspects.join(', ')}`));
      this.log('');
    }

    // Phase 1: Coverage check
    if (!isJson) {
      this.log(chalk.bold('Phase 1: Coverage Check'));
    }

    const phase1 = checkAnnotationCoverage(db, aspects);
    const report: VerifyReport = { phase1 };

    if (!isJson) {
      this.log(`  Definitions: ${phase1.stats.annotatedDefinitions}/${phase1.stats.totalDefinitions} annotated`);
      if (phase1.stats.missingCount > 0) {
        this.log(chalk.red(`  Missing: ${phase1.stats.missingCount} annotations`));
      }

      const errorIssues = phase1.issues.filter((i) => i.severity === 'error');
      if (errorIssues.length > 0) {
        this.log('');
        for (const issue of errorIssues.slice(0, 20)) {
          this.log(
            `  ${chalk.red('ERR')} ${issue.definitionName || '?'} (${issue.filePath}:${issue.line}): ${issue.message}`
          );
        }
        if (errorIssues.length > 20) {
          this.log(chalk.gray(`  ... and ${errorIssues.length - 20} more`));
        }
      }

      const warningIssues = phase1.issues.filter((i) => i.severity === 'warning');
      if (warningIssues.length > 0) {
        this.log('');
        this.log(chalk.yellow(`  Warnings (${warningIssues.length}):`));
        for (const issue of warningIssues.slice(0, 20)) {
          this.log(`    ${chalk.yellow('WARN')} [${issue.category}] ${issue.message}`);
        }
        if (warningIssues.length > 20) {
          this.log(chalk.gray(`    ... and ${warningIssues.length - 20} more`));
        }
      }

      if (phase1.passed) {
        this.log(chalk.green('  ✓ All definitions have all aspects annotated'));
      } else {
        this.log(chalk.red('  ✗ Coverage check failed'));
      }
      this.log('');
    }

    // Auto-fix: correct suspect-pure annotations if --fix
    if (shouldFix && !dryRun) {
      const suspectPureIssues = phase1.issues.filter((i) => i.fixData?.action === 'set-pure-false');
      if (suspectPureIssues.length > 0) {
        let fixed = 0;
        for (const issue of suspectPureIssues) {
          if (issue.definitionId) {
            db.metadata.set(issue.definitionId, 'pure', 'false');
            fixed++;
          }
        }
        if (!isJson) {
          this.log(chalk.green(`  Fixed: corrected ${fixed} pure annotations to "false"`));
          this.log('');
        }
      }

      // Auto-fix: harmonize inconsistent domain tags (deterministic — pick most common)
      const domainIssues = phase1.issues.filter((i) => i.fixData?.action === 'harmonize-domain');
      if (domainIssues.length > 0) {
        // Group by (name, kind) to find the most common domain variant
        const defIds = domainIssues.map((i) => i.definitionId).filter((id): id is number => id !== undefined);
        const groups = new Map<string, Array<{ id: number; domain: string }>>();
        for (const defId of defIds) {
          const def = db.definitions.getById(defId);
          if (!def) continue;
          const domain = db.metadata.getValue(defId, 'domain');
          if (!domain) continue;
          const key = `${def.name}::${def.kind}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push({ id: defId, domain });
        }

        let harmonized = 0;
        for (const [, defs] of groups) {
          // Find the most common domain variant
          const counts = new Map<string, number>();
          for (const { domain } of defs) {
            try {
              const parsed = JSON.parse(domain) as string[];
              const normalized = JSON.stringify([...parsed].sort());
              counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
            } catch {
              // Skip
            }
          }
          let bestDomain = '';
          let bestCount = 0;
          for (const [domain, count] of counts) {
            if (count > bestCount) {
              bestCount = count;
              bestDomain = domain;
            }
          }
          if (!bestDomain) continue;

          // Apply the most common domain to all definitions in the group
          for (const { id, domain } of defs) {
            try {
              const normalized = JSON.stringify([...(JSON.parse(domain) as string[])].sort());
              if (normalized !== bestDomain) {
                db.metadata.set(id, 'domain', bestDomain);
                harmonized++;
              }
            } catch {
              // Skip
            }
          }
        }

        if (harmonized > 0 && !isJson) {
          this.log(chalk.green(`  Fixed: harmonized ${harmonized} inconsistent domain annotations`));
          this.log('');
        }
      }
    }

    // If dry-run or Phase 1 failed, stop here
    if (dryRun || !phase1.passed) {
      if (isJson) {
        this.log(JSON.stringify(report, null, 2));
      } else if (dryRun) {
        this.log(chalk.yellow('Dry run — skipping Phase 2 (LLM content verification)'));
      }
      return;
    }

    // Phase 2: LLM content verification
    if (!isJson) {
      this.log(chalk.bold('Phase 2: Content Verification (LLM)'));
    }

    const phase2 = await verifyAnnotationContent(
      db,
      ctx,
      this,
      {
        'batch-size': batchSize,
        'max-iterations': maxIterations,
      },
      aspects
    );
    report.phase2 = phase2;

    if (!isJson) {
      this.log(`  Checked: ${phase2.stats.checked} definitions in ${phase2.stats.batchesProcessed} batches`);

      if (phase2.issues.length === 0) {
        this.log(chalk.green('  ✓ All annotations passed content verification'));
      } else {
        this.log(chalk.yellow(`  Found ${phase2.issues.length} issues:`));
        for (const issue of phase2.issues) {
          const severity = issue.severity === 'error' ? chalk.red('ERR') : chalk.yellow('WARN');
          this.log(`  ${severity} ${issue.definitionName || '?'}: ${issue.message}`);
        }
      }
    }

    // LLM-based fix: reannotate definitions flagged as wrong
    if (shouldFix && !dryRun && ctx.model && phase2) {
      const reannotateIssues = phase2.issues.filter((i) => i.fixData?.action === 'reannotate-definition');
      if (reannotateIssues.length > 0) {
        if (!isJson) {
          this.log('');
          this.log(chalk.bold(`Fixing ${reannotateIssues.length} wrong annotations via LLM...`));
        }

        // Collect definition IDs to re-annotate
        const defIdsToFix = reannotateIssues.map((i) => i.definitionId).filter((id): id is number => id !== undefined);
        const uniqueDefIds = [...new Set(defIdsToFix)];

        // Build symbols for re-annotation (set() will overwrite existing values)
        const symbolsToFix = uniqueDefIds
          .map((id) => db.definitions.getById(id))
          .filter((d): d is NonNullable<typeof d> => d !== null)
          .map((d) => ({
            id: d.id,
            name: d.name,
            kind: d.kind,
            filePath: d.filePath,
            line: d.line,
            endLine: d.endLine,
            dependencyCount: 0,
          }));

        if (symbolsToFix.length > 0) {
          const enhancedSymbols = await this.enhanceSymbols(db, symbolsToFix, aspects, 50);
          const systemPrompt = buildSystemPrompt(aspects);

          const symbolContexts: SymbolContextEnhanced[] = enhancedSymbols.map((s) => ({
            id: s.id,
            name: s.name,
            kind: s.kind,
            filePath: s.filePath,
            line: s.line,
            endLine: s.endLine,
            sourceCode: s.sourceCode,
            isExported: s.isExported,
            dependencies: s.dependencies,
            relationshipsToAnnotate: [],
            incomingDependencies: s.incomingDependencies,
            incomingDependencyCount: s.incomingDependencyCount,
          }));

          const allCoverage = db.metadata.getAspectCoverage({});
          const totalSymbols = db.metadata.getFilteredCount({});
          const coverage = filterCoverageForAspects(allCoverage, aspects, totalSymbols);

          const userPrompt = buildUserPromptEnhanced(symbolContexts, aspects, coverage);

          try {
            const response = await completeWithLogging({
              model: ctx.model,
              systemPrompt,
              userPrompt,
              temperature: 0,
              command: this,
              isJson: ctx.isJson,
            });

            const parseResult = parseCombinedCsv(response);
            const validIds = new Set(uniqueDefIds);
            let fixedCount = 0;

            for (const row of parseResult.symbols) {
              if (!validIds.has(row.symbolId)) continue;
              if (!aspects.includes(row.aspect)) continue;
              if (!row.value || row.value.length < 2) continue;

              db.metadata.set(row.symbolId, row.aspect, row.value);
              fixedCount++;
            }

            if (fixedCount > 0 && !isJson) {
              this.log(chalk.green(`  Fixed: re-annotated ${fixedCount} definition aspects via LLM`));
            }
          } catch {
            // LLM error
          }
        }
      }
    }

    if (isJson) {
      this.log(JSON.stringify(report, null, 2));
    }
  }

  /**
   * Enhance symbols with source code, dependency context, and relationships to annotate.
   */
  private async enhanceSymbols(
    db: IndexDatabase,
    symbols: ReadySymbolInfo[],
    aspects: string[],
    relationshipLimit: number
  ): Promise<EnhancedSymbol[]> {
    const enhanced: EnhancedSymbol[] = [];

    for (const symbol of symbols) {
      const sourceCode = await readSourceAsString(symbol.filePath, symbol.line, symbol.endLine);

      // Get dependencies with all their metadata
      const deps = db.dependencies.getWithMetadata(symbol.id, aspects[0]);
      const dependencies: DependencyContextEnhanced[] = deps.map((dep) => {
        // Get all metadata for this dependency
        const metadata = db.metadata.get(dep.id);

        let domains: string[] | null = null;
        try {
          if (metadata.domain) {
            domains = JSON.parse(metadata.domain) as string[];
          }
        } catch {
          /* ignore */
        }

        return {
          id: dep.id,
          name: dep.name,
          kind: dep.kind,
          filePath: dep.filePath,
          line: dep.line,
          purpose: metadata.purpose || null,
          domains,
          role: metadata.role || null,
          pure: metadata.pure ? metadata.pure === 'true' : null,
        };
      });

      // Get unannotated relationships from this symbol (handle missing table)
      let unannotatedRels: ReturnType<typeof db.relationships.getUnannotated> = [];
      try {
        const limit = relationshipLimit > 0 ? relationshipLimit : undefined;
        unannotatedRels = db.relationships.getUnannotated({ fromDefinitionId: symbol.id, limit });
      } catch {
        // Table doesn't exist - continue with empty relationships
      }
      // These are usage-based relationships (calls), so they're all 'uses' type
      const relationshipsToAnnotate: RelationshipToAnnotate[] = unannotatedRels.map((rel) => ({
        toId: rel.toDefinitionId,
        toName: rel.toName,
        toKind: rel.toKind,
        usageLine: rel.fromLine, // Use fromLine as approximate usage location
        relationshipType: 'uses' as const,
      }));

      // Get incoming dependencies (who uses this symbol)
      const incomingDeps = db.dependencies.getIncoming(symbol.id, 5);
      const incomingDependencyCount = db.dependencies.getIncomingCount(symbol.id);
      const incomingDependencies: IncomingDependencyContext[] = incomingDeps.map((inc) => ({
        id: inc.id,
        name: inc.name,
        kind: inc.kind,
        filePath: inc.filePath,
      }));

      // Get the definition to check if it's exported
      const defInfo = db.definitions.getById(symbol.id);
      const isExported = defInfo?.isExported ?? false;

      enhanced.push({
        ...symbol,
        sourceCode,
        isExported,
        dependencies,
        relationshipsToAnnotate,
        incomingDependencies,
        incomingDependencyCount,
      });
    }

    return enhanced;
  }
}
