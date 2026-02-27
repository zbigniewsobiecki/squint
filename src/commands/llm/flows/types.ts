/**
 * Shared types for the flows module.
 */

import type { FlowStakeholder } from '../../../db/schema.js';

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
  stakeholder: FlowStakeholder | null;
  traceFromDefinition: string | null;
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
    stakeholder: FlowStakeholder | null;
    traceFromDefinition: string | null;
  }>;
}

export interface TracedDefinitionStep {
  fromDefinitionId: number;
  toDefinitionId: number;
  fromModuleId: number | null;
  toModuleId: number | null;
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
  actionType: ActionType | null;
  targetEntity: string | null;
  tier: 1 | 2;
  subflowSlugs: string[];
}

export interface DefinitionEnrichmentContext {
  definitionCallGraph: Map<number, number[]>;
  defToModule: Map<number, { moduleId: number; modulePath: string }>;
  moduleToDefIds: Map<number, number[]>;
  definitionBridgeMap: Map<
    number,
    Array<{
      interactionId: number;
      toDefinitionId: number;
      toModuleId: number;
      source: 'llm-inferred' | 'contract-matched';
    }>
  >;
}

export interface InteractionSummary {
  id: number;
  fromModuleId: number;
  toModuleId: number;
  fromModulePath: string;
  toModulePath: string;
  source: string;
  semantic: string | null;
  weight: number;
}

export interface LlmOptions {
  showLlmRequests: boolean;
  showLlmResponses: boolean;
}
