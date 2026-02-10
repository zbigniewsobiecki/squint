import { computeProcessGroups, getProcessGroupLabel } from '../commands/llm/_shared/process-utils.js';
import type { IndexDatabase } from '../db/database.js';

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
  }>;
  stats: {
    totalSymbols: number;
    annotatedSymbols: number;
    totalRelationships: number;
    moduleCount: number;
  };
} {
  // Get all definitions as nodes
  const allDefs = db.getAllDefinitions();

  // Get all relationship annotations (edges with labels)
  // Handle case where table doesn't exist in older databases
  let relationships: ReturnType<typeof db.getAllRelationshipAnnotations> = [];
  try {
    relationships = db.getAllRelationshipAnnotations({ limit: 10000 });
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
  const files = db.getAllFiles();
  for (const file of files) {
    fileMap.set(file.id, file.path);
  }

  // Get metadata for all definitions
  const metadataMap = new Map<number, Record<string, string>>();
  for (const def of allDefs) {
    const metadata = db.getDefinitionMetadata(def.id);
    if (Object.keys(metadata).length > 0) {
      metadataMap.set(def.id, metadata);
    }
  }

  // Get module membership for all definitions
  const moduleMap = new Map<number, { moduleId: number; moduleName: string }>();
  let moduleCount = 0;
  try {
    const modules = db.getAllModulesWithMembers();
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
    const modulesWithMembers = database.getAllModulesWithMembers();
    const stats = database.getModuleStats();

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
 * Build the flows data for API response (hierarchical structure)
 */
export function getInteractionsData(database: IndexDatabase): {
  interactions: Array<{
    id: number;
    fromModuleId: number;
    toModuleId: number;
    fromModulePath: string;
    toModulePath: string;
    direction: string;
    weight: number;
    pattern: string | null;
    symbols: string | null;
    semantic: string | null;
    source: string;
  }>;
  stats: {
    totalCount: number;
    businessCount: number;
    utilityCount: number;
    biDirectionalCount: number;
  };
  relationshipCoverage: {
    totalRelationships: number;
    crossModuleRelationships: number;
    relationshipsContributingToInteractions: number;
    sameModuleCount: number;
    orphanedCount: number;
    coveragePercent: number;
  };
  processGroups: {
    groups: Array<{ id: number; label: string; moduleIds: number[]; moduleCount: number }>;
    groupCount: number;
  };
} {
  try {
    const interactions = database.getAllInteractions();
    const stats = database.getInteractionStats();
    const relationshipCoverage = database.getRelationshipCoverage();
    const processGroupData = getProcessGroupsData(database);

    return {
      interactions: interactions.map((i) => ({
        id: i.id,
        fromModuleId: i.fromModuleId,
        toModuleId: i.toModuleId,
        fromModulePath: i.fromModulePath,
        toModulePath: i.toModulePath,
        direction: i.direction,
        weight: i.weight,
        pattern: i.pattern,
        symbols: i.symbols,
        semantic: i.semantic,
        source: i.source,
      })),
      stats,
      relationshipCoverage,
      processGroups: processGroupData,
    };
  } catch {
    return {
      interactions: [],
      stats: {
        totalCount: 0,
        businessCount: 0,
        utilityCount: 0,
        biDirectionalCount: 0,
      },
      relationshipCoverage: {
        totalRelationships: 0,
        crossModuleRelationships: 0,
        relationshipsContributingToInteractions: 0,
        sameModuleCount: 0,
        orphanedCount: 0,
        coveragePercent: 0,
      },
      processGroups: {
        groups: [],
        groupCount: 0,
      },
    };
  }
}

/**
 * Build the flows data for the web UI.
 * Returns flows with their interaction steps.
 */
export function getFlowsData(database: IndexDatabase): {
  flows: Array<{
    id: number;
    name: string;
    slug: string;
    entryPath: string | null;
    stakeholder: string | null;
    description: string | null;
    stepCount: number;
    steps: Array<{
      stepOrder: number;
      fromModulePath: string;
      toModulePath: string;
      semantic: string | null;
    }>;
  }>;
  stats: {
    flowCount: number;
    withEntryPointCount: number;
    avgStepsPerFlow: number;
  };
  coverage: {
    totalInteractions: number;
    coveredByFlows: number;
    percentage: number;
  };
} {
  try {
    const flows = database.getAllFlows();
    const stats = database.getFlowStats();
    const coverage = database.getFlowCoverage();

    return {
      flows: flows.map((flow) => {
        const flowWithSteps = database.getFlowWithSteps(flow.id);
        const steps = flowWithSteps?.steps ?? [];

        return {
          id: flow.id,
          name: flow.name,
          slug: flow.slug,
          entryPath: flow.entryPath,
          stakeholder: flow.stakeholder,
          description: flow.description,
          tier: flow.tier,
          stepCount: steps.length,
          steps: steps.map((step) => ({
            stepOrder: step.stepOrder,
            fromModulePath: step.interaction.fromModulePath,
            toModulePath: step.interaction.toModulePath,
            semantic: step.interaction.semantic,
          })),
        };
      }),
      stats: {
        flowCount: stats.flowCount,
        withEntryPointCount: stats.withEntryPointCount,
        avgStepsPerFlow: stats.avgStepsPerFlow,
      },
      coverage,
    };
  } catch {
    return {
      flows: [],
      stats: {
        flowCount: 0,
        withEntryPointCount: 0,
        avgStepsPerFlow: 0,
      },
      coverage: {
        totalInteractions: 0,
        coveredByFlows: 0,
        percentage: 0,
      },
    };
  }
}

/**
 * Build the flows DAG data for the visualization.
 * Returns modules as nodes, interactions as edges, and flows with their steps.
 */
export function getFlowsDagData(database: IndexDatabase): {
  modules: Array<{
    id: number;
    parentId: number | null;
    name: string;
    fullPath: string;
    depth: number;
    colorIndex: number;
    memberCount: number;
  }>;
  edges: Array<{
    fromModuleId: number;
    toModuleId: number;
    weight: number;
  }>;
  flows: Array<{
    id: number;
    name: string;
    stakeholder: string | null;
    description: string | null;
    tier: number;
    stepCount: number;
    steps: Array<{
      interactionId: number | null;
      fromModuleId: number;
      toModuleId: number;
      semantic: string | null;
      fromDefName: string | null;
      toDefName: string | null;
    }>;
  }>;
  features: Array<{
    id: number;
    name: string;
    slug: string;
    description: string | null;
    flowIds: number[];
  }>;
} {
  try {
    // Get all modules
    const modulesWithMembers = database.getAllModulesWithMembers();
    const modules = modulesWithMembers.map((m) => ({
      id: m.id,
      parentId: m.parentId,
      name: m.name,
      fullPath: m.fullPath,
      depth: m.depth,
      colorIndex: m.colorIndex,
      memberCount: m.members.length,
    }));

    // Get module call graph edges (or interactions)
    const callGraph = database.getModuleCallGraph();
    const edges = callGraph.map((e) => ({
      fromModuleId: e.fromModuleId,
      toModuleId: e.toModuleId,
      weight: e.weight,
    }));

    // Get all flows with their steps
    const allFlows = database.getAllFlows();
    const flows = allFlows.map((flow) => {
      // Prefer definition-level steps (more granular), fall back to interaction steps
      const flowWithDefSteps = database.getFlowWithDefinitionSteps(flow.id);
      const hasDefSteps = flowWithDefSteps && flowWithDefSteps.definitionSteps.length > 0;

      if (hasDefSteps) {
        const defSteps = flowWithDefSteps.definitionSteps;
        return {
          id: flow.id,
          name: flow.name,
          stakeholder: flow.stakeholder,
          description: flow.description,
          tier: flow.tier,
          stepCount: defSteps.length,
          steps: defSteps
            .filter((step) => step.fromModuleId != null && step.toModuleId != null)
            .map((step) => ({
              interactionId: null,
              fromModuleId: step.fromModuleId as number,
              toModuleId: step.toModuleId as number,
              semantic: step.semantic ?? null,
              fromDefName: step.fromDefinitionName,
              toDefName: step.toDefinitionName,
            })),
        };
      }

      const flowWithSteps = database.getFlowWithSteps(flow.id);
      const steps = flowWithSteps?.steps ?? [];

      return {
        id: flow.id,
        name: flow.name,
        stakeholder: flow.stakeholder,
        description: flow.description,
        tier: flow.tier,
        stepCount: steps.length,
        steps: steps.map((step) => ({
          interactionId: step.interactionId,
          fromModuleId: step.interaction.fromModuleId,
          toModuleId: step.interaction.toModuleId,
          semantic: step.interaction.semantic,
          fromDefName: null,
          toDefName: null,
        })),
      };
    });

    // Get features with their associated flow IDs
    let features: Array<{ id: number; name: string; slug: string; description: string | null; flowIds: number[] }> = [];
    try {
      const allFeatures = database.getAllFeatures();
      features = allFeatures.map((f) => {
        const withFlows = database.getFeatureWithFlows(f.id);
        return {
          id: f.id,
          name: f.name,
          slug: f.slug,
          description: f.description,
          flowIds: withFlows ? withFlows.flows.map((fl) => fl.id) : [],
        };
      });
    } catch {
      // Features not available (e.g. llm features hasn't been run)
    }

    return { modules, edges, flows, features };
  } catch {
    return { modules: [], edges: [], flows: [], features: [] };
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

    // Filter out isolated singleton groups (negative groupId = module with no files)
    const groups = Array.from(processGroups.groupToModules.entries())
      .filter(([groupId, modules]) => groupId >= 0 || modules.length > 1)
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
