import type { IndexDatabase } from '../../db/database.js';

/**
 * Build the symbol graph data for D3 visualization
 */
export function getSymbolGraph(db: IndexDatabase): {
  nodes: Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    hasAnnotations: boolean;
    purpose?: string;
    domain?: string[];
    pure?: boolean;
    lines: number;
    moduleId?: number;
    moduleName?: string;
  }>;
  edges: Array<{
    source: number;
    target: number;
    semantic: string;
    type: string;
  }>;
  stats: {
    totalSymbols: number;
    annotatedSymbols: number;
    totalRelationships: number;
    moduleCount: number;
  };
} {
  // Get all definitions as nodes
  const allDefs = db.definitions.getAll();

  // Get all relationship annotations (edges with labels)
  // Handle case where table doesn't exist in older databases
  let relationships: ReturnType<typeof db.relationships.getAll> = [];
  try {
    relationships = db.relationships.getAll({ limit: 10000 });
  } catch {
    // Table doesn't exist - continue with empty relationships
  }

  // Track which definition IDs have annotations
  const annotatedIds = new Set<number>();
  for (const rel of relationships) {
    annotatedIds.add(rel.fromDefinitionId);
    annotatedIds.add(rel.toDefinitionId);
  }

  // Get file paths for each definition
  const fileMap = new Map<number, string>();
  const files = db.files.getAll();
  for (const file of files) {
    fileMap.set(file.id, file.path);
  }

  // Get metadata for all definitions
  const metadataMap = new Map<number, Record<string, string>>();
  for (const def of allDefs) {
    const metadata = db.metadata.get(def.id);
    if (Object.keys(metadata).length > 0) {
      metadataMap.set(def.id, metadata);
    }
  }

  // Get module membership for all definitions
  const moduleMap = new Map<number, { moduleId: number; moduleName: string }>();
  let moduleCount = 0;
  try {
    const modules = db.modules.getAllWithMembers();
    moduleCount = modules.length;
    for (const module of modules) {
      for (const member of module.members) {
        moduleMap.set(member.definitionId, { moduleId: module.id, moduleName: module.name });
      }
    }
  } catch {
    // Module tables don't exist - continue without module info
  }

  // Build nodes array with metadata
  const nodes = allDefs.map((def) => {
    const metadata = metadataMap.get(def.id) || {};
    let domain: string[] | undefined;
    if (metadata.domain) {
      try {
        domain = JSON.parse(metadata.domain);
      } catch {
        domain = [metadata.domain];
      }
    }
    const moduleInfo = moduleMap.get(def.id);
    return {
      id: def.id,
      name: def.name,
      kind: def.kind,
      filePath: fileMap.get(def.fileId) || '',
      hasAnnotations: annotatedIds.has(def.id),
      purpose: metadata.purpose,
      domain,
      pure: metadata.pure ? metadata.pure === 'true' : undefined,
      lines: def.endLine - def.line + 1,
      moduleId: moduleInfo?.moduleId,
      moduleName: moduleInfo?.moduleName,
    };
  });

  // Build edges array from relationships
  const edges = relationships.map((rel) => ({
    source: rel.fromDefinitionId,
    target: rel.toDefinitionId,
    semantic: rel.semantic,
    type: rel.relationshipType,
  }));

  return {
    nodes,
    edges,
    stats: {
      totalSymbols: nodes.length,
      annotatedSymbols: annotatedIds.size,
      totalRelationships: relationships.length,
      moduleCount,
    },
  };
}
