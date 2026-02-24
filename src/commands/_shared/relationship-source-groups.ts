import type { IndexDatabase } from '../../db/database.js';
import type { RelationshipSourceGroup, RelationshipTarget } from '../llm/_shared/prompts.js';
import { readSourceAsString } from './source-reader.js';

/**
 * Build RelationshipSourceGroup[] for a batch of source symbol IDs.
 */
export async function buildSourceGroups(
  db: IndexDatabase,
  sourceIds: number[],
  grouped: Map<
    number,
    Array<{
      fromDefinitionId: number;
      fromName: string;
      fromKind: string;
      fromFilePath: string;
      fromLine: number;
      toDefinitionId: number;
      toName: string;
      toKind: string;
      toFilePath: string;
      toLine: number;
    }>
  >
): Promise<RelationshipSourceGroup[]> {
  const groups: RelationshipSourceGroup[] = [];

  for (const sourceId of sourceIds) {
    const rels = grouped.get(sourceId);
    if (!rels || rels.length === 0) continue;

    const def = db.definitions.getById(sourceId);
    if (!def) continue;

    const sourceCode = await readSourceAsString(db.resolveFilePath(def.filePath), def.line, def.endLine);
    const sourceMeta = db.metadata.get(sourceId);

    let sourceDomains: string[] | null = null;
    try {
      if (sourceMeta.domain) {
        sourceDomains = JSON.parse(sourceMeta.domain) as string[];
      }
    } catch {
      /* ignore */
    }

    // Build target info
    const relationships: RelationshipTarget[] = [];
    for (const rel of rels) {
      const targetMeta = db.metadata.get(rel.toDefinitionId);

      relationships.push({
        toId: rel.toDefinitionId,
        toName: rel.toName,
        toKind: rel.toKind,
        toFilePath: rel.toFilePath,
        toLine: rel.toLine,
        usageLine: rel.fromLine,
        relationshipType: 'uses',
        toPurpose: targetMeta.purpose || null,
        toDomains: null,
        toRole: targetMeta.role || null,
      });
    }

    groups.push({
      id: sourceId,
      name: def.name,
      kind: def.kind,
      filePath: def.filePath,
      line: def.line,
      endLine: def.endLine,
      sourceCode,
      purpose: sourceMeta.purpose || null,
      domains: sourceDomains,
      role: sourceMeta.role || null,
      relationships,
    });
  }

  return groups;
}
