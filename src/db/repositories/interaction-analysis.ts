import type Database from 'better-sqlite3';
import { ensureInteractionsTables, ensureModulesTables } from '../schema-manager.js';
import type { RelationshipCoverageBreakdown, RelationshipInteractionCoverage } from '../schema.js';
import type { InteractionRepository } from './interaction-repository.js';

/**
 * Service for interaction analysis — relationship coverage, validation, and diagnostics.
 * Extracted from InteractionRepository to separate analysis from CRUD.
 */
export class InteractionAnalysis {
  constructor(private db: Database.Database) {}

  /**
   * Get relationship-to-interaction coverage statistics.
   */
  getRelationshipCoverage(): RelationshipInteractionCoverage {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);

    const totalStmt = this.db.prepare('SELECT COUNT(*) as count FROM relationship_annotations');
    const totalRelationships = (totalStmt.get() as { count: number }).count;

    const crossModuleStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM relationship_annotations ra
      JOIN module_members mm1 ON ra.from_definition_id = mm1.definition_id
      JOIN module_members mm2 ON ra.to_definition_id = mm2.definition_id
      WHERE mm1.module_id != mm2.module_id
    `);
    const crossModuleRelationships = (crossModuleStmt.get() as { count: number }).count;

    const sameModuleStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM relationship_annotations ra
      JOIN module_members mm1 ON ra.from_definition_id = mm1.definition_id
      JOIN module_members mm2 ON ra.to_definition_id = mm2.definition_id
      WHERE mm1.module_id = mm2.module_id
    `);
    const sameModuleCount = (sameModuleStmt.get() as { count: number }).count;

    const withModulesStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM relationship_annotations ra
      JOIN module_members mm1 ON ra.from_definition_id = mm1.definition_id
      JOIN module_members mm2 ON ra.to_definition_id = mm2.definition_id
    `);
    const relationshipsWithModules = (withModulesStmt.get() as { count: number }).count;

    const contributingStmt = this.db.prepare(`
      SELECT COUNT(DISTINCT ra.id) as count
      FROM relationship_annotations ra
      JOIN module_members mm1 ON ra.from_definition_id = mm1.definition_id
      JOIN module_members mm2 ON ra.to_definition_id = mm2.definition_id
      JOIN interactions i ON i.from_module_id = mm1.module_id
                         AND i.to_module_id = mm2.module_id
      WHERE mm1.module_id != mm2.module_id
    `);
    const contributing = (contributingStmt.get() as { count: number }).count;

    return {
      totalRelationships,
      crossModuleRelationships,
      relationshipsContributingToInteractions: contributing,
      sameModuleCount,
      orphanedCount: totalRelationships - relationshipsWithModules,
      coveragePercent: crossModuleRelationships > 0 ? (contributing / crossModuleRelationships) * 100 : 100,
    };
  }

  /**
   * Get detailed breakdown of relationship coverage for diagnostics.
   */
  getRelationshipCoverageBreakdown(): RelationshipCoverageBreakdown {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT
        ra.relationship_type,
        CASE
          WHEN mm1.module_id IS NULL OR mm2.module_id IS NULL THEN 'orphaned'
          WHEN mm1.module_id = mm2.module_id THEN 'same_module'
          WHEN EXISTS (
            SELECT 1 FROM interactions i
            WHERE i.from_module_id = mm1.module_id
              AND i.to_module_id = mm2.module_id
          ) THEN 'covered'
          ELSE 'no_call_edge'
        END as reason,
        COUNT(*) as count
      FROM relationship_annotations ra
      LEFT JOIN module_members mm1 ON ra.from_definition_id = mm1.definition_id
      LEFT JOIN module_members mm2 ON ra.to_definition_id = mm2.definition_id
      GROUP BY ra.relationship_type, reason
    `);

    const rows = stmt.all() as Array<{
      relationship_type: string;
      reason: string;
      count: number;
    }>;

    const result: RelationshipCoverageBreakdown = {
      covered: 0,
      sameModule: 0,
      noCallEdge: 0,
      orphaned: 0,
      byType: {
        uses: 0,
        extends: 0,
        implements: 0,
      },
    };

    for (const row of rows) {
      switch (row.reason) {
        case 'covered':
          result.covered += row.count;
          break;
        case 'same_module':
          result.sameModule += row.count;
          break;
        case 'no_call_edge':
          result.noCallEdge += row.count;
          break;
        case 'orphaned':
          result.orphaned += row.count;
          break;
      }

      if (row.reason !== 'orphaned') {
        switch (row.relationship_type) {
          case 'uses':
            result.byType.uses += row.count;
            break;
          case 'extends':
            result.byType.extends += row.count;
            break;
          case 'implements':
            result.byType.implements += row.count;
            break;
        }
      }
    }

    return result;
  }

  /**
   * Get cross-module relationship pairs that have no corresponding interaction.
   */
  getUncoveredModulePairs(): Array<{
    fromModuleId: number;
    toModuleId: number;
    fromPath: string;
    toPath: string;
    relationshipCount: number;
  }> {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT DISTINCT mm1.module_id as fromModuleId, mm2.module_id as toModuleId,
             m1.full_path as fromPath, m2.full_path as toPath,
             COUNT(*) as relationshipCount
      FROM relationship_annotations ra
      JOIN module_members mm1 ON ra.from_definition_id = mm1.definition_id
      JOIN module_members mm2 ON ra.to_definition_id = mm2.definition_id
      JOIN modules m1 ON mm1.module_id = m1.id
      JOIN modules m2 ON mm2.module_id = m2.id
      WHERE mm1.module_id != mm2.module_id
        AND NOT EXISTS (
          SELECT 1 FROM interactions i
          WHERE i.from_module_id = mm1.module_id AND i.to_module_id = mm2.module_id
        )
      GROUP BY mm1.module_id, mm2.module_id
      ORDER BY relationshipCount DESC
    `);

    return stmt.all() as Array<{
      fromModuleId: number;
      toModuleId: number;
      fromPath: string;
      toPath: string;
      relationshipCount: number;
    }>;
  }

  /**
   * Create interaction edges for inheritance relationships (extends/implements).
   */
  syncInheritanceInteractions(): { created: number } {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO interactions (from_module_id, to_module_id, direction, weight, pattern)
      SELECT DISTINCT
        mm1.module_id,
        mm2.module_id,
        'uni',
        1,
        'inheritance'
      FROM relationship_annotations ra
      JOIN module_members mm1 ON ra.from_definition_id = mm1.definition_id
      JOIN module_members mm2 ON ra.to_definition_id = mm2.definition_id
      WHERE ra.relationship_type IN ('extends', 'implements')
        AND mm1.module_id != mm2.module_id
        AND NOT EXISTS (
          SELECT 1 FROM interactions i
          WHERE i.from_module_id = mm1.module_id
            AND i.to_module_id = mm2.module_id
        )
    `);

    const result = stmt.run();
    return { created: result.changes };
  }

  /**
   * Validate all llm-inferred interactions.
   */
  validateInferredInteractions(
    interactionRepo: InteractionRepository,
    isSameProcess?: (fromModuleId: number, toModuleId: number) => boolean
  ): Array<{
    interactionId: number;
    fromModuleId: number;
    toModuleId: number;
    fromPath: string;
    toPath: string;
    issue: string;
  }> {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);

    const inferred = interactionRepo.getBySource('llm-inferred');
    const issues: Array<{
      interactionId: number;
      fromModuleId: number;
      toModuleId: number;
      fromPath: string;
      toPath: string;
      issue: string;
    }> = [];

    for (const interaction of inferred) {
      const reverseInteraction = interactionRepo.getByModules(interaction.toModuleId, interaction.fromModuleId);
      if (reverseInteraction && reverseInteraction.source === 'ast') {
        issues.push({
          interactionId: interaction.id,
          fromModuleId: interaction.fromModuleId,
          toModuleId: interaction.toModuleId,
          fromPath: interaction.fromModulePath,
          toPath: interaction.toModulePath,
          issue: `REVERSED: AST interaction exists in reverse direction (${interaction.toModulePath} → ${interaction.fromModulePath})`,
        });
        continue;
      }

      const sameProcess = isSameProcess ? isSameProcess(interaction.fromModuleId, interaction.toModuleId) : true;

      if (!sameProcess) continue;

      const hasImports = interactionRepo.hasModuleImportPath(interaction.fromModuleId, interaction.toModuleId);
      if (!hasImports) {
        const hasReverseImports = interactionRepo.hasModuleImportPath(interaction.toModuleId, interaction.fromModuleId);
        if (hasReverseImports) {
          issues.push({
            interactionId: interaction.id,
            fromModuleId: interaction.fromModuleId,
            toModuleId: interaction.toModuleId,
            fromPath: interaction.fromModulePath,
            toPath: interaction.toModulePath,
            issue: `DIRECTION_CONFUSED: No forward imports, but reverse imports exist (${interaction.toModulePath} imports from ${interaction.fromModulePath})`,
          });
        } else {
          issues.push({
            interactionId: interaction.id,
            fromModuleId: interaction.fromModuleId,
            toModuleId: interaction.toModuleId,
            fromPath: interaction.fromModulePath,
            toPath: interaction.toModulePath,
            issue: 'NO_IMPORTS: No import path exists in either direction between these modules',
          });
        }
      }
    }

    return issues;
  }

  /**
   * Get detailed relationship annotation rows between two modules' members.
   */
  getRelationshipDetailsForModulePair(
    fromModuleId: number,
    toModuleId: number
  ): Array<{
    fromName: string;
    fromKind: string;
    toName: string;
    toKind: string;
    semantic: string;
    relationshipType: string;
  }> {
    ensureModulesTables(this.db);

    const stmt = this.db.prepare(`
      SELECT
        from_d.name as fromName,
        from_d.kind as fromKind,
        to_d.name as toName,
        to_d.kind as toKind,
        ra.semantic,
        ra.relationship_type as relationshipType
      FROM relationship_annotations ra
      JOIN module_members from_mm ON ra.from_definition_id = from_mm.definition_id
      JOIN module_members to_mm ON ra.to_definition_id = to_mm.definition_id
      JOIN definitions from_d ON ra.from_definition_id = from_d.id
      JOIN definitions to_d ON ra.to_definition_id = to_d.id
      WHERE from_mm.module_id = ? AND to_mm.module_id = ?
      ORDER BY ra.relationship_type, from_d.name
    `);

    return stmt.all(fromModuleId, toModuleId) as Array<{
      fromName: string;
      fromKind: string;
      toName: string;
      toKind: string;
      semantic: string;
      relationshipType: string;
    }>;
  }

  /**
   * Check if an interaction exists in the reverse direction (toModuleId → fromModuleId).
   */
  hasReverseInteraction(fromModuleId: number, toModuleId: number): boolean {
    ensureInteractionsTables(this.db);

    const stmt = this.db.prepare(`
      SELECT EXISTS (
        SELECT 1 FROM interactions
        WHERE from_module_id = ? AND to_module_id = ?
      ) as has_reverse
    `);

    const row = stmt.get(toModuleId, fromModuleId) as { has_reverse: number };
    return row.has_reverse === 1;
  }

  /**
   * Detect fan-in anomalies: modules with unusually high llm-inferred inbound
   * connections but zero AST inbound connections (hallucination pattern).
   *
   * Uses Tukey's far-outlier fence (Q3 + 3*IQR) with an absolute minimum of 8.
   */
  detectFanInAnomalies(): Array<{
    moduleId: number;
    modulePath: string;
    llmFanIn: number;
    astFanIn: number;
  }> {
    ensureInteractionsTables(this.db);
    ensureModulesTables(this.db);

    // Query llm-inferred fan-in per target module
    const llmFanInRows = this.db
      .prepare(`
      SELECT to_module_id as moduleId, COUNT(*) as fanIn
      FROM interactions
      WHERE source = 'llm-inferred'
      GROUP BY to_module_id
    `)
      .all() as Array<{ moduleId: number; fanIn: number }>;

    if (llmFanInRows.length === 0) return [];

    // Query AST fan-in per target module
    const astFanInRows = this.db
      .prepare(`
      SELECT to_module_id as moduleId, COUNT(*) as fanIn
      FROM interactions
      WHERE source IN ('ast', 'ast-import')
      GROUP BY to_module_id
    `)
      .all() as Array<{ moduleId: number; fanIn: number }>;

    const astFanInMap = new Map(astFanInRows.map((r) => [r.moduleId, r.fanIn]));

    // Compute distribution statistics for llm fan-in values
    const fanInValues = llmFanInRows.map((r) => r.fanIn).sort((a, b) => a - b);
    const n = fanInValues.length;
    const q1 = fanInValues[Math.floor(n * 0.25)];
    const q3 = fanInValues[Math.floor(n * 0.75)];
    const iqr = q3 - q1;
    const farFence = q3 + 3 * iqr;

    // Get module paths for reporting
    const modulePathRows = this.db
      .prepare(`
      SELECT id, full_path as fullPath FROM modules
    `)
      .all() as Array<{ id: number; fullPath: string }>;
    const modulePathMap = new Map(modulePathRows.map((r) => [r.id, r.fullPath]));

    const anomalies: Array<{
      moduleId: number;
      modulePath: string;
      llmFanIn: number;
      astFanIn: number;
    }> = [];

    for (const row of llmFanInRows) {
      const astFanIn = astFanInMap.get(row.moduleId) ?? 0;

      if (row.fanIn > farFence && row.fanIn >= 8 && astFanIn === 0) {
        anomalies.push({
          moduleId: row.moduleId,
          modulePath: modulePathMap.get(row.moduleId) ?? `module#${row.moduleId}`,
          llmFanIn: row.fanIn,
          astFanIn,
        });
      }
    }

    return anomalies;
  }

  /**
   * Get symbols from relationship annotations for a module pair.
   */
  getRelationshipSymbolsForPair(fromModuleId: number, toModuleId: number): string[] {
    const details = this.getRelationshipDetailsForModulePair(fromModuleId, toModuleId);
    const symbols = new Set<string>();
    for (const d of details) {
      symbols.add(d.toName);
    }
    return Array.from(symbols);
  }
}
