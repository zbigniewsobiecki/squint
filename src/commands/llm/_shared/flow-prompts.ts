/**
 * Prompt templates for LLM-driven hierarchical flow detection.
 */

import type { AnnotatedSymbolInfo, AnnotatedEdgeInfo, FlowCoverageStats } from '../../../db/schema.js';

// ============================================
// Phase 1: Entry Point Classification
// ============================================

export function buildEntryPointSystemPrompt(): string {
  return `You are a software architect analyzing entry points in a codebase.

## Your Task
Classify each candidate entry point into one of three categories:
1. **top_level**: Entry points for top-level execution flows (HTTP handlers, CLI commands, event handlers)
2. **subflow_candidate**: Reusable logic that appears to be called by multiple entry points (validation, common operations)
3. **internal**: Internal implementation details, not suitable as flow entry points

## Output Format
Respond with **only** a CSV table:

\`\`\`csv
type,id,classification,confidence,reason
entry,42,top_level,high,"HTTP controller handling POST /users"
entry,87,subflow_candidate,medium,"Validation logic called by multiple controllers"
entry,15,internal,high,"Private helper function"
\`\`\`

## Classification Guidelines

**top_level indicators:**
- Controllers, handlers, or routes receiving external requests
- CLI command entry points
- Event handlers processing external events
- Symbols with role=controller metadata
- Names containing "Controller", "Handler", "Route"
- Exported from routes/controllers/handlers directories

**subflow_candidate indicators:**
- High incoming dependency count (called by many)
- Names suggesting reusable operations: "validate", "process", "transform"
- Pure business logic without direct external interface
- Appears in multiple execution paths

**internal indicators:**
- Private or unexported helpers
- Low connectivity (few callers)
- Utility functions with generic names
- Implementation details not representing business operations

## Confidence Levels
- **high**: Clear indicators match the classification
- **medium**: Some indicators present, but not definitive
- **low**: Classification based on heuristics, may need review`;
}

export interface EntryPointCandidate {
  id: number;
  name: string;
  kind: string;
  filePath: string;
  incomingDeps: number;
  outgoingDeps: number;
  purpose: string | null;
  domain: string[] | null;
  role: string | null;
}

export function buildEntryPointUserPrompt(candidates: EntryPointCandidate[]): string {
  const parts: string[] = [];

  parts.push(`## Entry Point Candidates (${candidates.length})`);
  parts.push('');

  for (const c of candidates) {
    parts.push(`### #${c.id}: ${c.name} (${c.kind})`);
    parts.push(`File: ${c.filePath}`);
    parts.push(`Connectivity: ${c.incomingDeps} incoming, ${c.outgoingDeps} outgoing`);

    if (c.purpose) {
      parts.push(`Purpose: "${c.purpose}"`);
    }
    if (c.domain && c.domain.length > 0) {
      parts.push(`Domains: ${c.domain.join(', ')}`);
    }
    if (c.role) {
      parts.push(`Role: ${c.role}`);
    }
    parts.push('');
  }

  parts.push('Classify each entry point in CSV format.');

  return parts.join('\n');
}

// ============================================
// Phase 2: Flow Construction
// ============================================

export function buildFlowConstructionSystemPrompt(): string {
  return `You are a software architect constructing execution flows from annotated code.

## Your Task
For each entry point, trace the logical execution path through the codebase to create a meaningful business flow.

## Key Concepts

**Atomic flows**: Sequences of definition steps (function/method calls)
**Composite flows**: Flows that include references to sub-flows
**Sub-flows**: Reusable patterns that can be referenced by name

## Output Format
Respond with **only** a CSV table:

\`\`\`csv
type,flow_id,field,value
flow,1,name,"UserRegistration"
flow,1,description,"Handles new user signup from request to confirmation"
flow,1,domain,"auth"
flow,1,is_composite,"true"
step,1,1,42
step,1,2,subflow:ValidateUser
step,1,3,89
step,1,4,subflow:SendWelcomeEmail
step,1,5,123
subflow_reason,1,2,"Delegates input validation to reusable validation flow"
subflow_reason,1,4,"Triggers async email notification flow"
\`\`\`

## Row Types

**flow rows:**
- \`flow,{id},name,{PascalCase name}\`
- \`flow,{id},description,{one-sentence description}\`
- \`flow,{id},domain,{primary domain}\`
- \`flow,{id},is_composite,{true|false}\`

**step rows:**
- \`step,{flow_id},{order},{definition_id}\` - Direct function call
- \`step,{flow_id},{order},subflow:{FlowName}\` - Reference to sub-flow

**subflow_reason rows:**
- \`subflow_reason,{flow_id},{step_order},{reason}\` - Why this sub-flow is invoked

## Construction Guidelines

1. **Follow call graph edges**: Each step should have a call edge to the next
2. **Identify sub-flow opportunities**:
   - Validation logic reused across flows
   - Common patterns like "send notification", "log action", "update cache"
   - Sequences that appear in multiple flows
3. **Name flows by business operation**: CreateSale, UserLogin, ProcessPayment
4. **Order steps by execution sequence**: Follow the actual call order
5. **Use relationship annotations**: Leverage semantic descriptions to understand purpose

## Naming Conventions
- Flow names: PascalCase, action-oriented (CreateUser, ValidatePayment)
- Sub-flow names: PascalCase, describing the reusable operation (ValidateUser, SendEmail)
- Descriptions: One sentence, business-focused`;
}

export interface FlowConstructionContext {
  entryPoint: AnnotatedSymbolInfo;
  neighborhood: {
    nodes: AnnotatedSymbolInfo[];
    edges: AnnotatedEdgeInfo[];
  };
  existingFlows: Array<{
    id: number;
    name: string;
    description: string | null;
    entryPointId: number;
  }>;
  existingSubflows: string[];
}

export function buildFlowConstructionUserPrompt(contexts: FlowConstructionContext[]): string {
  const parts: string[] = [];

  // List existing sub-flows that can be referenced
  if (contexts.length > 0 && contexts[0].existingSubflows.length > 0) {
    parts.push('## Available Sub-flows');
    for (const name of contexts[0].existingSubflows) {
      parts.push(`- ${name}`);
    }
    parts.push('');
  }

  // List existing flows for context
  if (contexts.length > 0 && contexts[0].existingFlows.length > 0) {
    parts.push('## Existing Flows');
    for (const flow of contexts[0].existingFlows.slice(0, 10)) {
      const desc = flow.description ? `: ${flow.description}` : '';
      parts.push(`- ${flow.name}${desc}`);
    }
    parts.push('');
  }

  parts.push(`## Entry Points to Trace (${contexts.length})`);
  parts.push('');

  for (let i = 0; i < contexts.length; i++) {
    const ctx = contexts[i];
    const flowId = i + 1;

    parts.push(`### Flow ${flowId}: Entry Point #${ctx.entryPoint.id} - ${ctx.entryPoint.name}`);
    parts.push(`File: ${ctx.entryPoint.filePath}:${ctx.entryPoint.line}`);

    if (ctx.entryPoint.purpose) {
      parts.push(`Purpose: "${ctx.entryPoint.purpose}"`);
    }
    if (ctx.entryPoint.domain && ctx.entryPoint.domain.length > 0) {
      parts.push(`Domain: ${ctx.entryPoint.domain.join(', ')}`);
    }
    parts.push('');

    // Show neighborhood nodes
    parts.push('**Call Graph Neighborhood:**');
    for (const node of ctx.neighborhood.nodes.slice(0, 20)) {
      const purpose = node.purpose ? ` - "${node.purpose}"` : '';
      const role = node.role ? ` [${node.role}]` : '';
      parts.push(`- #${node.id}: ${node.name} (${node.kind})${role}${purpose}`);
    }
    if (ctx.neighborhood.nodes.length > 20) {
      parts.push(`  ... and ${ctx.neighborhood.nodes.length - 20} more nodes`);
    }
    parts.push('');

    // Show edges with semantic annotations
    parts.push('**Call Relationships:**');
    for (const edge of ctx.neighborhood.edges.slice(0, 20)) {
      const fromNode = ctx.neighborhood.nodes.find(n => n.id === edge.fromId);
      const toNode = ctx.neighborhood.nodes.find(n => n.id === edge.toId);
      if (fromNode && toNode) {
        const semantic = edge.semantic ? `: "${edge.semantic}"` : '';
        parts.push(`- ${fromNode.name} (#${edge.fromId}) → ${toNode.name} (#${edge.toId})${semantic}`);
      }
    }
    if (ctx.neighborhood.edges.length > 20) {
      parts.push(`  ... and ${ctx.neighborhood.edges.length - 20} more edges`);
    }
    parts.push('');
  }

  parts.push('Construct flows in CSV format. Reference sub-flows where appropriate.');

  return parts.join('\n');
}

// ============================================
// Phase 3: Gap Filling
// ============================================

export function buildGapFillingSystemPrompt(): string {
  return `You are a software architect analyzing coverage gaps in detected execution flows.

## Your Task
Review uncovered symbols and suggest how they should be incorporated into flows.

## Suggestion Types

1. **new_flow**: Symbol should be an entry point for a new top-level flow
2. **add_to_existing**: Symbol should be added as a step to an existing flow
3. **new_subflow**: Symbol represents reusable logic that should become a sub-flow

## Output Format
Respond with **only** a CSV table:

\`\`\`csv
type,symbol_id,target_flow_id,reason
new_flow,89,,"Payment validation should be a standalone flow"
add_to_existing,156,3,"Should be added to CreateSale flow as notification step"
new_subflow,42,,"Appears in multiple flows as common validation pattern"
\`\`\`

## Guidelines

**When to suggest new_flow:**
- Symbol has characteristics of an entry point
- Represents a distinct business operation not covered by existing flows
- Has outgoing dependencies forming a logical execution path

**When to suggest add_to_existing:**
- Symbol is called by or calls symbols in an existing flow
- Logically belongs to an existing flow's execution path
- Would complete or enhance an existing flow

**When to suggest new_subflow:**
- Symbol is called by multiple existing flows
- Represents reusable business logic (validation, notification, etc.)
- Would reduce duplication if extracted as sub-flow

Prioritize symbols with high connectivity - they're more likely to be important.`;
}

export interface GapFillingContext {
  uncoveredSymbols: Array<{
    id: number;
    name: string;
    kind: string;
    filePath: string;
    purpose: string | null;
    domain: string[] | null;
    role: string | null;
    incomingDeps: number;
    outgoingDeps: number;
  }>;
  existingFlows: Array<{
    id: number;
    name: string;
    description: string | null;
    stepCount: number;
  }>;
  coverageStats: {
    covered: number;
    total: number;
    percentage: number;
  };
}

export function buildGapFillingUserPrompt(context: GapFillingContext): string {
  const parts: string[] = [];

  parts.push('## Current Coverage');
  parts.push(`${context.coverageStats.covered}/${context.coverageStats.total} symbols covered (${context.coverageStats.percentage.toFixed(1)}%)`);
  parts.push('');

  parts.push('## Existing Flows');
  for (const flow of context.existingFlows) {
    const desc = flow.description ? `: ${flow.description}` : '';
    parts.push(`- [${flow.id}] ${flow.name} (${flow.stepCount} steps)${desc}`);
  }
  parts.push('');

  parts.push(`## Uncovered Important Symbols (${context.uncoveredSymbols.length})`);
  parts.push('');

  for (const sym of context.uncoveredSymbols.slice(0, 30)) {
    parts.push(`### #${sym.id}: ${sym.name} (${sym.kind})`);
    parts.push(`File: ${sym.filePath}`);
    parts.push(`Connectivity: ${sym.incomingDeps} incoming, ${sym.outgoingDeps} outgoing`);

    if (sym.purpose) {
      parts.push(`Purpose: "${sym.purpose}"`);
    }
    if (sym.domain && sym.domain.length > 0) {
      parts.push(`Domains: ${sym.domain.join(', ')}`);
    }
    if (sym.role) {
      parts.push(`Role: ${sym.role}`);
    }
    parts.push('');
  }

  if (context.uncoveredSymbols.length > 30) {
    parts.push(`... and ${context.uncoveredSymbols.length - 30} more uncovered symbols`);
    parts.push('');
  }

  parts.push('Suggest how to incorporate these symbols in CSV format.');

  return parts.join('\n');
}

// ============================================
// Coverage Formatting
// ============================================

export function formatCoverageStats(stats: FlowCoverageStats): string {
  const parts: string[] = [];

  parts.push('## Flow Coverage Statistics');
  parts.push('');
  parts.push(`Total definitions: ${stats.totalDefinitions}`);
  parts.push(`Covered by flows: ${stats.coveredByFlows} (${stats.coveragePercentage.toFixed(1)}%)`);
  parts.push('');
  parts.push('### Hierarchy Metrics');
  parts.push(`Top-level flows: ${stats.topLevelFlows}`);
  parts.push(`Sub-flows: ${stats.subFlows}`);
  parts.push(`Avg composition depth: ${stats.avgCompositionDepth.toFixed(2)}`);
  parts.push('');

  if (stats.uncoveredEntryPoints.length > 0) {
    parts.push('### Uncovered Entry Points');
    for (const ep of stats.uncoveredEntryPoints.slice(0, 10)) {
      parts.push(`- ${ep.name} (#${ep.id}): ${ep.outgoingDeps} outgoing deps`);
    }
    if (stats.uncoveredEntryPoints.length > 10) {
      parts.push(`  ... and ${stats.uncoveredEntryPoints.length - 10} more`);
    }
    parts.push('');
  }

  if (stats.coverageByDomain.size > 0) {
    parts.push('### Coverage by Domain');
    const sortedDomains = Array.from(stats.coverageByDomain.entries())
      .sort((a, b) => b[1].total - a[1].total);
    for (const [domain, { covered, total }] of sortedDomains.slice(0, 10)) {
      const pct = total > 0 ? ((covered / total) * 100).toFixed(1) : '0.0';
      parts.push(`- ${domain}: ${covered}/${total} (${pct}%)`);
    }
    parts.push('');
  }

  if (stats.orphanedSubflows.length > 0) {
    parts.push('### Orphaned Sub-flows');
    for (const sf of stats.orphanedSubflows) {
      parts.push(`- ${sf.name} (#${sf.id})`);
    }
    parts.push('');
  }

  return parts.join('\n');
}
