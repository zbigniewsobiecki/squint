/**
 * Cohort voting utilities for deterministic symbol assignment fallback.
 *
 * Uses file and directory cohort majority voting to assign symbols when
 * LLM-based assignment fails or is incomplete.
 */

import path from 'node:path';

export interface VoteEntry {
  moduleId: number;
  count: number;
}

export interface MemberInfo {
  definitionId: number;
  filePath: string;
}

export interface ModuleInfo {
  id: number;
  isTest: boolean;
}

export interface CohortVoteResult {
  fileVotes: Map<string, Map<number, number>>;
  dirVotes: Map<string, Map<number, number>>;
  fileMajority: Map<string, VoteEntry>;
  dirMajority: Map<string, VoteEntry>;
}

/**
 * Build file and directory vote maps from module members.
 */
export function buildVotes(modules: Array<{ id: number; members: MemberInfo[] }>): {
  fileVotes: Map<string, Map<number, number>>;
  dirVotes: Map<string, Map<number, number>>;
} {
  const fileVotes = new Map<string, Map<number, number>>();
  const dirVotes = new Map<string, Map<number, number>>();

  for (const mod of modules) {
    for (const member of mod.members) {
      // File votes
      let fv = fileVotes.get(member.filePath);
      if (!fv) {
        fv = new Map();
        fileVotes.set(member.filePath, fv);
      }
      fv.set(mod.id, (fv.get(mod.id) ?? 0) + 1);

      // Directory votes
      const dir = path.dirname(member.filePath);
      if (dir) {
        let dv = dirVotes.get(dir);
        if (!dv) {
          dv = new Map();
          dirVotes.set(dir, dv);
        }
        dv.set(mod.id, (dv.get(mod.id) ?? 0) + 1);
      }
    }
  }

  return { fileVotes, dirVotes };
}

/**
 * Resolve majority module per file or directory from vote counts.
 */
export function resolveMajority(votes: Map<string, Map<number, number>>): Map<string, VoteEntry> {
  const majority = new Map<string, VoteEntry>();

  for (const [key, moduleCounts] of votes) {
    let bestModuleId = -1;
    let bestCount = 0;
    for (const [moduleId, count] of moduleCounts) {
      if (count > bestCount) {
        bestModuleId = moduleId;
        bestCount = count;
      }
    }
    if (bestModuleId >= 0) {
      majority.set(key, { moduleId: bestModuleId, count: bestCount });
    }
  }

  return majority;
}

/**
 * Build complete cohort vote result with file and directory majorities.
 */
export function buildCohortVotes(modules: Array<{ id: number; members: MemberInfo[] }>): CohortVoteResult {
  const { fileVotes, dirVotes } = buildVotes(modules);
  const fileMajority = resolveMajority(fileVotes);
  const dirMajority = resolveMajority(dirVotes);

  return { fileVotes, dirVotes, fileMajority, dirMajority };
}

/**
 * Check if a symbol is from a test file.
 */
export function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes('.test.') ||
    lower.includes('.spec.') ||
    lower.includes('/__tests__/') ||
    lower.includes('/test/') ||
    lower.includes('/tests/')
  );
}

export interface AssignmentTarget {
  moduleId: number;
  tier: 'file' | 'directory' | null;
}

/**
 * Find assignment target for a symbol using cohort voting.
 *
 * Tier 1: Same-file majority
 * Tier 2: Same-directory majority (walks up parent directories)
 *
 * @param filePath Symbol's file path
 * @param fileMajority File-level majority votes
 * @param dirMajority Directory-level majority votes
 * @param moduleById Module lookup by ID
 * @param symIsTest Whether the symbol is from a test file
 * @returns Assignment target with tier info, or null if no match
 */
export function findAssignmentTarget(
  filePath: string,
  fileMajority: Map<string, VoteEntry>,
  dirMajority: Map<string, VoteEntry>,
  moduleById: Map<number, ModuleInfo>,
  symIsTest: boolean
): AssignmentTarget | null {
  // Tier 1: Same-file majority
  const fileMaj = fileMajority.get(filePath);
  if (fileMaj) {
    const mod = moduleById.get(fileMaj.moduleId);
    if (mod && (!symIsTest || mod.isTest)) {
      return { moduleId: fileMaj.moduleId, tier: 'file' };
    }
  }

  // Tier 2: Same-directory majority (walk up)
  let dir = path.dirname(filePath);
  while (dir && dir !== '.' && dir !== '/') {
    const dirMaj = dirMajority.get(dir);
    if (dirMaj) {
      const mod = moduleById.get(dirMaj.moduleId);
      if (mod && (!symIsTest || mod.isTest)) {
        return { moduleId: dirMaj.moduleId, tier: 'directory' };
      }
    }
    dir = path.dirname(dir);
  }

  return null;
}
