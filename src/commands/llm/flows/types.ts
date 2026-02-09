/**
 * Shared types for the flows module.
 */

import type { FlowStakeholder, InteractionWithPaths } from '../../../db/schema.js';

export type ActionType = 'view' | 'create' | 'update' | 'delete' | 'process';

export interface ModuleCandidate {
  id: number;
  fullPath: string;
  name: string;
  description: string | null;
  depth: number;
  memberCount: number;
  members: Array<{ definitionId: number; name: string; kind: string }>;
}

export interface EntryPointModuleClassification {
  moduleId: number;
  isEntryPoint: boolean;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

export interface MemberClassification {
  moduleId: number;
  memberName: string;
  isEntryPoint: boolean;
  actionType: ActionType | null;
  targetEntity: string | null;
  reason: string;
}

export interface EntryPointModuleInfo {
  moduleId: number;
  modulePath: string;
  moduleName: string;
  memberDefinitions: Array<{
    id: number;
    name: string;
    kind: string;
    actionType: ActionType | null;
    targetEntity: string | null;
  }>;
}

export interface TracedDefinitionStep {
  fromDefinitionId: number;
  toDefinitionId: number;
  fromModuleId: number | null;
  toModuleId: number | null;
}

export interface InferredFlowStep {
  fromModuleId: number;
  toModuleId: number;
  source: 'llm-inferred';
}

export interface FlowSuggestion {
  name: string;
  slug: string;
  entryPointModuleId: number | null;
  entryPointId: number | null;
  entryPath: string;
  stakeholder: FlowStakeholder;
  description: string;
  interactionIds: number[];
  definitionSteps: TracedDefinitionStep[];
  inferredSteps: InferredFlowStep[];
  actionType: ActionType | null;
  targetEntity: string | null;
  tier: 0 | 1 | 2;
  subflowSlugs: string[];
}

export interface FlowTracingContext {
  definitionCallGraph: Map<number, number[]>;
  defToModule: Map<number, { moduleId: number; modulePath: string }>;
  interactionByModulePair: Map<string, number>;
  inferredFromModule: Map<number, InteractionWithPaths[]>;
  allInteractionsFromModule: Map<number, InteractionWithPaths[]>;
  moduleToDefIds: Map<number, number[]>;
}

export interface LlmOptions {
  showLlmRequests: boolean;
  showLlmResponses: boolean;
}
