/**
 * Types for the squint evaluation harness.
 *
 * Design rules:
 * - Natural keys only (file paths, definition names, module full_paths) — never DB IDs
 * - Mirror src/db/schema.ts column names but use camelCase
 * - Decoupled from src/ types so the harness can be tested in isolation
 */

// ============================================================
// Ground truth declarative records (input to the builder)
// ============================================================

export type DefinitionKind = 'function' | 'class' | 'variable' | 'const' | 'type' | 'interface' | 'enum';
export type ImportType = 'import' | 'dynamic-import' | 'require' | 're-export' | 'export-all';
export type SymbolKind = 'named' | 'default' | 'namespace' | 'side-effect';
export type RelationshipType = 'uses' | 'extends' | 'implements';
export type InteractionPattern = 'utility' | 'business' | 'test-internal';
// Mirrors src/db/schema.ts InteractionSource — must stay in sync with the live schema.
export type InteractionSource = 'ast' | 'ast-import' | 'llm-inferred' | 'contract-matched';
export type FlowStakeholder = 'user' | 'admin' | 'system' | 'developer' | 'external';

export interface GroundTruthFile {
  path: string; // relative path from fixture root, e.g. 'src/index.ts'
  language: string; // 'typescript' | 'javascript'
}

export interface GroundTruthDefinition {
  file: string; // natural key — must match a GroundTruthFile.path
  name: string;
  kind: DefinitionKind;
  isExported: boolean;
  isDefault?: boolean; // default false
  /** 1-based line number. Comparator allows ±2 line tolerance unless overridden. */
  line: number;
  /** Optional: end line, also 1-based. */
  endLine?: number;
  extendsName?: string | null;
  implementsNames?: string[] | null;
  extendsInterfaces?: string[] | null;
}

export interface GroundTruthImport {
  fromFile: string; // natural key
  source: string; // raw import source as written, e.g. './service.js' or 'express'
  type: ImportType;
  isExternal?: boolean;
  isTypeOnly?: boolean;
  /** Imported symbols (named, default, namespace) for this import statement. */
  symbols?: GroundTruthImportSymbol[];
}

export interface GroundTruthImportSymbol {
  /** Original exported name. */
  name: string;
  /** Local alias (often same as name). Defaults to name. */
  localName?: string;
  kind: SymbolKind;
}

export interface GroundTruthUsage {
  file: string; // file in which the usage occurs
  symbolName: string; // local name of the symbol used
  line: number; // 1-based
  context: string; // e.g. 'call_expression', 'member_expression'
  isMethodCall?: boolean;
  isConstructorCall?: boolean;
}

export interface GroundTruthDefinitionMetadata {
  defKey: DefKey; // natural key for the definition
  key: string; // 'purpose' | 'domain' | 'role' | 'pure' | etc.
  /** For non-prose values (e.g. 'pure': 'true'), comparator does exact match. */
  exactValue?: string;
  /** For prose values, comparator uses LLM judge against this reference. */
  proseReference?: string;
  /** Min similarity for prose judge (default 0.75). */
  minSimilarity?: number;
}

export interface GroundTruthRelationship {
  fromDef: DefKey;
  toDef: DefKey;
  relationshipType: RelationshipType;
  /** Optional reference text for the prose `semantic` field. */
  semanticReference?: string;
  minSimilarity?: number;
}

export interface GroundTruthModule {
  fullPath: string; // e.g. 'project.controllers.auth'
  name: string;
  parentFullPath?: string | null;
  isTest?: boolean;
  /** Members assigned to this module by their natural definition keys. */
  members?: DefKey[];
  /** Optional reference text for the prose `description` field. */
  descriptionReference?: string;
  minSimilarity?: number;
}

export interface GroundTruthContract {
  protocol: string; // 'http' | 'events' | etc.
  normalizedKey: string; // e.g. 'POST /api/auth/login' or 'task.completed'
  participants: GroundTruthContractParticipant[];
}

export interface GroundTruthContractParticipant {
  defKey: DefKey;
  role: string; // 'server' | 'client' | 'producer' | 'consumer' | etc.
}

export interface GroundTruthInteraction {
  fromModulePath: string;
  toModulePath: string;
  pattern: InteractionPattern | null;
  source: InteractionSource;
  /** Definition-level links underlying this interaction. */
  links?: GroundTruthInteractionLink[];
  semanticReference?: string;
  minSimilarity?: number;
}

export interface GroundTruthInteractionLink {
  fromDef: DefKey;
  toDef: DefKey;
  contractKey?: ContractKey; // optional: link to contract
}

export interface GroundTruthFlow {
  slug: string;
  name: string;
  entryDef?: DefKey;
  entryModulePath?: string;
  entryPath?: string; // e.g. 'POST /api/auth/login'
  stakeholder: FlowStakeholder;
  /** Ordered module-level steps (interactions). */
  steps?: Array<{ from: string; to: string }>; // module path pairs identifying the interaction
  /** Ordered definition-level steps. */
  definitionSteps?: Array<{ from: DefKey; to: DefKey }>;
  descriptionReference?: string;
  minSimilarity?: number;
}

export interface GroundTruthFeature {
  slug: string;
  name: string;
  flowSlugs: string[];
  descriptionReference?: string;
  minSimilarity?: number;
}

/**
 * The complete ground truth for a single fixture, composed in
 * `evals/ground-truth/<name>/index.ts`.
 */
export interface GroundTruth {
  fixtureName: string;
  files: GroundTruthFile[];
  definitions: GroundTruthDefinition[];
  imports?: GroundTruthImport[];
  usages?: GroundTruthUsage[];
  definitionMetadata?: GroundTruthDefinitionMetadata[];
  relationships?: GroundTruthRelationship[];
  modules?: GroundTruthModule[];
  contracts?: GroundTruthContract[];
  interactions?: GroundTruthInteraction[];
  flows?: GroundTruthFlow[];
  features?: GroundTruthFeature[];
}

// ============================================================
// Natural keys (branded — see below)
// ============================================================

/**
 * Branded string types so a raw `string` cannot be passed where a `DefKey` is
 * expected. Forces all construction through `defKey()` / `contractKey()`,
 * which catches a real class of bugs (e.g., passing a file path where a
 * definition key is expected) at compile time.
 *
 * The `__brand` field exists only in the type system — there is no runtime cost.
 */
export type DefKey = string & { readonly __brand: 'DefKey' };
export type ContractKey = string & { readonly __brand: 'ContractKey' };

export function defKey(file: string, name: string): DefKey {
  return `${file}::${name}` as DefKey;
}

export function parseDefKey(key: DefKey): { file: string; name: string } {
  // Use lastIndexOf so definition names containing '::' are handled correctly.
  // (File paths cannot contain '::' in any platform's path syntax.)
  const idx = (key as string).lastIndexOf('::');
  if (idx === -1) throw new Error(`Invalid defKey: ${key}`);
  return { file: (key as string).slice(0, idx), name: (key as string).slice(idx + 2) };
}

export function contractKey(protocol: string, normalizedKey: string): ContractKey {
  return `${protocol}::${normalizedKey}` as ContractKey;
}

// ============================================================
// Diff report (output of the comparator)
// ============================================================

export type Severity = 'critical' | 'major' | 'minor';

export type TableName =
  | 'files'
  | 'definitions'
  | 'imports'
  | 'symbols'
  | 'usages'
  | 'definition_metadata'
  | 'relationship_annotations'
  | 'modules'
  | 'module_members'
  | 'contracts'
  | 'contract_participants'
  | 'interactions'
  | 'interaction_definition_links'
  | 'flows'
  | 'flow_steps'
  | 'flow_definition_steps'
  | 'features';

/** A single concrete difference inside a table. */
export interface RowDiff {
  kind: 'missing' | 'extra' | 'mismatch' | 'prose-drift';
  severity: Severity;
  /** Natural key of the row in question, for human reading. */
  naturalKey: string;
  /** Free-form details for the reporter. */
  details: string;
  /** Optional fix-hint id resolved by reporter. */
  fixHintId?: string;
}

export interface TableDiff {
  table: TableName;
  passed: boolean;
  /** Number of expected rows in ground truth (for prose checks: number of references). */
  expectedCount: number;
  /** Number of rows produced by squint. */
  producedCount: number;
  diffs: RowDiff[];
  /**
   * Per-table prose-judge tally. Comparators that judge prose fields populate
   * this directly. Passed prose checks do NOT generate RowDiffs (only failed
   * ones do, as `prose-drift` kind), so this counter is the only way to track
   * passes. Defaults to {0,0} when no prose checks were run for the table.
   */
  proseChecks?: { passed: number; failed: number };
}

export interface DiffSummary {
  critical: number;
  major: number;
  minor: number;
  proseChecks: { passed: number; failed: number };
}

export interface DiffReport {
  fixtureName: string;
  passed: boolean;
  scope: TableName[];
  tables: TableDiff[];
  summary: DiffSummary;
  durationMs: number;
  squintCommit?: string;
}

// ============================================================
// Prose judge
// ============================================================

export interface ProseJudgeRequest {
  /** Identifying label for logging/caching, e.g. "definition_metadata.purpose for src/foo.ts::bar". */
  field: string;
  reference: string;
  candidate: string;
  minSimilarity: number;
}

export interface ProseJudgeResult {
  similarity: number; // 0..1
  passed: boolean;
  reasoning: string;
}

/**
 * Marker symbol set on stub/no-op judge functions. The compare() orchestrator
 * checks for this when prose-bearing scopes are requested and refuses to run
 * — so a stub judge can never silently pass real prose checks.
 */
export const STUB_JUDGE_MARKER = Symbol.for('squint.eval.stubJudge');

/**
 * Pluggable judge function. Real implementation calls an LLM;
 * tests inject a stub. Stubs MUST set the STUB_JUDGE_MARKER property
 * so the orchestrator can refuse to use them on real prose-check scopes.
 */
export type ProseJudgeFn = ((req: ProseJudgeRequest) => Promise<ProseJudgeResult>) & {
  [STUB_JUDGE_MARKER]?: true;
};

/**
 * Build a stub judge that always passes. Used by tests and by iterations
 * that have no prose checks in scope. Tagged with STUB_JUDGE_MARKER so
 * compare() can detect it and refuse to run on prose-bearing scopes.
 */
export function makeStubJudge(): ProseJudgeFn {
  const fn: ProseJudgeFn = async () => ({
    similarity: 1,
    passed: true,
    reasoning: 'stub judge — always passes',
  });
  fn[STUB_JUDGE_MARKER] = true;
  return fn;
}

/**
 * Tables that involve prose-judged fields. If any of these are in scope AND
 * the GT actually declares prose references, a stub judge is forbidden.
 */
export const PROSE_BEARING_TABLES: ReadonlySet<TableName> = new Set([
  'definition_metadata',
  'relationship_annotations',
  'modules',
  'interactions',
  'flows',
  'features',
]);

// ============================================================
// Fix hint database
// ============================================================

export interface FixHint {
  id: string;
  /** Conditions under which this hint applies. */
  when: {
    table: TableName;
    kind?: RowDiff['kind'];
    /** Substring match against naturalKey. */
    keyContains?: string;
  };
  /** Markdown body shown in the report. */
  body: string;
}
