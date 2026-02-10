/**
 * Process group detection via import graph connectivity (union-find).
 *
 * Replaces the old layer-utils.ts which hardcoded frontend/backend classification.
 * Instead of classifying modules by path keywords, we compute connected components
 * in the non-type-only import graph. Modules whose files share a connected component
 * are in the same OS process. Modules with no import connectivity are in separate
 * processes and may communicate via runtime protocols (HTTP, IPC, queues, etc.).
 */

import type { IndexDatabase } from '../../../db/database-facade.js';
import type { Module } from '../../../db/schema.js';

export interface ProcessGroups {
  /** moduleId → groupId */
  moduleToGroup: Map<number, number>;
  /** groupId → modules in that group */
  groupToModules: Map<number, Module[]>;
  /** Number of distinct process groups */
  groupCount: number;
}

// ============================================================
// Union-Find
// ============================================================

class UnionFind {
  private parent: Map<number, number> = new Map();
  private rank: Map<number, number> = new Map();

  find(x: number): number {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression
    let current = x;
    while (current !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;

    const rankA = this.rank.get(rootA)!;
    const rankB = this.rank.get(rootB)!;
    if (rankA < rankB) {
      this.parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA);
    } else {
      this.parent.set(rootB, rootA);
      this.rank.set(rootA, rankA + 1);
    }
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Compute process groups from import graph connectivity.
 *
 * 1. Get all file→module mappings
 * 2. Get runtime (non-type-only) import edges between files
 * 3. Union-find on file IDs using the edges → each file gets a group representative
 * 4. Map each module to its group via its files' representatives (majority vote)
 * 5. Build the ProcessGroups result
 */
export function computeProcessGroups(db: IndexDatabase): ProcessGroups {
  const fileToModule = db.interactions.getFileToModuleMap();
  const importEdges = db.interactions.getRuntimeImportEdges();
  const allModules = db.modules.getAll();

  // Build union-find over file IDs
  const uf = new UnionFind();

  // Ensure all files with module assignments are in the UF
  for (const fileId of fileToModule.keys()) {
    uf.find(fileId);
  }

  // Union files connected by runtime imports
  for (const edge of importEdges) {
    uf.union(edge.fromFileId, edge.toFileId);
  }

  // Map each module to its group representative via its files
  // A module's group = the representative of the majority of its files
  const moduleFiles = new Map<number, number[]>(); // moduleId → fileIds
  for (const [fileId, moduleId] of fileToModule) {
    const files = moduleFiles.get(moduleId) ?? [];
    files.push(fileId);
    moduleFiles.set(moduleId, files);
  }

  const moduleToGroup = new Map<number, number>();
  const groupToModules = new Map<number, Module[]>();

  for (const mod of allModules) {
    const files = moduleFiles.get(mod.id);
    if (!files || files.length === 0) {
      // Module has no files with definitions → assign to its own isolated group
      const isolatedGroup = -mod.id; // negative to avoid collision with file-based groups
      moduleToGroup.set(mod.id, isolatedGroup);
      groupToModules.set(isolatedGroup, [mod]);
      continue;
    }

    // Count representative occurrences to find majority group
    const repCounts = new Map<number, number>();
    for (const fileId of files) {
      const rep = uf.find(fileId);
      repCounts.set(rep, (repCounts.get(rep) ?? 0) + 1);
    }

    // Pick the representative with the most files
    let bestRep = -1;
    let bestCount = 0;
    for (const [rep, count] of repCounts) {
      if (count > bestCount) {
        bestRep = rep;
        bestCount = count;
      }
    }

    moduleToGroup.set(mod.id, bestRep);
    const existing = groupToModules.get(bestRep) ?? [];
    existing.push(mod);
    groupToModules.set(bestRep, existing);
  }

  return {
    moduleToGroup,
    groupToModules,
    groupCount: groupToModules.size,
  };
}

/**
 * Check if two modules are in the same process group.
 */
export function areSameProcess(fromId: number, toId: number, groups: ProcessGroups): boolean {
  const fromGroup = groups.moduleToGroup.get(fromId);
  const toGroup = groups.moduleToGroup.get(toId);

  // If either module has no group, treat as same-process (conservative)
  if (fromGroup === undefined || toGroup === undefined) return true;

  return fromGroup === toGroup;
}

/**
 * Human-readable description of the process relationship between two modules.
 */
export function getProcessDescription(fromId: number, toId: number, groups: ProcessGroups): string {
  if (areSameProcess(fromId, toId, groups)) {
    return 'same-process (shared import graph)';
  }
  return 'separate-process (no import connectivity)';
}

/**
 * Derive a label for a process group from its modules' common ancestor path.
 *
 * - If all modules start with `project.frontend.*` → label is "frontend"
 * - If mixed → use the depth-1 ancestors as the label (e.g., "backend, shared")
 */
export function getProcessGroupLabel(modules: Module[]): string {
  if (modules.length === 0) return 'empty';
  if (modules.length === 1) {
    const parts = modules[0].fullPath.split('.');
    return parts.length > 1 ? parts[1] : parts[0];
  }

  // Find common path prefix segments
  const allParts = modules.map((m) => m.fullPath.split('.'));
  const minLen = Math.min(...allParts.map((p) => p.length));

  let commonDepth = 0;
  for (let i = 0; i < minLen; i++) {
    const seg = allParts[0][i];
    if (allParts.every((p) => p[i] === seg)) {
      commonDepth = i + 1;
    } else {
      break;
    }
  }

  if (commonDepth > 1) {
    // Use the deepest common segment as the label (skip project root)
    const commonPath = allParts[0].slice(0, commonDepth).join('.');
    const parts = commonPath.split('.');
    return parts.slice(1).join('.');
  }

  // Root-only or no common prefix: use the most frequent depth-1 segment
  const segCounts = new Map<string, number>();
  for (const parts of allParts) {
    const seg = parts.length > 1 ? parts[1] : parts[0];
    segCounts.set(seg, (segCounts.get(seg) ?? 0) + 1);
  }

  let bestSeg = '';
  let bestCount = 0;
  for (const [seg, count] of segCounts) {
    if (count > bestCount) {
      bestSeg = seg;
      bestCount = count;
    }
  }

  return bestSeg;
}

/**
 * Get all pairs of process groups for cross-process inference.
 * Returns pairs of (groupA modules, groupB modules) for each unique group pair.
 * Excludes isolated groups (single module with no files) — these are empty branch
 * nodes that cannot produce runtime interactions.
 */
export function getCrossProcessGroupPairs(groups: ProcessGroups): Array<[Module[], Module[]]> {
  // Filter out isolated singleton groups (negative groupId = module with no files)
  const groupIds = Array.from(groups.groupToModules.keys()).filter((gid) => {
    if (gid >= 0) return true; // file-based group — always include
    const mods = groups.groupToModules.get(gid)!;
    return mods.length > 1; // isolated singletons have no definitions, skip them
  });

  const pairs: Array<[Module[], Module[]]> = [];

  for (let i = 0; i < groupIds.length; i++) {
    for (let j = i + 1; j < groupIds.length; j++) {
      const modulesA = groups.groupToModules.get(groupIds[i])!;
      const modulesB = groups.groupToModules.get(groupIds[j])!;
      pairs.push([modulesA, modulesB]);
    }
  }

  return pairs;
}
