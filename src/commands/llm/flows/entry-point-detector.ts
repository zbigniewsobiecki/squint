/**
 * EntryPointDetector - LLM-based entry point module classification.
 * Identifies modules and their members that serve as entry points for user flows.
 */

import type { Command } from '@oclif/core';
import type { IndexDatabase } from '../../../db/database.js';
import type { EnrichedModuleCallEdge, RelationshipWithDetails } from '../../../db/schema.js';
import { parseCSVLine } from '../_shared/csv-utils.js';
import {
  type LlmLogOptions,
  completeWithLogging,
  getErrorMessage,
  logLlmRequest,
  logLlmResponse,
  logVerbose,
  logWarning,
} from '../_shared/llm-utils.js';
import type {
  ActionType,
  EntryPointModuleClassification,
  EntryPointModuleInfo,
  LlmOptions,
  MemberClassification,
  ModuleCandidate,
} from './types.js';

export class EntryPointDetector {
  private memberClassifications: MemberClassification[] = [];

  constructor(
    private readonly db: IndexDatabase,
    private readonly command: Command,
    private readonly isJson: boolean,
    private readonly verbose: boolean
  ) {}

  /**
   * Detect entry point modules using LLM classification.
   */
  async detectEntryPointModules(model: string, llmOptions: LlmOptions): Promise<EntryPointModuleInfo[]> {
    const allModulesWithMembers = this.db.getAllModulesWithMembers();

    // Build module candidates (only modules with members, skip test modules)
    const candidates: ModuleCandidate[] = [];
    for (const mod of allModulesWithMembers) {
      if (mod.members.length === 0) continue;
      if (mod.isTest) continue; // Test modules are never entry points

      // Skip modules where ALL members are type-only (no callable code)
      const callableKinds = new Set(['function', 'class', 'const', 'variable', 'method']);
      const hasCallableMembers = mod.members.some(m => callableKinds.has(m.kind));
      if (!hasCallableMembers) continue;

      candidates.push({
        id: mod.id,
        fullPath: mod.fullPath,
        name: mod.name,
        description: mod.description,
        depth: mod.depth,
        memberCount: mod.members.length,
        members: mod.members.map((m) => ({
          definitionId: m.definitionId,
          name: m.name,
          kind: m.kind,
        })),
      });
    }

    if (candidates.length === 0) {
      return [];
    }

    // Classify with LLM
    let classifications: EntryPointModuleClassification[];
    try {
      classifications = await this.classifyModulesAsEntryPoints(candidates, model, llmOptions);
      logVerbose(
        this.command,
        `  LLM classified ${classifications.filter((c) => c.isEntryPoint).length}/${candidates.length} modules as entry points`,
        this.verbose,
        this.isJson
      );
    } catch (error) {
      const message = getErrorMessage(error);
      logWarning(this.command, `  LLM classification failed: ${message}`, this.isJson);
      if (!this.isJson) {
        this.command.log('  Falling back to heuristic detection');
      }
      classifications = candidates.map((c) => ({
        moduleId: c.id,
        isEntryPoint: this.isLikelyEntryPointModuleHeuristic(c),
        confidence: 'low' as const,
        reason: 'Heuristic fallback',
      }));
    }

    return this.buildEntryPointModules(classifications, candidates);
  }

  /**
   * Get stored member classifications (available after detectEntryPointModules is called).
   */
  getMemberClassifications(): MemberClassification[] {
    return this.memberClassifications;
  }

  /**
   * Use LLM to classify modules and their member functions for user journey detection.
   */
  private async classifyModulesAsEntryPoints(
    candidates: ModuleCandidate[],
    model: string,
    llmOptions: LlmOptions
  ): Promise<EntryPointModuleClassification[]> {
    const memberClassifications = await this.classifyModuleMembers(candidates, model, llmOptions);
    this.memberClassifications = memberClassifications;

    // Aggregate: a module is an entry point if ANY member is an entry point
    const moduleEntryStatus = new Map<number, { isEntry: boolean; reason: string }>();
    for (const mc of memberClassifications) {
      const existing = moduleEntryStatus.get(mc.moduleId);
      if (mc.isEntryPoint) {
        moduleEntryStatus.set(mc.moduleId, { isEntry: true, reason: mc.reason });
      } else if (!existing) {
        moduleEntryStatus.set(mc.moduleId, { isEntry: false, reason: mc.reason });
      }
    }

    return candidates.map((c) => {
      const status = moduleEntryStatus.get(c.id);
      return {
        moduleId: c.id,
        isEntryPoint: status?.isEntry ?? this.isLikelyEntryPointModuleHeuristic(c),
        confidence: 'medium' as const,
        reason: status?.reason ?? 'Heuristic fallback',
      };
    });
  }

  /**
   * Use LLM to classify module members with action types and target entities.
   */
  private async classifyModuleMembers(
    candidates: ModuleCandidate[],
    model: string,
    llmOptions: LlmOptions
  ): Promise<MemberClassification[]> {
    const interactions = this.db.getEnrichedModuleCallGraph();
    const relationships = this.db.getAllRelationshipAnnotations({ limit: 200 });

    const systemPrompt = this.buildClassificationSystemPrompt();
    const moduleList = this.buildModuleContext(candidates);
    const interactionList = this.buildInteractionContext(interactions, candidates);
    const relationshipList = this.buildRelationshipContext(relationships, candidates);

    const userPrompt = `## Modules (${candidates.length})
${moduleList}

## Module Interactions (which modules call which)
${interactionList || '(No interaction data available)'}

## Symbol Relationships (semantic connections)
${relationshipList || '(No relationship annotations available)'}

Identify all user-facing actions for each entry point module. A screen component may have multiple actions if it calls different hooks/mutations.`;

    const logOptions: LlmLogOptions = {
      showRequests: llmOptions.showLlmRequests,
      showResponses: llmOptions.showLlmResponses,
      isJson: this.isJson,
    };

    logLlmRequest(this.command, 'classifyModuleMembers', systemPrompt, userPrompt, logOptions);

    const response = await completeWithLogging({
      model,
      systemPrompt,
      userPrompt,
      temperature: 0,
      command: this.command,
      isJson: this.isJson,
    });

    logLlmResponse(this.command, 'classifyModuleMembers', response, logOptions);

    return this.parseMemberClassificationCSV(response, candidates);
  }

  private buildClassificationSystemPrompt(): string {
    return `You are analyzing a codebase to identify user-facing flows and their actions.

## Context Provided
You have access to:
1. **Modules** - code organization with their exported members
2. **Interactions** - which modules call which, and which specific symbols are called
3. **Relationships** - semantic descriptions of symbol-to-symbol connections

## Task
For each entry point module (screens, pages, routes, controllers), identify ALL user-facing actions including those that go through hooks/services.

Key insight: A screen component like "Customers" may call hooks like "useCreateCustomer", "useDeleteCustomer". These represent separate user actions even though they're not direct members of the screen module.

## Action Type Guidelines
- **view**: Displays data - list views, detail views, dashboards
- **create**: Adds new records - uses hooks/services with "create", "add", "new"
- **update**: Modifies existing - uses hooks/services with "update", "edit", "save"
- **delete**: Removes records - uses hooks/services with "delete", "remove"
- **process**: Non-CRUD - login, logout, sync, export

## Output Format
\`\`\`csv
module_id,member_name,is_entry_point,action_type,target_entity,reason
42,Customers,true,view,customer,"Main component displaying customer list"
42,Customers,true,create,customer,"Calls useCreateCustomer hook for new customers"
42,Customers,true,update,customer,"Calls useUpdateCustomer hook"
42,Customers,true,delete,customer,"Calls useDeleteCustomer hook"
\`\`\`

IMPORTANT: A single component can have MULTIPLE action types if it calls multiple mutation hooks.
Only mark as is_entry_point=true if it's user-initiated (UI event, API endpoint).
Internal services/utilities should be is_entry_point=false.

## CRITICAL: Test Code Exclusion
Test helpers, mock factories, test fixtures, spec runners, and test utilities are NEVER entry points.
Only production code that real end-users or external clients interact with should be classified as entry points.
If a module exists solely to support testing (generating test data, mocking services, setting up test state),
mark ALL its members as is_entry_point=false regardless of their names.

## CRITICAL: Type-Only Module Exclusion
Modules containing only interfaces, types, and enums are data structure definitions, NOT entry points.`;
  }

  private buildModuleContext(candidates: ModuleCandidate[]): string {
    return candidates
      .map((m) => {
        let desc = `## Module ${m.id}: ${m.fullPath}`;
        if (m.description) desc += `\nDescription: ${m.description}`;
        desc += `\nName: ${m.name}`;
        desc += '\nMembers:';
        for (const mem of m.members) {
          desc += `\n  - ${mem.name} (${mem.kind})`;
        }
        return desc;
      })
      .join('\n\n');
  }

  private buildInteractionContext(interactions: EnrichedModuleCallEdge[], candidates: ModuleCandidate[]): string {
    const candidateIds = new Set(candidates.map((c) => c.id));
    const relevant = interactions.filter((i) => candidateIds.has(i.fromModuleId) || candidateIds.has(i.toModuleId));

    if (relevant.length === 0) return '';

    return relevant
      .map((i) => {
        const symbols = i.calledSymbols.map((s) => s.name).join(', ');
        return `${i.fromModulePath} → ${i.toModulePath}: calls [${symbols}]`;
      })
      .join('\n');
  }

  private buildRelationshipContext(relationships: RelationshipWithDetails[], candidates: ModuleCandidate[]): string {
    const defIds = new Set(candidates.flatMap((c) => c.members.map((m) => m.definitionId)));
    const relevant = relationships.filter((r) => defIds.has(r.fromDefinitionId) || defIds.has(r.toDefinitionId));

    if (relevant.length === 0) return '';

    return relevant.map((r) => `${r.fromName} → ${r.toName}: "${r.semantic}"`).join('\n');
  }

  private parseMemberClassificationCSV(response: string, candidates: ModuleCandidate[]): MemberClassification[] {
    const results: MemberClassification[] = [];

    const csvMatch = response.match(/```csv\n([\s\S]*?)\n```/) || response.match(/```\n([\s\S]*?)\n```/);
    const csvContent = csvMatch ? csvMatch[1] : response;

    const lines = csvContent.split('\n').filter((l) => l.trim() && !l.startsWith('module_id,'));

    const candidateMap = new Map(candidates.map((c) => [c.id, c]));

    for (const line of lines) {
      const fields = parseCSVLine(line);
      if (fields.length < 6) continue;

      const moduleId = Number.parseInt(fields[0].trim(), 10);
      if (!candidateMap.has(moduleId)) continue;

      const memberName = fields[1].trim();
      const isEntryPoint = fields[2].trim().toLowerCase() === 'true';
      const actionTypeRaw = fields[3].trim().toLowerCase();
      const targetEntity = fields[4].trim() || null;
      const reason = fields[5].trim().replace(/"/g, '');

      const validActions: ActionType[] = ['view', 'create', 'update', 'delete', 'process'];
      const actionType = validActions.includes(actionTypeRaw as ActionType) ? (actionTypeRaw as ActionType) : null;

      results.push({
        moduleId,
        memberName,
        isEntryPoint,
        actionType,
        targetEntity: targetEntity || null,
        reason,
      });
    }

    // Add fallback for any members not in response
    for (const candidate of candidates) {
      for (const member of candidate.members) {
        if (!results.find((r) => r.moduleId === candidate.id && r.memberName === member.name)) {
          const inferred = this.inferMemberActionType(member.name, candidate.fullPath);
          results.push({
            moduleId: candidate.id,
            memberName: member.name,
            isEntryPoint: this.isLikelyEntryPointMemberHeuristic(member.name, candidate),
            actionType: inferred.actionType,
            targetEntity: inferred.targetEntity,
            reason: 'Not in LLM response, using heuristic',
          });
        }
      }
    }

    return results;
  }

  private inferMemberActionType(
    memberName: string,
    modulePath: string
  ): { actionType: ActionType | null; targetEntity: string | null } {
    const name = memberName.toLowerCase();
    const path = modulePath.toLowerCase();

    let actionType: ActionType | null = null;
    if (name.includes('create') || name.includes('add') || name.includes('new') || name.includes('insert')) {
      actionType = 'create';
    } else if (name.includes('update') || name.includes('edit') || name.includes('modify') || name.includes('save')) {
      actionType = 'update';
    } else if (name.includes('delete') || name.includes('remove')) {
      actionType = 'delete';
    } else if (name.includes('list') || name.includes('view') || name.includes('get') || name.includes('show')) {
      actionType = 'view';
    } else if (
      name.includes('login') ||
      name.includes('logout') ||
      name.includes('auth') ||
      name.includes('process') ||
      name.includes('sync')
    ) {
      actionType = 'process';
    }

    let targetEntity: string | null = null;
    const entityPatterns = ['customer', 'vehicle', 'sale', 'user', 'order', 'product', 'inventory', 'dashboard'];
    for (const entity of entityPatterns) {
      if (name.includes(entity) || path.includes(entity)) {
        targetEntity = entity;
        break;
      }
    }

    if (!targetEntity) {
      const pathParts = modulePath.split('.');
      const lastPart = pathParts[pathParts.length - 1]?.toLowerCase();
      if (lastPart && !['screen', 'page', 'view', 'handler', 'controller'].includes(lastPart)) {
        targetEntity = lastPart;
      }
    }

    return { actionType, targetEntity };
  }

  private isLikelyEntryPointMemberHeuristic(memberName: string, module: ModuleCandidate): boolean {
    const name = memberName.toLowerCase();
    const path = module.fullPath.toLowerCase();

    if (name.includes('handle') || name.includes('screen') || name.includes('page')) return true;
    if (name.endsWith('list') || name.endsWith('view') || name.endsWith('form')) return true;
    if (path.includes('screen') || path.includes('page') || path.includes('route')) return true;

    return false;
  }

  private isLikelyEntryPointModuleHeuristic(candidate: ModuleCandidate): boolean {
    const path = candidate.fullPath.toLowerCase();

    if (path.includes('page') || path.includes('screen') || path.includes('view')) return true;
    if (path.includes('route') || path.includes('api') || path.includes('endpoint')) return true;
    if (path.includes('handler') || path.includes('controller')) return true;
    if (path.includes('command') || path.includes('cli')) return true;
    if (path.includes('util') || path.includes('helper') || path.includes('common')) return false;
    if (path.includes('lib') || path.includes('shared') || path.includes('core')) return false;
    if (path.includes('service') || path.includes('repository') || path.includes('model')) return false;

    const memberNames = candidate.members.map((m) => m.name.toLowerCase());
    const hasHandlerLikeMember = memberNames.some(
      (n) => n.includes('handle') || n.includes('route') || n.includes('page')
    );
    if (hasHandlerLikeMember) return true;

    return false;
  }

  private buildEntryPointModules(
    classifications: EntryPointModuleClassification[],
    candidates: ModuleCandidate[]
  ): EntryPointModuleInfo[] {
    const entryPointModules: EntryPointModuleInfo[] = [];

    for (const classification of classifications) {
      if (!classification.isEntryPoint) continue;

      const mod = candidates.find((c) => c.id === classification.moduleId);
      if (!mod) continue;

      const moduleClassifications = this.memberClassifications.filter(
        (mc) => mc.moduleId === mod.id && mc.isEntryPoint
      );

      const memberDefinitions: EntryPointModuleInfo['memberDefinitions'] = [];

      for (const mc of moduleClassifications) {
        const member = mod.members.find((m) => m.name === mc.memberName);
        if (member) {
          memberDefinitions.push({
            id: member.definitionId,
            name: member.name,
            kind: member.kind,
            actionType: mc.actionType,
            targetEntity: mc.targetEntity,
          });
        }
      }

      // For members without any classification, add them with null action type
      for (const member of mod.members) {
        const hasClassification = moduleClassifications.some((mc) => mc.memberName === member.name);
        if (!hasClassification) {
          memberDefinitions.push({
            id: member.definitionId,
            name: member.name,
            kind: member.kind,
            actionType: null,
            targetEntity: null,
          });
        }
      }

      if (memberDefinitions.length > 0) {
        entryPointModules.push({
          moduleId: mod.id,
          modulePath: mod.fullPath,
          moduleName: mod.name,
          memberDefinitions,
        });
      }
    }

    return entryPointModules;
  }
}
