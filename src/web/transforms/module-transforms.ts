import { computeProcessGroups, getProcessGroupLabel } from '../../commands/llm/_shared/process-utils.js';
import type { IndexDatabase } from '../../db/database.js';

/**
 * Build the modules data for visualization
 */
export function getModulesData(database: IndexDatabase): {
  modules: Array<{
    id: number;
    parentId: number | null;
    slug: string;
    name: string;
    fullPath: string;
    description: string | null;
    depth: number;
    colorIndex: number;
    memberCount: number;
    members: Array<{
      definitionId: number;
      name: string;
      kind: string;
      filePath: string;
      line: number;
    }>;
  }>;
  stats: {
    moduleCount: number;
    assigned: number;
    unassigned: number;
  };
} {
  try {
    const modulesWithMembers = database.modules.getAllWithMembers();
    const stats = database.modules.getStats();

    return {
      modules: modulesWithMembers.map((module) => ({
        id: module.id,
        parentId: module.parentId,
        slug: module.slug,
        name: module.name,
        fullPath: module.fullPath,
        description: module.description,
        depth: module.depth,
        colorIndex: module.colorIndex,
        memberCount: module.members.length,
        members: module.members,
      })),
      stats,
    };
  } catch {
    // Tables don't exist - return empty
    return {
      modules: [],
      stats: {
        moduleCount: 0,
        assigned: 0,
        unassigned: 0,
      },
    };
  }
}

/**
 * Build process group data from import graph connectivity.
 */
export function getProcessGroupsData(database: IndexDatabase): {
  groups: Array<{ id: number; label: string; moduleIds: number[]; moduleCount: number }>;
  groupCount: number;
} {
  try {
    const processGroups = computeProcessGroups(database);

    // Filter out singleton groups — only groups with 2+ modules are meaningful
    const groups = Array.from(processGroups.groupToModules.entries())
      .filter(([_groupId, modules]) => modules.length > 1)
      .map(([groupId, modules]) => ({
        id: groupId,
        label: getProcessGroupLabel(modules),
        moduleIds: modules.map((m) => m.id),
        moduleCount: modules.length,
      }));

    return {
      groups,
      groupCount: groups.length,
    };
  } catch {
    return {
      groups: [],
      groupCount: 0,
    };
  }
}
