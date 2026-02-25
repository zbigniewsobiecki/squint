import type { IndexDatabase, ReadySymbolInfo } from '../../db/database.js';
import type {
  DependencyContextEnhanced,
  IncomingDependencyContext,
  RelationshipToAnnotate,
} from '../llm/_shared/prompts.js';
import { readSourceAsString } from './source-reader.js';

/**
 * Enhanced symbol with source code, dependencies, and relationships.
 */
export interface EnhancedSymbol extends ReadySymbolInfo {
  sourceCode: string;
  isExported: boolean;
  dependencies: DependencyContextEnhanced[];
  relationshipsToAnnotate: RelationshipToAnnotate[];
  incomingDependencies: IncomingDependencyContext[];
  incomingDependencyCount: number;
}

/**
 * Enhance symbols with source code, dependency context, and relationships to annotate.
 */
export async function enhanceSymbols(
  db: IndexDatabase,
  symbols: ReadySymbolInfo[],
  aspects: string[],
  relationshipLimit: number
): Promise<EnhancedSymbol[]> {
  const enhanced: EnhancedSymbol[] = [];

  for (const symbol of symbols) {
    const sourceCode = await readSourceAsString(db.resolveFilePath(symbol.filePath), symbol.line, symbol.endLine);

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
