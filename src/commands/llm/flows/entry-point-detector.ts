/**
 * EntryPointDetector - LLM-based entry point module classification.
 * Identifies modules and their members that serve as entry points for user flows.
 */

import type { Command } from '@oclif/core';
import type { IndexDatabase } from '../../../db/database.js';
import type { EnrichedModuleCallEdge, RelationshipWithDetails } from '../../../db/schema.js';
import { parseRow } from '../_shared/csv-utils.js';
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

/** AST kinds that represent callable/behavioral code (not type-only definitions). */
const CALLABLE_KINDS = new Set(['function', 'class', 'const', 'variable', 'method']);

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
    const allModulesWithMembers = this.db.modules.getAllWithMembers();

    // Build module candidates (only modules with members, skip test modules)
    const candidates: ModuleCandidate[] = [];
    for (const mod of allModulesWithMembers) {
      if (mod.members.length === 0) continue;
      if (mod.isTest) continue; // Test modules are never entry points

      // Skip modules where ALL members are type-only (no callable code)
      const hasCallableMembers = mod.members.some((m) => CALLABLE_KINDS.has(m.kind));
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

    return this.buildEntryPointModules(classifications, candidates, true);
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
    const interactions = this.db.callGraph.getEnrichedModuleCallGraph();
    const relationships = this.db.relationships.getAll({ limit: 200 });

    // Identify modules behind HTTP boundaries (targets of inferred/contract-matched interactions)
    const allInteractions = this.db.interactions.getAll();
    const behindBoundaryModuleIds = new Set<number>();
    for (const interaction of allInteractions) {
      if (interaction.source === 'llm-inferred' || interaction.source === 'contract-matched') {
        behindBoundaryModuleIds.add(interaction.toModuleId);
      }
    }

    const systemPrompt = this.buildClassificationSystemPrompt();
    const moduleList = this.buildModuleContext(candidates, behindBoundaryModuleIds);
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

    const parsed = this.parseMemberClassificationCSV(response, candidates);
    return this.backfillMissingViewActions(parsed, candidates);
  }

  /**
   * Structural backfill: if a module has mutation entry points (create/update/delete)
   * but NO view entry point, add a view entry for the first mutation entry point.
   * This ensures every page with CRUD actions also gets a view flow traced.
   */
  backfillMissingViewActions(
    classifications: MemberClassification[],
    _candidates: ModuleCandidate[]
  ): MemberClassification[] {
    // Group classifications by module
    const byModule = new Map<number, MemberClassification[]>();
    for (const mc of classifications) {
      const list = byModule.get(mc.moduleId) ?? [];
      list.push(mc);
      byModule.set(mc.moduleId, list);
    }

    const additions: MemberClassification[] = [];

    for (const [moduleId, mcs] of byModule) {
      // Must have at least one entry-point mutation action (not view/process)
      const hasMutation = mcs.some(
        (mc) => mc.isEntryPoint && mc.actionType && mc.actionType !== 'view' && mc.actionType !== 'process'
      );
      if (!hasMutation) continue;

      // Must NOT already have a view action
      const hasViewAction = mcs.some((mc) => mc.isEntryPoint && mc.actionType === 'view');
      if (hasViewAction) continue;

      // Backfill: add a view entry for the first mutation entry point
      const primaryEp = mcs.find((mc) => mc.isEntryPoint && mc.actionType !== 'view');
      if (!primaryEp) continue;

      additions.push({
        moduleId,
        memberName: primaryEp.memberName,
        isEntryPoint: true,
        actionType: 'view',
        targetEntity: primaryEp.targetEntity,
        stakeholder: primaryEp.stakeholder ?? 'user',
        traceFromDefinition: null, // view traces from the page/definition itself
        reason: 'Backfill: entry point has mutations but no view action',
      });
    }

    return [...classifications, ...additions];
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

Key insight: A screen component like "ItemList" may call hooks like "useCreateItem", "useDeleteItem". These represent separate user actions even though they're not direct members of the screen module.

## Action Type Guidelines
- **view**: Displays data - list views, detail views, dashboards
- **create**: Adds new records - uses hooks/services with "create", "add", "new"
- **update**: Modifies existing - uses hooks/services with "update", "edit", "save"
- **delete**: Removes records - uses hooks/services with "delete", "remove"
- **process**: Non-CRUD - login, logout, sync, export

## Stakeholder Guidelines
Classify who initiates the action:
- **user**: End-user facing UI (screens, pages, components)
- **admin**: Admin panels, back-office tools
- **system**: Background jobs, cron tasks, workers, event handlers
- **developer**: CLI commands, dev tools, scripts
- **external**: API endpoints consumed by external clients/services

## CRITICAL: List vs Detail View Distinction
When a codebase has SEPARATE components for list views and detail views of the same entity,
you MUST differentiate them using the target_entity column:
- List views: target_entity = "{entity}-list" (e.g., "vehicle-list")
- Detail views: target_entity = "{entity}-detail" (e.g., "vehicle-detail")

How to identify:
- LIST view: component displays multiple records, fetches collections
- DETAIL view: component displays a single record, fetches by ID

When BOTH patterns exist for the same entity, emit different target_entity values.
If only ONE view type exists (no separate list/detail), use the plain entity name.

## CRITICAL: Backend API Endpoints
Modules marked with ⚠️ are backend API endpoints reached from frontend via HTTP.
These modules ARE entry points — they serve as the boundary of a separately deployable backend.
Classify them as:
- is_entry_point=true (ALWAYS — they handle incoming HTTP requests)
- stakeholder="external" (NOT "user" — they serve external API clients or frontends)

Frontend flows trace frontend→backend boundary crossings.
Backend entry point flows trace the backend's OWN internal chain (controller→service→repository).
Both are needed for complete flow coverage.

## CRITICAL: Backend API List vs Detail Endpoints
For backend controller/route modules, distinguish list and detail operations:
- getAll, findAll, list, index → action_type="view", target_entity="{entity}-list"
- getById, findById, findOne, show, get (with ID param) → action_type="view", target_entity="{entity}-detail"
- getStats, getReport, etc. → action_type="view", target_entity="{entity}"

Example for a backend controller module with members [getAll, getById, create, update, delete]:
\`\`\`csv
55,getAll,true,view,vehicle-list,external,,Lists all vehicles
55,getById,true,view,vehicle-detail,external,,Gets single vehicle by ID
55,create,true,create,vehicle,external,,Creates new vehicle
55,update,true,update,vehicle,external,,Updates existing vehicle
55,delete,true,delete,vehicle,external,,Deletes vehicle
\`\`\`

## CRITICAL: Multi-Action Detection
For EACH entry point module, examine ALL its outgoing calls in the Interactions section.
If a page/screen calls mutation hooks (create, update, delete), it has MULTIPLE action types.
You MUST emit a SEPARATE ROW for each action type.
The trace_from column tells us which specific hook to follow for each action.

Missing even one action type means an entire user flow goes undetected.

## CRITICAL: Every Page/Screen MUST Have a View Action
If a screen/page module is classified as an entry point (for any action type), it MUST also
have at least one "view" action row. Every page renders data — that is a view action.
If the page shows a list, use target_entity="{entity}-list".
If it shows a single record, use target_entity="{entity}-detail".
Do NOT omit the view action just because mutation actions are present.

## Output Format
\`\`\`csv
module_id,member_name,is_entry_point,action_type,target_entity,stakeholder,trace_from,reason
42,ItemList,true,view,item-list,user,,"Displays item list (multiple records)"
42,ItemList,true,create,item,user,useCreateItem,"Calls useCreateItem hook for new items"
42,ItemList,true,update,item,user,useUpdateItem,"Calls useUpdateItem hook"
42,ItemList,true,delete,item,user,useDeleteItem,"Calls useDeleteItem hook"
43,ItemDetails,true,view,item-detail,user,,"Single item detail view (fetches by ID)"
44,OrderPage,true,view,order,user,,"Only view for orders (no separate list/detail)"
\`\`\`

The trace_from column specifies which callee/hook to start tracing from for each action type.
For "view" actions, leave trace_from empty (trace from the page itself).
For mutations, name the specific hook or function that performs the mutation.

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

  private buildModuleContext(candidates: ModuleCandidate[], behindBoundaryModuleIds?: Set<number>): string {
    return candidates
      .map((m) => {
        let desc = `## Module ${m.id}: ${m.fullPath}`;
        if (m.description) desc += `\nDescription: ${m.description}`;
        desc += `\nName: ${m.name}`;
        if (behindBoundaryModuleIds?.has(m.id)) {
          desc += '\n⚠️ This module is a BACKEND API endpoint (reached via HTTP from frontend modules)';
        }
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

    const validActions: ActionType[] = ['view', 'create', 'update', 'delete', 'process'];
    const validStakeholders = ['user', 'admin', 'system', 'developer', 'external'] as const;

    for (const line of lines) {
      const fields = parseRow(line);
      if (!fields || fields.length < 6) continue;

      const moduleId = Number.parseInt(fields[0].trim(), 10);
      if (!candidateMap.has(moduleId)) continue;

      const memberName = fields[1].trim();
      const isEntryPoint = fields[2].trim().toLowerCase() === 'true';
      const actionTypeRaw = fields[3].trim().toLowerCase();
      const targetEntity = fields[4].trim() || null;

      // Parse stakeholder, trace_from, and reason columns.
      // Support formats:
      //   6 cols: module_id, member_name, is_entry_point, action_type, target_entity, reason
      //   7 cols: module_id, member_name, is_entry_point, action_type, target_entity, stakeholder, reason
      //   8 cols: module_id, member_name, is_entry_point, action_type, target_entity, stakeholder, trace_from, reason
      let stakeholderRaw: string | null = null;
      let traceFromDefinition: string | null = null;
      let reason: string;
      if (fields.length >= 8) {
        stakeholderRaw = fields[5].trim().toLowerCase();
        traceFromDefinition = fields[6].trim() || null;
        reason = fields[7].trim().replace(/"/g, '');
      } else if (fields.length >= 7) {
        stakeholderRaw = fields[5].trim().toLowerCase();
        reason = fields[6].trim().replace(/"/g, '');
      } else {
        reason = fields[5].trim().replace(/"/g, '');
      }

      const actionType = validActions.includes(actionTypeRaw as ActionType) ? (actionTypeRaw as ActionType) : null;
      const stakeholder =
        stakeholderRaw && validStakeholders.includes(stakeholderRaw as (typeof validStakeholders)[number])
          ? (stakeholderRaw as (typeof validStakeholders)[number])
          : null;

      results.push({
        moduleId,
        memberName,
        isEntryPoint,
        actionType,
        targetEntity: targetEntity || null,
        stakeholder,
        traceFromDefinition,
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
            stakeholder: null,
            traceFromDefinition: null,
            reason: 'Not in LLM response, using heuristic',
          });
        }
      }
    }

    return results;
  }

  private inferMemberActionType(
    memberName: string,
    _modulePath: string
  ): { actionType: ActionType | null; targetEntity: string | null } {
    const name = memberName.toLowerCase();

    let actionType: ActionType | null = null;
    if (name.includes('create') || name.includes('add') || name.includes('new') || name.includes('insert')) {
      actionType = 'create';
    } else if (
      name.includes('update') ||
      name.includes('edit') ||
      name.includes('modify') ||
      name.includes('save') ||
      name.includes('patch')
    ) {
      actionType = 'update';
    } else if (name.includes('delete') || name.includes('remove') || name.includes('destroy')) {
      actionType = 'delete';
    } else if (
      name.includes('list') ||
      name.includes('view') ||
      name.includes('show') ||
      name.includes('fetch') ||
      name.includes('load')
    ) {
      actionType = 'view';
    } else if (
      name.includes('login') ||
      name.includes('logout') ||
      name.includes('auth') ||
      name.includes('process') ||
      name.includes('sync') ||
      name.includes('middleware') ||
      name.includes('handler') ||
      name.includes('submit') ||
      name.includes('send') ||
      name.includes('export') ||
      name.includes('import')
    ) {
      actionType = 'process';
    }

    // Don't guess entity from hardcoded patterns — let LLM classify it
    return { actionType, targetEntity: null };
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
    candidates: ModuleCandidate[],
    supplementContractHandlers = false
  ): EntryPointModuleInfo[] {
    // Deterministic contract-handler supplement:
    // Ensure modules containing contract handler definitions are always entry points
    let contractHandlerDefIds: Set<number> | null = null;
    if (supplementContractHandlers) {
      try {
        const allDefLinks = this.db.interactions.getAllDefinitionLinks();
        contractHandlerDefIds = new Set(allDefLinks.map((l) => l.toDefinitionId));

        // Force modules containing contract handlers to be entry points
        const candidateMap = new Map(candidates.map((c) => [c.id, c]));
        for (const classification of classifications) {
          if (classification.isEntryPoint) continue;
          const mod = candidateMap.get(classification.moduleId);
          if (!mod) continue;
          const hasContractHandler = mod.members.some((m) => contractHandlerDefIds!.has(m.definitionId));
          if (hasContractHandler) {
            classification.isEntryPoint = true;
          }
        }
      } catch {
        // Table may not exist — skip supplement
      }
    }

    const entryPointModules: EntryPointModuleInfo[] = [];

    for (const classification of classifications) {
      if (!classification.isEntryPoint) continue;

      const mod = candidates.find((c) => c.id === classification.moduleId);
      if (!mod) continue;

      const moduleClassifications = this.memberClassifications.filter(
        (mc) => mc.moduleId === mod.id && mc.isEntryPoint
      );

      const memberDefinitions: EntryPointModuleInfo['memberDefinitions'] = [];
      const addedMemberNames = new Set<string>();

      for (const mc of moduleClassifications) {
        const member = mod.members.find((m) => m.name === mc.memberName);
        if (member && CALLABLE_KINDS.has(member.kind)) {
          memberDefinitions.push({
            id: member.definitionId,
            name: member.name,
            kind: member.kind,
            actionType: mc.actionType,
            targetEntity: mc.targetEntity,
            stakeholder: mc.stakeholder,
            traceFromDefinition: mc.traceFromDefinition,
          });
          addedMemberNames.add(member.name);
        }
      }

      // Supplement: add contract handler members that LLM didn't classify as entry points
      if (contractHandlerDefIds) {
        for (const member of mod.members) {
          if (addedMemberNames.has(member.name)) continue;
          if (!contractHandlerDefIds.has(member.definitionId)) continue;

          const inferred = this.inferMemberActionType(member.name, mod.fullPath);
          memberDefinitions.push({
            id: member.definitionId,
            name: member.name,
            kind: member.kind,
            actionType: inferred.actionType,
            targetEntity: inferred.targetEntity,
            stakeholder: 'external',
            traceFromDefinition: null,
          });
          addedMemberNames.add(member.name);
        }
      }

      // For members without any classification, add them with null action type (only callable kinds)
      for (const member of mod.members) {
        if (addedMemberNames.has(member.name)) continue;
        if (!CALLABLE_KINDS.has(member.kind)) continue;
        const hasClassification = moduleClassifications.some((mc) => mc.memberName === member.name);
        if (!hasClassification) {
          memberDefinitions.push({
            id: member.definitionId,
            name: member.name,
            kind: member.kind,
            actionType: null,
            targetEntity: null,
            stakeholder: null,
            traceFromDefinition: null,
          });
          addedMemberNames.add(member.name);
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
