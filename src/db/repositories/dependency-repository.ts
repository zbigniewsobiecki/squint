import type Database from 'better-sqlite3';
import type {
  CallsiteResult,
  DependencyInfo,
  DependencyWithMetadata,
  IncomingDependency,
  ReadySymbolInfo,
} from '../schema.js';

export interface ImportGraphNode {
  id: number;
  name: string;
  kind: string;
}

export interface ImportGraphLink {
  source: number;
  target: number;
  type: string;
}

export class DependencyRepository {
  constructor(private db: Database.Database) {}

  getCallsites(definitionId: number): CallsiteResult[] {
    // Query for both imported and internal call sites using UNION
    const stmt = this.db.prepare(`
      SELECT
        u.id as usage_id,
        u.symbol_id,
        s.definition_id,
        f.path as file_path,
        u.line,
        u.column,
        s.name as symbol_name,
        s.local_name,
        u.argument_count,
        u.is_method_call,
        u.is_constructor_call,
        u.receiver_name
      FROM usages u
      JOIN symbols s ON u.symbol_id = s.id
      JOIN imports i ON s.reference_id = i.id
      JOIN files f ON i.from_file_id = f.id
      WHERE s.definition_id = ?
        AND (u.context = 'call_expression' OR u.context = 'new_expression')
        AND u.argument_count IS NOT NULL
      UNION ALL
      SELECT
        u.id as usage_id,
        u.symbol_id,
        s.definition_id,
        f.path as file_path,
        u.line,
        u.column,
        s.name as symbol_name,
        s.local_name,
        u.argument_count,
        u.is_method_call,
        u.is_constructor_call,
        u.receiver_name
      FROM usages u
      JOIN symbols s ON u.symbol_id = s.id
      JOIN files f ON s.file_id = f.id
      WHERE s.definition_id = ?
        AND s.reference_id IS NULL
        AND (u.context = 'call_expression' OR u.context = 'new_expression')
        AND u.argument_count IS NOT NULL
      ORDER BY file_path, line
    `);
    const rows = stmt.all(definitionId, definitionId) as Array<{
      usage_id: number;
      symbol_id: number;
      definition_id: number | null;
      file_path: string;
      line: number;
      column: number;
      symbol_name: string;
      local_name: string;
      argument_count: number;
      is_method_call: number;
      is_constructor_call: number;
      receiver_name: string | null;
    }>;

    return rows.map((row) => ({
      usageId: row.usage_id,
      symbolId: row.symbol_id,
      definitionId: row.definition_id,
      filePath: row.file_path,
      line: row.line,
      column: row.column,
      symbolName: row.symbol_name,
      localName: row.local_name,
      argumentCount: row.argument_count,
      isMethodCall: row.is_method_call === 1,
      isConstructorCall: row.is_constructor_call === 1,
      receiverName: row.receiver_name,
    }));
  }

  getCallsitesForFile(fileId: number): CallsiteResult[] {
    const stmt = this.db.prepare(`
      SELECT
        u.id as usage_id,
        u.symbol_id,
        s.definition_id,
        f.path as file_path,
        u.line,
        u.column,
        s.name as symbol_name,
        s.local_name,
        u.argument_count,
        u.is_method_call,
        u.is_constructor_call,
        u.receiver_name
      FROM usages u
      JOIN symbols s ON u.symbol_id = s.id
      JOIN imports i ON s.reference_id = i.id
      JOIN files f ON i.from_file_id = f.id
      WHERE i.from_file_id = ?
        AND (u.context = 'call_expression' OR u.context = 'new_expression')
        AND u.argument_count IS NOT NULL
    `);
    const rows = stmt.all(fileId) as Array<{
      usage_id: number;
      symbol_id: number;
      definition_id: number | null;
      file_path: string;
      line: number;
      column: number;
      symbol_name: string;
      local_name: string;
      argument_count: number;
      is_method_call: number;
      is_constructor_call: number;
      receiver_name: string | null;
    }>;

    return rows.map((row) => ({
      usageId: row.usage_id,
      symbolId: row.symbol_id,
      definitionId: row.definition_id,
      filePath: row.file_path,
      line: row.line,
      column: row.column,
      symbolName: row.symbol_name,
      localName: row.local_name,
      argumentCount: row.argument_count,
      isMethodCall: row.is_method_call === 1,
      isConstructorCall: row.is_constructor_call === 1,
      receiverName: row.receiver_name,
    }));
  }

  getCallsiteCount(): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM usages
      WHERE (context = 'call_expression' OR context = 'new_expression')
        AND argument_count IS NOT NULL
    `);
    const row = stmt.get() as { count: number };
    return row.count;
  }

  /**
   * Get incoming dependencies - symbols that use this definition.
   * This finds all definitions that have usages pointing to this definition.
   */
  getIncoming(definitionId: number, limit = 5): IncomingDependency[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT
        caller.id,
        caller.name,
        caller.kind,
        f.path as filePath,
        caller.line
      FROM definitions caller
      JOIN files f ON caller.file_id = f.id
      JOIN usages u ON u.line >= caller.line AND u.line <= caller.end_line
      JOIN symbols s ON u.symbol_id = s.id
      WHERE s.definition_id = ?
        AND caller.id != ?
        AND (
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = caller.file_id)
          OR s.file_id = caller.file_id
        )
      ORDER BY f.path, caller.line
      LIMIT ?
    `);
    return stmt.all(definitionId, definitionId, limit) as IncomingDependency[];
  }

  /**
   * Get count of incoming dependencies - how many symbols use this definition.
   */
  getIncomingCount(definitionId: number): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(DISTINCT caller.id) as count
      FROM definitions caller
      JOIN usages u ON u.line >= caller.line AND u.line <= caller.end_line
      JOIN symbols s ON u.symbol_id = s.id
      WHERE s.definition_id = ?
        AND caller.id != ?
        AND (
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = caller.file_id)
          OR s.file_id = caller.file_id
        )
    `);
    const row = stmt.get(definitionId, definitionId) as { count: number };
    return row.count;
  }

  /**
   * Get all symbols that a definition depends on (uses within its line range).
   * This finds usages within the definition's code that reference other definitions.
   */
  getForDefinition(definitionId: number): DependencyInfo[] {
    const stmt = this.db.prepare(`
      SELECT DISTINCT
        dep_def.id as dependencyId,
        dep_def.name,
        dep_def.kind,
        dep_f.path as filePath,
        dep_def.line
      FROM definitions source
      JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
      JOIN symbols s ON u.symbol_id = s.id
      JOIN definitions dep_def ON s.definition_id = dep_def.id
      JOIN files dep_f ON dep_def.file_id = dep_f.id
      JOIN files source_f ON source.file_id = source_f.id
      WHERE source.id = ?
        AND dep_def.id != source.id
        AND (
          -- Symbol is from an import in the same file
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
          -- Or symbol is internal to the same file
          OR s.file_id = source.file_id
        )
      ORDER BY dep_f.path, dep_def.line
    `);
    return stmt.all(definitionId) as DependencyInfo[];
  }

  /**
   * Get dependencies with their metadata status for a specific aspect.
   * Combines dependency lookup with metadata check in a single efficient query.
   */
  getWithMetadata(definitionId: number, aspect?: string): DependencyWithMetadata[] {
    const sql = `
      SELECT DISTINCT
        dep_def.id,
        dep_def.name,
        dep_def.kind,
        dep_f.path as filePath,
        dep_def.line,
        CASE WHEN dm.value IS NOT NULL THEN 1 ELSE 0 END as hasAspect,
        dm.value as aspectValue
      FROM definitions source
      JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
      JOIN symbols s ON u.symbol_id = s.id
      JOIN definitions dep_def ON s.definition_id = dep_def.id
      JOIN files dep_f ON dep_def.file_id = dep_f.id
      LEFT JOIN definition_metadata dm ON dm.definition_id = dep_def.id AND dm.key = ?
      WHERE source.id = ?
        AND dep_def.id != source.id
        AND (
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
          OR s.file_id = source.file_id
        )
      ORDER BY dep_f.path, dep_def.line
    `;
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(aspect ?? '', definitionId) as Array<{
      id: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
      hasAspect: number;
      aspectValue: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      filePath: row.filePath,
      line: row.line,
      hasAspect: row.hasAspect === 1,
      aspectValue: row.aspectValue,
    }));
  }

  /**
   * Get dependencies that don't have a specific aspect set.
   * Orders by dependency count (leaf nodes first) for topological processing.
   */
  getUnmet(definitionId: number, aspect: string): DependencyInfo[] {
    const sql = `
      WITH has_aspect AS (
        SELECT definition_id FROM definition_metadata WHERE key = ?
      )
      SELECT DISTINCT
        dep_def.id as dependencyId,
        dep_def.name,
        dep_def.kind,
        dep_f.path as filePath,
        dep_def.line
      FROM definitions source
      JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
      JOIN symbols s ON u.symbol_id = s.id
      JOIN definitions dep_def ON s.definition_id = dep_def.id
      JOIN files dep_f ON dep_def.file_id = dep_f.id
      WHERE source.id = ?
        AND dep_def.id != source.id
        AND dep_def.id NOT IN (SELECT definition_id FROM has_aspect)
        AND (
          s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
          OR s.file_id = source.file_id
        )
      ORDER BY dep_f.path, dep_def.line
    `;
    const stmt = this.db.prepare(sql);
    return stmt.all(aspect, definitionId) as DependencyInfo[];
  }

  /**
   * Get the full prerequisite chain for understanding a symbol.
   * Returns unmet dependencies in topological order (leaves first).
   * Handles circular dependencies by tracking visited nodes.
   */
  getPrerequisiteChain(
    definitionId: number,
    aspect: string,
    getDefinitionById: (id: number) => { name: string; kind: string; filePath: string; line: number } | null
  ): Array<DependencyInfo & { unmetDepCount: number }> {
    const visited = new Set<number>();
    const result: Array<DependencyInfo & { unmetDepCount: number }> = [];

    const processNode = (id: number): void => {
      if (visited.has(id)) return;
      visited.add(id);

      const unmetDeps = this.getUnmet(id, aspect);

      // Process children first (depth-first)
      for (const dep of unmetDeps) {
        if (!visited.has(dep.dependencyId)) {
          processNode(dep.dependencyId);
        }
      }

      // Add this node after its dependencies (unless it's the root)
      if (id !== definitionId) {
        const nodeUnmetDeps = this.getUnmet(id, aspect);
        const def = getDefinitionById(id);
        if (def) {
          result.push({
            dependencyId: id,
            name: def.name,
            kind: def.kind,
            filePath: def.filePath,
            line: def.line,
            unmetDepCount: nodeUnmetDeps.length,
          });
        }
      }
    };

    // Start from the target definition
    const directUnmet = this.getUnmet(definitionId, aspect);
    for (const dep of directUnmet) {
      processNode(dep.dependencyId);
    }

    // Sort by unmet dependency count (leaves first)
    result.sort((a, b) => a.unmetDepCount - b.unmetDepCount);

    return result;
  }

  /**
   * Find symbols that are "ready to understand" for a given aspect.
   * A symbol is ready when all its dependencies already have the aspect set (or it has no dependencies).
   * Excludes symbols that already have the aspect set.
   */
  getReadySymbols(
    aspect: string,
    options?: { limit?: number; kind?: string; filePattern?: string }
  ): { symbols: ReadySymbolInfo[]; totalReady: number; remaining: number } {
    const limit = options?.limit ?? 20;

    // Build filter conditions and collect filter params
    let filterConditions = '';
    const filterParams: (string | number)[] = [];

    if (options?.kind) {
      filterConditions += ' AND d.kind = ?';
      filterParams.push(options.kind);
    }
    if (options?.filePattern) {
      filterConditions += ' AND f.path LIKE ?';
      filterParams.push(`%${options.filePattern}%`);
    }

    // The main query uses CTEs:
    // 1. understood: definitions that already have the aspect set
    // 2. definition_deps: maps each definition to its dependencies
    // 3. unmet: definitions that have at least one dependency without the aspect
    const sql = `
      WITH understood AS (
        SELECT definition_id FROM definition_metadata WHERE key = ?
      ),
      definition_deps AS (
        SELECT DISTINCT
          source.id as definition_id,
          dep_def.id as dependency_id
        FROM definitions source
        JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
        JOIN symbols s ON u.symbol_id = s.id
        JOIN definitions dep_def ON s.definition_id = dep_def.id
        JOIN files source_f ON source.file_id = source_f.id
        WHERE dep_def.id != source.id
          AND (
            s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
            OR s.file_id = source.file_id
          )
      ),
      unmet AS (
        SELECT DISTINCT definition_id
        FROM definition_deps
        WHERE dependency_id NOT IN (SELECT definition_id FROM understood)
      )
      SELECT
        d.id,
        d.name,
        d.kind,
        f.path as filePath,
        d.line,
        d.end_line as endLine,
        COALESCE(dep_count.cnt, 0) as dependencyCount
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      LEFT JOIN (
        SELECT definition_id, COUNT(*) as cnt
        FROM definition_deps
        GROUP BY definition_id
      ) dep_count ON dep_count.definition_id = d.id
      WHERE d.id NOT IN (SELECT definition_id FROM understood)
        AND d.id NOT IN (SELECT definition_id FROM unmet)
        ${filterConditions}
      ORDER BY dependencyCount ASC, f.path, d.line
      LIMIT ?
    `;

    const params: (string | number)[] = [aspect, ...filterParams, limit];
    const stmt = this.db.prepare(sql);
    const symbols = stmt.all(...params) as ReadySymbolInfo[];

    // Get counts for the summary
    const countSql = `
      WITH understood AS (
        SELECT definition_id FROM definition_metadata WHERE key = ?
      ),
      definition_deps AS (
        SELECT DISTINCT
          source.id as definition_id,
          dep_def.id as dependency_id
        FROM definitions source
        JOIN usages u ON u.line >= source.line AND u.line <= source.end_line
        JOIN symbols s ON u.symbol_id = s.id
        JOIN definitions dep_def ON s.definition_id = dep_def.id
        JOIN files source_f ON source.file_id = source_f.id
        WHERE dep_def.id != source.id
          AND (
            s.reference_id IN (SELECT id FROM imports WHERE from_file_id = source.file_id)
            OR s.file_id = source.file_id
          )
      ),
      unmet AS (
        SELECT DISTINCT definition_id
        FROM definition_deps
        WHERE dependency_id NOT IN (SELECT definition_id FROM understood)
      )
      SELECT
        COUNT(*) as totalReady,
        (SELECT COUNT(*) FROM definitions d2
         JOIN files f2 ON d2.file_id = f2.id
         WHERE d2.id NOT IN (SELECT definition_id FROM understood)
           ${filterConditions.replace(/d\./g, 'd2.').replace(/f\./g, 'f2.')}
        ) as totalRemaining
      FROM definitions d
      JOIN files f ON d.file_id = f.id
      WHERE d.id NOT IN (SELECT definition_id FROM understood)
        AND d.id NOT IN (SELECT definition_id FROM unmet)
        ${filterConditions}
    `;

    // Params: aspect, then filterParams for subquery, then filterParams for main WHERE
    const countParams: (string | number)[] = [aspect, ...filterParams, ...filterParams];
    const countStmt = this.db.prepare(countSql);
    const countResult = countStmt.get(...countParams) as { totalReady: number; totalRemaining: number };

    return {
      symbols,
      totalReady: countResult.totalReady,
      remaining: countResult.totalRemaining - countResult.totalReady,
    };
  }

  /**
   * Detect orphan module-scope usages: imported symbols used in a file at lines
   * outside any definition's line range. These are module-scope statements
   * (e.g., app.use('/auth', authRouter)) that the line-range join cannot capture.
   * Returns one row per (file, referenced definition) pair.
   */
  getOrphanModuleScopeUsages(): Array<{
    filePath: string;
    symbolName: string;
    usageLine: number;
    referencedDefId: number;
    referencedDefName: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT DISTINCT
        f.path as filePath,
        s.name as symbolName,
        u.line as usageLine,
        dep_def.id as referencedDefId,
        dep_def.name as referencedDefName
      FROM usages u
      JOIN symbols s ON u.symbol_id = s.id
      JOIN definitions dep_def ON s.definition_id = dep_def.id
      JOIN imports i ON s.reference_id = i.id
      JOIN files f ON i.from_file_id = f.id
      WHERE NOT EXISTS (
        SELECT 1 FROM definitions d
        WHERE d.file_id = f.id
          AND d.line <= u.line AND u.line <= d.end_line
      )
      ORDER BY f.path, u.line
    `);
    return stmt.all() as Array<{
      filePath: string;
      symbolName: string;
      usageLine: number;
      referencedDefId: number;
      referencedDefName: string;
    }>;
  }

  /**
   * Get import dependency graph data for D3 visualization
   */
  getImportGraph(): {
    nodes: ImportGraphNode[];
    links: ImportGraphLink[];
  } {
    // Get all files as nodes
    const nodesStmt = this.db.prepare(`
      SELECT id, path as name, 'file' as kind
      FROM files
    `);
    const nodes = nodesStmt.all() as ImportGraphNode[];

    // Get all internal imports as links
    const linksStmt = this.db.prepare(`
      SELECT DISTINCT from_file_id as source, to_file_id as target, type
      FROM imports
      WHERE to_file_id IS NOT NULL
    `);
    const links = linksStmt.all() as ImportGraphLink[];

    return { nodes, links };
  }
}
