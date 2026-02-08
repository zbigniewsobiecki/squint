import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { LLMist } from 'llmist';
import { CallGraphEdge, ModuleLayer } from '../../db/database.js';
import { openDatabase, SharedFlags } from '../_shared/index.js';
import { buildModuleSystemPrompt, buildModuleUserPrompt, ModuleCandidate } from './_shared/prompts.js';

/**
 * Maps common role names to architectural layers.
 * Used as fallback when LLM doesn't provide a layer.
 */
const ROLE_TO_LAYER_MAP: Record<string, ModuleLayer> = {
  'controller': 'controller',
  'handler': 'controller',
  'service': 'service',
  'business-logic': 'service',
  'repository': 'repository',
  'dao': 'repository',
  'adapter': 'adapter',
  'utility': 'utility',
  'helper': 'utility',
};

/**
 * Infer module layer from dominant roles.
 * Returns the first matching layer or undefined if no match found.
 */
function inferLayerFromRoles(roles: string[]): ModuleLayer | undefined {
  for (const role of roles) {
    const mapped = ROLE_TO_LAYER_MAP[role.toLowerCase()];
    if (mapped) return mapped;
  }
  return undefined;
}

/**
 * Louvain community detection algorithm for module boundary inference.
 *
 * Algorithm overview:
 * 1. Initialize each node in its own community
 * 2. For each node, try moving it to a neighbor's community if it improves modularity
 * 3. Repeat until no improvement is possible
 * 4. Aggregate nodes into super-nodes and repeat
 */

interface Graph {
  nodes: Set<number>;
  edges: Map<number, Map<number, number>>; // node -> (neighbor -> weight)
  totalWeight: number;
}

interface Community {
  id: number;
  members: Set<number>;
  internalWeight: number;
  totalDegree: number;
}

/**
 * Build an undirected graph from call graph edges.
 */
function buildGraph(edges: CallGraphEdge[]): Graph {
  const nodes = new Set<number>();
  const edgeMap = new Map<number, Map<number, number>>();
  let totalWeight = 0;

  for (const edge of edges) {
    nodes.add(edge.fromId);
    nodes.add(edge.toId);

    // Add both directions (undirected graph)
    if (!edgeMap.has(edge.fromId)) edgeMap.set(edge.fromId, new Map());
    if (!edgeMap.has(edge.toId)) edgeMap.set(edge.toId, new Map());

    const fromNeighbors = edgeMap.get(edge.fromId)!;
    const toNeighbors = edgeMap.get(edge.toId)!;

    // Accumulate weights for existing edges
    const existingFromTo = fromNeighbors.get(edge.toId) ?? 0;
    const existingToFrom = toNeighbors.get(edge.fromId) ?? 0;

    fromNeighbors.set(edge.toId, existingFromTo + edge.weight);
    toNeighbors.set(edge.fromId, existingToFrom + edge.weight);

    totalWeight += edge.weight;
  }

  return { nodes, edges: edgeMap, totalWeight };
}

/**
 * Get the degree (sum of edge weights) for a node.
 */
function getNodeDegree(graph: Graph, node: number): number {
  const neighbors = graph.edges.get(node);
  if (!neighbors) return 0;
  let degree = 0;
  for (const weight of neighbors.values()) {
    degree += weight;
  }
  return degree;
}

/**
 * Calculate modularity of a partition.
 * Q = (1/2m) * Σ [A_ij - (k_i * k_j) / 2m] * δ(c_i, c_j)
 */
function calculateModularity(graph: Graph, communities: Map<number, number>): number {
  const m = graph.totalWeight;
  if (m === 0) return 0;

  let q = 0;

  for (const [node, neighbors] of graph.edges) {
    const ki = getNodeDegree(graph, node);
    const ci = communities.get(node)!;

    for (const [neighbor, weight] of neighbors) {
      const kj = getNodeDegree(graph, neighbor);
      const cj = communities.get(neighbor)!;

      if (ci === cj) {
        q += weight - (ki * kj) / (2 * m);
      }
    }
  }

  return q / (2 * m);
}

/**
 * Calculate modularity gain from moving a node to a community.
 */
function modularityGain(
  totalWeight: number,
  targetCommunity: Community,
  nodeDegree: number,
  nodeToTargetWeight: number,
): number {
  const m = totalWeight;
  if (m === 0) return 0;

  // ΔQ = [Σ_in + k_i,in] / 2m - [(Σ_tot + k_i) / 2m]²
  //    - [Σ_in / 2m - (Σ_tot / 2m)² - (k_i / 2m)²]

  const sigmaIn = targetCommunity.internalWeight;
  const sigmaTot = targetCommunity.totalDegree;
  const ki = nodeDegree;
  const kiIn = nodeToTargetWeight;

  const before = sigmaIn / (2 * m) - Math.pow(sigmaTot / (2 * m), 2) - Math.pow(ki / (2 * m), 2);
  const after = (sigmaIn + 2 * kiIn) / (2 * m) - Math.pow((sigmaTot + ki) / (2 * m), 2);

  return after - before;
}

/**
 * Louvain community detection algorithm.
 */
function louvainCommunityDetection(
  graph: Graph,
  resolution: number = 1.0,
  minModularityGain: number = 0.0001,
): Map<number, number> {
  // Initialize: each node in its own community
  const nodeToCommunity = new Map<number, number>();
  const communities = new Map<number, Community>();

  // Sort nodes for deterministic iteration order
  const sortedNodes = Array.from(graph.nodes).sort((a, b) => a - b);

  let communityId = 0;
  for (const node of sortedNodes) {
    const degree = getNodeDegree(graph, node);
    const community: Community = {
      id: communityId,
      members: new Set([node]),
      internalWeight: 0, // No internal edges for single-node community
      totalDegree: degree,
    };
    nodeToCommunity.set(node, communityId);
    communities.set(communityId, community);
    communityId++;
  }

  let improved = true;
  let iterations = 0;
  const maxIterations = 100;

  while (improved && iterations < maxIterations) {
    improved = false;
    iterations++;

    for (const node of sortedNodes) {
      const currentCommunityId = nodeToCommunity.get(node)!;
      const currentCommunity = communities.get(currentCommunityId)!;
      const nodeDegree = getNodeDegree(graph, node);

      // Calculate weight to each neighboring community
      const neighborCommunityWeights = new Map<number, number>();
      const neighbors = graph.edges.get(node);

      if (neighbors) {
        for (const [neighbor, weight] of neighbors) {
          const neighborCommunityId = nodeToCommunity.get(neighbor)!;
          const existing = neighborCommunityWeights.get(neighborCommunityId) ?? 0;
          neighborCommunityWeights.set(neighborCommunityId, existing + weight);
        }
      }

      // Find best community to move to
      let bestCommunityId = currentCommunityId;
      let bestGain = 0;

      // First, remove node from current community temporarily
      const nodeWeightToCurrent = neighborCommunityWeights.get(currentCommunityId) ?? 0;

      for (const [targetCommunityId, weightToTarget] of neighborCommunityWeights) {
        if (targetCommunityId === currentCommunityId) continue;

        const targetCommunity = communities.get(targetCommunityId)!;
        const gain = modularityGain(graph.totalWeight, targetCommunity, nodeDegree, weightToTarget) * resolution;

        // Subtract the loss from leaving current community
        const lossCurrent = modularityGain(graph.totalWeight, currentCommunity, nodeDegree, nodeWeightToCurrent) * resolution;

        const netGain = gain - lossCurrent;

        if (netGain > bestGain + minModularityGain) {
          bestGain = netGain;
          bestCommunityId = targetCommunityId;
        }
      }

      // Move node if we found a better community
      if (bestCommunityId !== currentCommunityId) {
        improved = true;

        // Remove from current community
        currentCommunity.members.delete(node);
        currentCommunity.totalDegree -= nodeDegree;
        currentCommunity.internalWeight -= 2 * nodeWeightToCurrent;

        // Add to new community
        const newCommunity = communities.get(bestCommunityId)!;
        const nodeWeightToNew = neighborCommunityWeights.get(bestCommunityId) ?? 0;
        newCommunity.members.add(node);
        newCommunity.totalDegree += nodeDegree;
        newCommunity.internalWeight += 2 * nodeWeightToNew;

        nodeToCommunity.set(node, bestCommunityId);

        // Clean up empty communities
        if (currentCommunity.members.size === 0) {
          communities.delete(currentCommunityId);
        }
      }
    }
  }

  return nodeToCommunity;
}

/**
 * Filter communities by minimum size.
 */
function filterCommunities(
  nodeToCommunity: Map<number, number>,
  minSize: number,
): Map<number, Set<number>> {
  const communities = new Map<number, Set<number>>();

  for (const [node, communityId] of nodeToCommunity) {
    if (!communities.has(communityId)) {
      communities.set(communityId, new Set());
    }
    communities.get(communityId)!.add(node);
  }

  // Filter by minimum size
  const filtered = new Map<number, Set<number>>();
  for (const [id, members] of communities) {
    if (members.size >= minSize) {
      filtered.set(id, members);
    }
  }

  return filtered;
}

interface ParsedModuleAnnotation {
  moduleId: number;
  name: string;
  layer: ModuleLayer | null;
  subsystem: string | null;
  description: string;
}

/**
 * Parse LLM response for module annotations.
 */
function parseModuleAnnotations(response: string): ParsedModuleAnnotation[] {
  const annotations: ParsedModuleAnnotation[] = [];

  // Look for CSV-like format
  const lines = response.split('\n');
  let inCsv = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('module_id,') || trimmed.startsWith('```csv')) {
      inCsv = true;
      continue;
    }

    if (trimmed === '```' && inCsv) {
      break;
    }

    if (inCsv && trimmed && !trimmed.startsWith('module_id')) {
      // Parse CSV line: module_id,name,layer,subsystem,description
      const match = trimmed.match(/^(\d+),([^,]+),([^,]*),([^,]*),(.*)$/);
      if (match) {
        const layer = match[3].trim().toLowerCase();
        const validLayers: ModuleLayer[] = ['controller', 'service', 'repository', 'adapter', 'utility'];

        annotations.push({
          moduleId: parseInt(match[1], 10),
          name: match[2].trim(),
          layer: validLayers.includes(layer as ModuleLayer) ? (layer as ModuleLayer) : null,
          subsystem: match[4].trim() || null,
          description: match[5].trim().replace(/^"|"$/g, ''),
        });
      }
    }
  }

  return annotations;
}

export default class Modules extends Command {
  static override description = 'Detect module boundaries using community detection on the call graph';

  static override examples = [
    '<%= config.bin %> llm modules',
    '<%= config.bin %> llm modules --min-size 5',
    '<%= config.bin %> llm modules --resolution 1.5 --dry-run',
    '<%= config.bin %> llm modules --force',
  ];

  static override flags = {
    database: SharedFlags.database,
    'min-size': Flags.integer({
      description: 'Minimum members per module',
      default: 3,
    }),
    resolution: Flags.string({
      description: 'Louvain resolution parameter (higher = smaller modules)',
      default: '1.0',
    }),
    'dry-run': Flags.boolean({
      description: 'Show detected modules without persisting',
      default: false,
    }),
    force: Flags.boolean({
      description: 'Re-detect even if modules exist',
      default: false,
    }),
    model: Flags.string({
      char: 'm',
      description: 'LLM model alias for module naming',
      default: 'sonnet',
    }),
    'skip-llm': Flags.boolean({
      description: 'Skip LLM naming pass (just do community detection)',
      default: false,
    }),
    json: SharedFlags.json,
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Modules);

    const db = await openDatabase(flags.database, this);
    const dryRun = flags['dry-run'];
    const minSize = flags['min-size'];
    const resolution = parseFloat(flags.resolution);
    const isJson = flags.json;
    const skipLlm = flags['skip-llm'];

    try {
      // Check if modules already exist
      const existingModuleCount = db.getModuleCount();
      if (existingModuleCount > 0 && !flags.force) {
        if (isJson) {
          this.log(JSON.stringify({
            error: 'Modules already exist',
            moduleCount: existingModuleCount,
            hint: 'Use --force to re-detect',
          }));
        } else {
          this.log(chalk.yellow(`${existingModuleCount} modules already exist.`));
          this.log(chalk.gray('Use --force to re-detect modules.'));
        }
        return;
      }

      if (!isJson) {
        this.log(chalk.bold('Module Detection'));
        this.log(chalk.gray(`Resolution: ${resolution}, Min size: ${minSize}`));
        this.log('');
      }

      // Step 1: Extract call graph
      if (!isJson) {
        this.log('Extracting call graph...');
      }
      const edges = db.getCallGraph();

      if (edges.length === 0) {
        if (isJson) {
          this.log(JSON.stringify({ error: 'No call graph edges found' }));
        } else {
          this.log(chalk.yellow('No call graph edges found.'));
        }
        return;
      }

      if (!isJson) {
        this.log(chalk.gray(`  Found ${edges.length} edges`));
      }

      // Step 2: Build graph and run Louvain
      if (!isJson) {
        this.log('Running community detection...');
      }
      const graph = buildGraph(edges);
      const nodeToCommunity = louvainCommunityDetection(graph, resolution);

      // Calculate modularity
      const modularity = calculateModularity(graph, nodeToCommunity);

      // Filter by size
      const communities = filterCommunities(nodeToCommunity, minSize);

      if (!isJson) {
        this.log(chalk.gray(`  Modularity score: ${modularity.toFixed(4)}`));
        this.log(chalk.gray(`  Detected ${communities.size} modules (>= ${minSize} members)`));
      }

      if (communities.size === 0) {
        if (isJson) {
          this.log(JSON.stringify({
            modularity,
            modules: [],
            message: 'No modules detected above minimum size',
          }));
        } else {
          this.log(chalk.yellow('No modules detected above minimum size.'));
        }
        return;
      }

      // Step 3: Build module candidates with metadata
      const candidates: ModuleCandidate[] = [];

      for (const [communityId, members] of communities) {
        // Get definition info and metadata for each member
        const memberInfo: Array<{
          id: number;
          name: string;
          kind: string;
          filePath: string;
          domains: string[];
          role: string | null;
        }> = [];

        const domainCounts = new Map<string, number>();
        const roleCounts = new Map<string, number>();

        for (const defId of members) {
          const def = db.getDefinitionById(defId);
          if (!def) continue;

          const metadata = db.getDefinitionMetadata(defId);
          let domains: string[] = [];
          try {
            if (metadata['domain']) {
              domains = JSON.parse(metadata['domain']) as string[];
            }
          } catch { /* ignore */ }

          const role = metadata['role'] ?? null;

          memberInfo.push({
            id: defId,
            name: def.name,
            kind: def.kind,
            filePath: def.filePath,
            domains,
            role,
          });

          // Count domains and roles
          for (const d of domains) {
            domainCounts.set(d, (domainCounts.get(d) ?? 0) + 1);
          }
          if (role) {
            roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
          }
        }

        // Get dominant domains and roles
        const dominantDomains = Array.from(domainCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([d]) => d);

        const dominantRoles = Array.from(roleCounts.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([r]) => r);

        // Calculate cohesion (internal edges / total possible edges)
        let internalEdges = 0;
        for (const m1 of members) {
          const neighbors = graph.edges.get(m1);
          if (neighbors) {
            for (const m2 of members) {
              if (m1 !== m2 && neighbors.has(m2)) {
                internalEdges += neighbors.get(m2)!;
              }
            }
          }
        }
        internalEdges = internalEdges / 2; // Counted twice

        // Count external edges
        let externalEdges = 0;
        for (const m of members) {
          const neighbors = graph.edges.get(m);
          if (neighbors) {
            for (const [neighbor, weight] of neighbors) {
              if (!members.has(neighbor)) {
                externalEdges += weight;
              }
            }
          }
        }

        candidates.push({
          id: communityId,
          members: memberInfo,
          internalEdges,
          externalEdges,
          dominantDomains,
          dominantRoles,
        });
      }

      // Sort by size descending
      candidates.sort((a, b) => b.members.length - a.members.length);

      // Step 4: LLM naming pass (if not skipped)
      let annotations: ParsedModuleAnnotation[] = [];

      if (!skipLlm) {
        if (!isJson) {
          this.log('Generating module names with LLM...');
        }

        const systemPrompt = buildModuleSystemPrompt();
        const userPrompt = buildModuleUserPrompt(candidates);

        try {
          const response = await LLMist.complete(userPrompt, {
            model: flags.model,
            systemPrompt,
            temperature: 0,
          });

          annotations = parseModuleAnnotations(response);

          if (!isJson && annotations.length > 0) {
            this.log(chalk.gray(`  Named ${annotations.length} modules`));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!isJson) {
            this.log(chalk.yellow(`  LLM naming failed: ${message}`));
            this.log(chalk.gray('  Using auto-generated names'));
          }
        }
      }

      // Step 5: Persist or display
      if (dryRun) {
        if (isJson) {
          this.log(JSON.stringify({
            modularity,
            moduleCount: candidates.length,
            modules: candidates.map((c, i) => {
              const annotation = annotations.find(a => a.moduleId === c.id);
              return {
                id: c.id,
                name: annotation?.name ?? `Module_${i + 1}`,
                layer: annotation?.layer ?? null,
                subsystem: annotation?.subsystem ?? null,
                description: annotation?.description ?? null,
                memberCount: c.members.length,
                internalEdges: c.internalEdges,
                externalEdges: c.externalEdges,
                dominantDomains: c.dominantDomains,
                dominantRoles: c.dominantRoles,
                members: c.members.map(m => ({ id: m.id, name: m.name, kind: m.kind })),
              };
            }),
          }, null, 2));
        } else {
          this.log('');
          this.log(chalk.bold('Detected Modules (dry run)'));
          this.log(chalk.gray(`Modularity: ${modularity.toFixed(4)}`));
          this.log('');

          for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            const annotation = annotations.find(a => a.moduleId === c.id);
            const name = annotation?.name ?? `Module_${i + 1}`;
            const layer = annotation?.layer ?? 'unknown';
            const subsystem = annotation?.subsystem ?? '-';

            this.log(chalk.bold(`${name}`));
            this.log(chalk.gray(`  Layer: ${layer}, Subsystem: ${subsystem}`));
            this.log(chalk.gray(`  Members: ${c.members.length}, Internal edges: ${c.internalEdges}, External edges: ${c.externalEdges}`));
            if (c.dominantDomains.length > 0) {
              this.log(chalk.gray(`  Domains: ${c.dominantDomains.join(', ')}`));
            }
            if (annotation?.description) {
              this.log(chalk.gray(`  ${annotation.description}`));
            }
            this.log(chalk.gray(`  Members: ${c.members.map(m => m.name).join(', ')}`));
            this.log('');
          }
        }
      } else {
        // Clear existing modules if force
        if (existingModuleCount > 0 && flags.force) {
          db.clearModules();
          if (!isJson) {
            this.log(chalk.gray(`  Cleared ${existingModuleCount} existing modules`));
          }
        }

        // Insert modules
        for (let i = 0; i < candidates.length; i++) {
          const c = candidates[i];
          const annotation = annotations.find(a => a.moduleId === c.id);
          const name = annotation?.name ?? `Module_${i + 1}`;

          // Use LLM layer, fall back to inference from dominant roles
          const layer = annotation?.layer ?? inferLayerFromRoles(c.dominantRoles);

          const moduleId = db.insertModule(name, {
            description: annotation?.description,
            layer,
            subsystem: annotation?.subsystem ?? undefined,
          });

          // Add members with cohesion based on internal connectivity
          const avgInternalDegree = c.members.length > 1
            ? (c.internalEdges * 2) / c.members.length
            : 0;

          const memberIds = new Set(c.members.map(m => m.id));

          for (const member of c.members) {
            // Calculate member's internal and external degree
            let memberInternalDegree = 0;
            let memberExternalEdges = 0;
            const neighbors = graph.edges.get(member.id);
            if (neighbors) {
              for (const [neighborId, weight] of neighbors) {
                if (memberIds.has(neighborId)) {
                  memberInternalDegree += weight;
                } else {
                  memberExternalEdges += weight;
                }
              }
            }

            // Cohesion calculation
            let cohesion: number;
            if (c.members.length === 1) {
              // For single-node modules: isolated = high cohesion, connected externally = low
              cohesion = memberExternalEdges > 0 ? 0.0 : 1.0;
            } else {
              // For multi-node modules: based on internal connectivity ratio
              cohesion = avgInternalDegree > 0
                ? Math.min(1.0, memberInternalDegree / avgInternalDegree)
                : 0.0;
            }

            db.addModuleMember(moduleId, member.id, cohesion);
          }
        }

        if (isJson) {
          const stats = db.getModuleStats();
          this.log(JSON.stringify({
            modularity,
            ...stats,
          }));
        } else {
          const stats = db.getModuleStats();
          this.log('');
          this.log(chalk.green(`Created ${stats.moduleCount} modules`));
          this.log(chalk.gray(`  Total members: ${stats.memberCount}`));
          this.log(chalk.gray(`  Avg members per module: ${stats.avgMembersPerModule.toFixed(1)}`));
          this.log(chalk.gray(`  Unassigned definitions: ${stats.unassignedDefinitions}`));
          this.log(chalk.gray(`  Modularity score: ${modularity.toFixed(4)}`));
        }
      }
    } finally {
      db.close();
    }
  }
}
