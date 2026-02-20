import type { IndexDatabase } from '../../db/database.js';
import { getProcessGroupsData } from './module-transforms.js';

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
    const interactions = database.interactions.getAll();
    const stats = database.interactions.getStats();
    const relationshipCoverage = database.interactionAnalysis.getRelationshipCoverage();
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
    const flows = database.flows.getAll();
    const stats = database.flows.getStats();
    const coverage = database.flows.getCoverage();

    return {
      flows: flows.map((flow) => {
        const flowWithSteps = database.flows.getWithSteps(flow.id);
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
    description: string | null;
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
    const modulesWithMembers = database.modules.getAllWithMembers();
    const modules = modulesWithMembers.map((m) => ({
      id: m.id,
      parentId: m.parentId,
      name: m.name,
      fullPath: m.fullPath,
      description: m.description,
      depth: m.depth,
      colorIndex: m.colorIndex,
      memberCount: m.members.length,
    }));

    // Get module call graph edges (or interactions)
    const callGraph = database.callGraph.getModuleCallGraph();
    const edges = callGraph.map((e) => ({
      fromModuleId: e.fromModuleId,
      toModuleId: e.toModuleId,
      weight: e.weight,
    }));

    // Get all flows with their steps
    const allFlows = database.flows.getAll();
    const flows = allFlows.map((flow) => {
      // Prefer definition-level steps (more granular), fall back to interaction steps
      const flowWithDefSteps = database.flows.getWithDefinitionSteps(flow.id);
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

      const flowWithSteps = database.flows.getWithSteps(flow.id);
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
      const allFeatures = database.features.getAll();
      features = allFeatures.map((f) => {
        const withFlows = database.features.getWithFlows(f.id);
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
