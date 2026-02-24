/**
 * Deterministic fallback assignment using file/directory cohort voting.
 */

import chalk from 'chalk';
import type { IndexDatabase } from '../../../db/database.js';
import { buildCohortVotes, findAssignmentTarget, isTestFile } from './cohort-voter.js';

/**
 * Deterministic fallback: assign remaining unassigned symbols using file/directory cohort majority.
 * Tier 1: If other symbols in the same file are assigned to a module, assign there.
 * Tier 2: If other symbols in the same directory are assigned to a module, assign there.
 *         Walks up parent directories if no match at the immediate level.
 * Test-file guard: test file symbols only assigned to test modules.
 */
export function assignByFileCohortFallback(db: IndexDatabase, isJson: boolean, verbose: boolean): number {
  const allModulesWithMembers = db.modules.getAllWithMembers();
  const allModules = db.modules.getAll();
  const moduleById = new Map(allModules.map((m) => [m.id, { id: m.id, isTest: m.isTest }]));

  // Build cohort votes
  const { fileMajority, dirMajority } = buildCohortVotes(allModulesWithMembers);

  const unassigned = db.modules.getUnassigned();
  let tier1Count = 0;
  let tier2Count = 0;
  const stillUnassigned: typeof unassigned = [];

  for (const sym of unassigned) {
    const symIsTest = isTestFile(sym.filePath);

    const target = findAssignmentTarget(sym.filePath, fileMajority, dirMajority, moduleById, symIsTest);

    if (target) {
      db.modules.assignSymbol(sym.id, target.moduleId);
      if (target.tier === 'file') {
        tier1Count++;
      } else {
        tier2Count++;
      }
    } else {
      stillUnassigned.push(sym);
    }
  }

  if (verbose && !isJson) {
    console.log(chalk.gray('  Deterministic fallback:'));
    console.log(chalk.gray(`    Tier 1 (file cohort): ${tier1Count} assigned`));
    console.log(chalk.gray(`    Tier 2 (directory cohort): ${tier2Count} assigned`));
    if (stillUnassigned.length > 0) {
      console.log(chalk.gray(`    Still unassigned: ${stillUnassigned.length}`));
    }
  }

  return tier1Count + tier2Count;
}
