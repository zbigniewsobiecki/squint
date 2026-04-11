import path from 'node:path';
import type { IndexDatabase } from '../../src/db/database-facade.js';
import { computeHash } from '../../src/db/schema.js';
import { contractIdByKey, definitionIdByKey, moduleIdByKey } from './comparator/natural-keys.js';
import {
  type DefKey,
  type GroundTruth,
  type GroundTruthFlow,
  type GroundTruthInteraction,
  type GroundTruthModule,
  defKey,
  parseDefKey,
} from './types.js';

/**
 * Populate a fresh IndexDatabase from a GroundTruth declarative spec.
 *
 * The DB MUST already have been opened and `initialize()` called by the
 * caller — that way the harness owns DB lifecycle and the builder is purely
 * a write operation.
 *
 * The builder uses the same repositories that real squint ingestion uses,
 * so the resulting schema is by-construction live-schema-compatible.
 */
export function buildGroundTruthDb(db: IndexDatabase, gt: GroundTruth): void {
  // ----------------------------------------------------------
  // Files
  // ----------------------------------------------------------
  const fileIdByPath = new Map<string, number>();
  for (const f of gt.files) {
    const id = db.files.insert({
      path: f.path,
      language: f.language,
      contentHash: computeHash(f.path), // deterministic per-path hash; content is irrelevant for ground truth
      sizeBytes: 0,
      modifiedAt: '2026-01-01T00:00:00.000Z',
    });
    fileIdByPath.set(f.path, id);
  }

  // ----------------------------------------------------------
  // Definitions
  // ----------------------------------------------------------
  for (const d of gt.definitions) {
    const fileId = fileIdByPath.get(d.file);
    if (fileId === undefined) {
      throw new Error(`Ground-truth definition '${d.name}' references missing file '${d.file}'`);
    }
    db.files.insertDefinition(fileId, {
      name: d.name,
      kind: d.kind,
      isExported: d.isExported,
      isDefault: d.isDefault ?? false,
      // Definition extractor uses 0-based row, repositories add 1
      position: { row: d.line - 1, column: 0 },
      endPosition: { row: (d.endLine ?? d.line) - 1, column: 0 },
      extends: d.extendsName ?? undefined,
      implements: d.implementsNames ?? undefined,
      extendsAll: d.extendsInterfaces ?? undefined,
    });
  }

  // ----------------------------------------------------------
  // Imports + symbols
  // ----------------------------------------------------------
  if (gt.imports) {
    for (const imp of gt.imports) {
      const fromFileId = fileIdByPath.get(imp.fromFile);
      if (fromFileId === undefined) {
        throw new Error(`Ground-truth import references missing fromFile '${imp.fromFile}'`);
      }
      // Resolve to_file_id with real ESM-style relative-path resolution.
      const toFileId = resolveImportTargetFileId(fileIdByPath, imp.fromFile, imp.source);

      const refId = db.files.insertReference(fromFileId, toFileId, {
        type: imp.type,
        source: imp.source,
        isExternal: imp.isExternal ?? false,
        isTypeOnly: imp.isTypeOnly ?? false,
        imports: [],
        position: { row: 0, column: 0 },
      });

      for (const sym of imp.symbols ?? []) {
        // Try to find a matching exported definition in the target file (if any)
        let definitionId: number | null = null;
        if (toFileId !== null) {
          const conn = db.getConnection();
          const row = conn
            .prepare('SELECT id FROM definitions WHERE file_id = ? AND name = ? LIMIT 1')
            .get(toFileId, sym.name) as { id: number } | undefined;
          definitionId = row?.id ?? null;
        }
        db.files.insertSymbol(refId, definitionId, {
          name: sym.name,
          localName: sym.localName ?? sym.name,
          kind: sym.kind,
          usages: [],
        });
      }
    }
  }

  // ----------------------------------------------------------
  // Usages
  // ----------------------------------------------------------
  if (gt.usages) {
    const conn = db.getConnection();
    for (const u of gt.usages) {
      const fileId = fileIdByPath.get(u.file);
      if (fileId === undefined) {
        throw new Error(`Ground-truth usage references missing file '${u.file}'`);
      }
      // Find a symbol in this file with matching local name
      const symRow = conn
        .prepare(
          `SELECT s.id AS id FROM symbols s
           LEFT JOIN imports i ON s.reference_id = i.id
           WHERE (i.from_file_id = ? OR s.file_id = ?) AND s.local_name = ?
           LIMIT 1`
        )
        .get(fileId, fileId, u.symbolName) as { id: number } | undefined;
      if (!symRow) {
        throw new Error(
          `Ground-truth usage of '${u.symbolName}' in ${u.file} has no matching imported/internal symbol`
        );
      }
      db.files.insertUsage(symRow.id, {
        position: { row: u.line - 1, column: 0 },
        context: u.context,
        callsite: {
          argumentCount: 0,
          isMethodCall: u.isMethodCall ?? false,
          isConstructorCall: u.isConstructorCall ?? false,
        },
      });
    }
  }

  // ----------------------------------------------------------
  // Modules tree (with auto-created intermediate ancestors)
  // ----------------------------------------------------------
  if (gt.modules && gt.modules.length > 0) {
    insertModuleTree(db, gt.modules);
  }

  // ----------------------------------------------------------
  // Definition metadata
  // ----------------------------------------------------------
  if (gt.definitionMetadata) {
    for (const m of gt.definitionMetadata) {
      const defId = definitionIdByKey(db, m.defKey);
      if (defId === null) {
        throw new Error(`definition_metadata references unknown definition '${m.defKey}'`);
      }
      const value = m.exactValue ?? m.proseReference ?? '';
      db.metadata.set(defId, m.key, value);
    }
  }

  // ----------------------------------------------------------
  // Relationship annotations
  // ----------------------------------------------------------
  if (gt.relationships) {
    for (const r of gt.relationships) {
      const fromId = definitionIdByKey(db, r.fromDef);
      const toId = definitionIdByKey(db, r.toDef);
      if (fromId === null || toId === null) {
        throw new Error(`relationship references unknown definition: ${r.fromDef} → ${r.toDef}`);
      }
      db.relationships.set(fromId, toId, r.semanticReference ?? '', r.relationshipType);
    }
  }

  // ----------------------------------------------------------
  // Contracts + participants
  // ----------------------------------------------------------
  if (gt.contracts) {
    for (const c of gt.contracts) {
      const contractId = db.contracts.upsertContract(c.protocol, c.normalizedKey, c.normalizedKey);
      for (const p of c.participants) {
        const defId = definitionIdByKey(db, p.defKey);
        if (defId === null) {
          throw new Error(`contract participant references unknown definition '${p.defKey}'`);
        }
        // Find module for the definition (if assigned)
        const conn = db.getConnection();
        const modRow = conn
          .prepare('SELECT module_id FROM module_members WHERE definition_id = ? LIMIT 1')
          .get(defId) as { module_id: number } | undefined;
        db.contracts.addParticipant(contractId, defId, modRow?.module_id ?? null, p.role);
      }
    }
  }

  // ----------------------------------------------------------
  // Interactions + definition links
  // ----------------------------------------------------------
  if (gt.interactions) {
    insertInteractions(db, gt.interactions);
  }

  // ----------------------------------------------------------
  // Flows + steps
  // ----------------------------------------------------------
  if (gt.flows) {
    insertFlows(db, gt.flows);
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Resolve a relative import source against the importing file's directory,
 * using ESM-style extension swap and index-file fallback.
 *
 * Examples (fromFile → source → resolved):
 *   src/a.ts → './b.js'              → src/b.ts
 *   src/services/auth.ts → '../types.js' → src/types.ts
 *   src/index.ts → '../lib/index.js' → lib/index.ts
 *   src/a.ts → './folder.js'         → src/folder/index.ts (if folder.ts doesn't exist)
 *   src/a.ts → 'express'             → null (external package)
 */
function resolveImportTargetFileId(fileIdByPath: Map<string, number>, fromFile: string, source: string): number | null {
  // External (no relative or absolute prefix) → no target file
  if (!source.startsWith('.') && !source.startsWith('/')) return null;

  // Resolve the source relative to the importing file's directory.
  // path.posix keeps separators stable across platforms; ground-truth paths
  // are always POSIX-style (relative to fixture root).
  const fromDir = path.posix.dirname(fromFile);
  const resolvedNoExt = path.posix.normalize(
    path.posix.join(fromDir, source.replace(/\.(js|ts|tsx|jsx|mjs|cjs)$/, ''))
  );

  // Try each candidate path in order: explicit extensions, then index files.
  const candidates = [
    `${resolvedNoExt}.ts`,
    `${resolvedNoExt}.tsx`,
    `${resolvedNoExt}.js`,
    `${resolvedNoExt}.jsx`,
    `${resolvedNoExt}/index.ts`,
    `${resolvedNoExt}/index.tsx`,
    `${resolvedNoExt}/index.js`,
    `${resolvedNoExt}/index.jsx`,
    // Last resort: the resolved path itself (already had the right extension)
    resolvedNoExt,
  ];

  for (const candidate of candidates) {
    const id = fileIdByPath.get(candidate);
    if (id !== undefined) return id;
  }
  return null;
}

function insertModuleTree(db: IndexDatabase, gtModules: GroundTruthModule[]): void {
  // Sort by depth (number of dots) so parents are inserted before children
  const sorted = [...gtModules].sort((a, b) => a.fullPath.split('.').length - b.fullPath.split('.').length);

  // Ensure root is created
  db.modules.ensureRoot();

  function ensureStrictAncestors(fullPath: string): void {
    const segments = fullPath.split('.');
    // Iterate STRICT ancestors only — skip the leaf path itself
    for (let i = 1; i < segments.length - 1; i++) {
      const ancestorPath = segments.slice(0, i + 1).join('.');
      if (moduleIdByKey(db, ancestorPath) !== null) continue;
      const parentPath = segments.slice(0, i).join('.');
      const parentId = moduleIdByKey(db, parentPath);
      if (parentId === null) {
        throw new Error(`Internal: parent module '${parentPath}' not found`);
      }
      db.modules.insert(parentId, segments[i], segments[i]);
    }
  }

  for (const m of sorted) {
    ensureStrictAncestors(m.fullPath);
    const segments = m.fullPath.split('.');
    const parentPath = segments.slice(0, -1).join('.');
    const slug = segments[segments.length - 1];

    const existing = moduleIdByKey(db, m.fullPath);
    if (existing === null) {
      const parentId = parentPath ? moduleIdByKey(db, parentPath) : null;
      if (parentId === null && parentPath) {
        throw new Error(`Internal: parent module '${parentPath}' not found`);
      }
      db.modules.insert(parentId, slug, m.name, undefined, m.isTest);
    }

    // Assign members
    if (m.members) {
      const moduleId = moduleIdByKey(db, m.fullPath);
      if (moduleId === null) throw new Error(`Internal: module '${m.fullPath}' missing after insert`);
      for (const memberKey of m.members) {
        const defId = definitionIdByKey(db, memberKey);
        if (defId === null) {
          throw new Error(`module '${m.fullPath}' member references unknown definition '${memberKey}'`);
        }
        db.modules.assignSymbol(defId, moduleId);
      }
    }
  }
}

function insertInteractions(db: IndexDatabase, interactions: GroundTruthInteraction[]): void {
  for (const i of interactions) {
    const fromId = moduleIdByKey(db, i.fromModulePath);
    const toId = moduleIdByKey(db, i.toModulePath);
    if (fromId === null || toId === null) {
      throw new Error(`interaction references unknown module: ${i.fromModulePath} → ${i.toModulePath}`);
    }
    const interactionId = db.interactions.insert(fromId, toId, {
      pattern: i.pattern ?? undefined,
      source: i.source,
      semantic: i.semanticReference,
    });

    if (i.links) {
      const conn = db.getConnection();
      const insertLink = conn.prepare(
        `INSERT OR IGNORE INTO interaction_definition_links (interaction_id, from_definition_id, to_definition_id, contract_id)
         VALUES (?, ?, ?, ?)`
      );
      for (const l of i.links) {
        const fromDefId = definitionIdByKey(db, l.fromDef);
        const toDefId = definitionIdByKey(db, l.toDef);
        if (fromDefId === null || toDefId === null) {
          throw new Error(`interaction link references unknown definition: ${l.fromDef} → ${l.toDef}`);
        }
        const contractId = l.contractKey ? contractIdByKey(db, l.contractKey) : null;
        insertLink.run(interactionId, fromDefId, toDefId, contractId);
      }
    }
  }
}

function insertFlows(db: IndexDatabase, flows: GroundTruthFlow[]): void {
  for (const f of flows) {
    let entryDefId: number | undefined;
    if (f.entryDef) {
      const id = definitionIdByKey(db, f.entryDef);
      if (id === null) throw new Error(`flow '${f.slug}' entryDef references unknown '${f.entryDef}'`);
      entryDefId = id;
    }
    let entryModuleId: number | undefined;
    if (f.entryModulePath) {
      const id = moduleIdByKey(db, f.entryModulePath);
      if (id === null) throw new Error(`flow '${f.slug}' entryModulePath references unknown '${f.entryModulePath}'`);
      entryModuleId = id;
    }

    const flowId = db.flows.insert(f.name, f.slug, {
      entryPointId: entryDefId,
      entryPointModuleId: entryModuleId,
      entryPath: f.entryPath,
      stakeholder: f.stakeholder,
      description: f.descriptionReference,
    });

    // Module-level steps (interactions)
    if (f.steps && f.steps.length > 0) {
      const interactionIds: number[] = [];
      for (const s of f.steps) {
        const fromId = moduleIdByKey(db, s.from);
        const toId = moduleIdByKey(db, s.to);
        if (fromId === null || toId === null) {
          throw new Error(`flow '${f.slug}' step references unknown modules: ${s.from} → ${s.to}`);
        }
        const conn = db.getConnection();
        const row = conn
          .prepare('SELECT id FROM interactions WHERE from_module_id = ? AND to_module_id = ? LIMIT 1')
          .get(fromId, toId) as { id: number } | undefined;
        if (!row) {
          throw new Error(
            `flow '${f.slug}' step references interaction ${s.from} → ${s.to} that was not declared in ground truth`
          );
        }
        interactionIds.push(row.id);
      }
      db.flows.addSteps(flowId, interactionIds);
    }

    // Definition-level steps
    if (f.definitionSteps && f.definitionSteps.length > 0) {
      const steps = f.definitionSteps.map((s) => {
        const fromId = definitionIdByKey(db, s.from);
        const toId = definitionIdByKey(db, s.to);
        if (fromId === null || toId === null) {
          throw new Error(`flow '${f.slug}' definitionStep references unknown definitions: ${s.from} → ${s.to}`);
        }
        return { fromDefinitionId: fromId, toDefinitionId: toId };
      });
      db.flows.addDefinitionSteps(flowId, steps);
    }
  }
}

// Re-export DefKey helpers for ergonomics
export { defKey, parseDefKey };
export type { DefKey };
