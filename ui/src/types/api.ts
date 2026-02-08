// Symbol graph types
export interface SymbolNode {
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
}

export interface SymbolEdge {
  source: number;
  target: number;
  semantic: string;
}

export interface SymbolGraphStats {
  totalSymbols: number;
  annotatedSymbols: number;
  totalRelationships: number;
  moduleCount: number;
}

export interface SymbolGraphResponse {
  nodes: SymbolNode[];
  edges: SymbolEdge[];
  stats: SymbolGraphStats;
}

// Module types
export interface ModuleMember {
  definitionId: number;
  name: string;
  kind: string;
  filePath: string;
  line: number;
}

export interface Module {
  id: number;
  parentId: number | null;
  slug: string;
  name: string;
  fullPath: string;
  description: string | null;
  depth: number;
  memberCount: number;
  members: ModuleMember[];
}

export interface ModulesStats {
  moduleCount: number;
  assigned: number;
  unassigned: number;
}

export interface ModulesResponse {
  modules: Module[];
  stats: ModulesStats;
}

// Interaction types
export interface Interaction {
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
}

export interface InteractionStats {
  totalCount: number;
  businessCount: number;
  utilityCount: number;
  biDirectionalCount: number;
}

export interface RelationshipCoverage {
  totalRelationships: number;
  crossModuleRelationships: number;
  relationshipsContributingToInteractions: number;
  sameModuleCount: number;
  orphanedCount: number;
  coveragePercent: number;
}

export interface InteractionsResponse {
  interactions: Interaction[];
  stats: InteractionStats;
  relationshipCoverage: RelationshipCoverage;
}

// Flow types
export interface FlowStep {
  stepOrder: number;
  fromModulePath: string;
  toModulePath: string;
  semantic: string | null;
}

export interface Flow {
  id: number;
  name: string;
  slug: string;
  entryPath: string | null;
  stakeholder: string | null;
  description: string | null;
  stepCount: number;
  steps: FlowStep[];
}

export interface FlowStats {
  flowCount: number;
  withEntryPointCount: number;
  avgStepsPerFlow: number;
}

export interface FlowCoverage {
  totalInteractions: number;
  coveredByFlows: number;
  percentage: number;
}

export interface FlowsResponse {
  flows: Flow[];
  stats: FlowStats;
  coverage: FlowCoverage;
}

// Flows DAG types
export interface DagModule {
  id: number;
  parentId: number | null;
  name: string;
  fullPath: string;
  depth: number;
  memberCount: number;
}

export interface DagEdge {
  fromModuleId: number;
  toModuleId: number;
  weight: number;
}

export interface DagFlowStep {
  interactionId: number;
  fromModuleId: number;
  toModuleId: number;
  semantic: string | null;
}

export interface DagFlow {
  id: number;
  name: string;
  stakeholder: string | null;
  stepCount: number;
  steps: DagFlowStep[];
}

export interface FlowsDagResponse {
  modules: DagModule[];
  edges: DagEdge[];
  flows: DagFlow[];
}

// Database stats types
export interface DbStats {
  files: number;
  definitions: number;
  references: number;
  imports: number;
}

// Hierarchy node for D3 visualization
export interface HierarchyNode {
  name: string;
  children?: HierarchyNode[];
  data?: SymbolNode;
  isRoot?: boolean;
  isDirectory?: boolean;
  isFile?: boolean;
  depth?: number;
  value?: number;
}

// Relationship type classification
export type RelationshipType = 'extends' | 'implements' | 'calls' | 'imports' | 'uses' | 'structure';

// Kind colors mapping
export const KIND_COLORS: Record<string, string> = {
  function: '#3d5a80',
  class: '#5a3d80',
  interface: '#3d8050',
  type: '#806a3d',
  variable: '#803d3d',
  const: '#803d3d',
  enum: '#3d6880',
  method: '#4a6670',
};

// Flow colors palette
export const FLOW_COLORS = [
  '#4fc1ff',
  '#ce9178',
  '#6a9955',
  '#c586c0',
  '#dcdcaa',
  '#9cdcfe',
  '#d7ba7d',
  '#b5cea8',
];
