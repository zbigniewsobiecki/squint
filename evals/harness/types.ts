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
  /**
   * EXACTLY ONE of `exactValue`, `proseReference`, `acceptableSet`, or
   * `themeReference` must be set. The comparator picks its strategy based on
   * which field is present.
   */
  /** Byte-for-byte string match. Use for booleans like 'pure': "true"/"false". Mismatch is **major**. */
  exactValue?: string;
  /** LLM-judged similarity vs reference text. Use for free-form prose like 'purpose'. Failure is **minor** prose-drift. */
  proseReference?: string;
  /**
   * Subset check after JSON parse. Use for tag arrays like 'domain': ["auth","http"].
   *
   * Semantics: produced value must be a JSON array of strings that is BOTH
   *  (a) non-empty (LLM did pick some tags), AND
   *  (b) a subset of `acceptableSet` (every produced tag appears in the GT vocabulary).
   *
   * Largely superseded by `themeReference` for noisy LLM-generated tag fields —
   * `acceptableSet` requires hand-maintaining vocabulary lists, which becomes a
   * treadmill as the LLM picks new synonyms. Prefer `themeReference` for those.
   * Keep `acceptableSet` for cases where the vocabulary really is closed and
   * exhaustive (e.g., a small enum-like field).
   *
   * Mismatch is **minor** (vocabulary drift expected).
   */
  acceptableSet?: string[];
  /**
   * LLM-judged semantic theme for tag arrays. Use for noisy LLM-generated tag
   * fields like 'domain' where the vocabulary the LLM picks varies legitimately.
   *
   * Semantics: the comparator parses the produced value as a JSON string array,
   * formats it as readable prose ("tags: a, b, c"), and asks the prose judge to
   * score similarity against `themeReference`. Below threshold = MINOR prose-drift.
   *
   * Replaces the `acceptableSet` whack-a-mole — write a one-sentence description
   * of what tags should reflect, and let the judge handle synonyms.
   */
  themeReference?: string;
  /**
   * Deterministic floor for `themeReference` and `acceptableSet`: the produced
   * tag array must contain at least this many tags. Default 1.
   * Below the floor → MINOR mismatch (the LLM gave up and produced an empty array).
   */
  minTagsRequired?: number;
  /** Min similarity for prose judge (default 0.75 for proseReference, 0.6 for themeReference). */
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

/**
 * Interaction rubric for the LLM-driven interactions stage.
 *
 * Replaces strict `(fromModulePath, toModulePath)` exact-match GT with a
 * property-based assertion: "the module containing definition X should
 * interact with the module containing definition Y, optionally with this
 * source kind and this prose semantic". The comparator resolves anchor
 * defs to their containing modules at compare time, so the GT is decoupled
 * from iter 4's LLM-picked module names.
 */
export interface InteractionRubricEntry {
  /** Stable label for diff reporting and cache stability. */
  label: string;
  /**
   * One or more anchor definitions on the FROM side. The comparator
   * resolves the FIRST anchor that has a module assignment.
   */
  fromAnchor: DefKey;
  /** One or more anchor definitions on the TO side. */
  toAnchor: DefKey;
  /**
   * Acceptable interaction sources — the LLM may pick any. Defaults to
   * ['ast', 'ast-import', 'contract-matched'] (the deterministic ones).
   * llm-inferred is excluded by default because it's the most variance-prone.
   */
  acceptableSources?: InteractionSource[];
  /** Optional prose theme for the semantic field, judged in theme mode. */
  semanticReference?: string;
  /** Min similarity for the prose judge (default 0.6). */
  minSimilarity?: number;
}

/**
 * Member-cohesion rubric for the LLM-driven modules stage.
 *
 * Replaces the strict `modules`/`module_members` exact-match GT with a
 * property-based assertion: "these definitions should live in the same
 * module, and that module should play this role". This is robust to
 * LLM tree-shape variation (different slugs, different depths, different
 * groupings) because it tests the *semantic* property, not the spelling.
 *
 * The companion comparator is `compareModuleCohesion` (virtual table
 * `module_cohesion`), which JOINs `modules` + `module_members` and verifies
 * each group via cohesion + an LLM judge call against `expectedRole`.
 */
export interface ModuleCohesionGroup {
  /** Stable label for diff reporting and cache stability. */
  label: string;
  /** Definitions that should share a module. */
  members: DefKey[];
  /** Prose describing what role the containing module should play. */
  expectedRole: string;
  /**
   * Cohesion mode:
   * - 'strict' (default): every member must be in the same module
   * - 'majority': >50% of members must share a single module (the rest count
   *   as drift, not failure — useful when one base class might land in the
   *   parent module while subclasses land in the leaf)
   */
  cohesion?: 'strict' | 'majority';
  /** Minimum similarity for the role judge. Default 0.6. */
  minRoleSimilarity?: number;
}

export interface GroundTruthContract {
  protocol: string; // 'http' | 'event' | etc.
  normalizedKey: string; // e.g. 'POST /auth/login' or 'task.completed'
  participants: GroundTruthContractParticipant[];
  /**
   * If true, this contract is "expected but not required" — the LLM may
   * legitimately fail to extract it on some runs. Missing produces a MINOR
   * warning instead of a CRITICAL gate failure.
   *
   * Use for contracts like in-process events where the boundary status is
   * ambiguous and the LLM's detection is non-deterministic.
   */
  optional?: boolean;
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
  /**
   * Cohesion-based GT for the LLM-driven modules stage. When set, use the
   * `module_cohesion` virtual table in scope (NOT `modules`/`module_members`).
   * See `ModuleCohesionGroup` for the rationale.
   */
  moduleCohesion?: ModuleCohesionGroup[];
  contracts?: GroundTruthContract[];
  interactions?: GroundTruthInteraction[];
  /**
   * Anchor-based GT for the LLM-driven interactions stage. When set, use
   * the `interaction_rubric` virtual table in scope INSTEAD of `interactions`.
   * See `InteractionRubricEntry` for the rationale.
   */
  interactionRubric?: InteractionRubricEntry[];
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
  /**
   * Virtual table — not a real DB table. The `compareModuleCohesion`
   * comparator joins `modules` + `module_members` and verifies the
   * `gt.moduleCohesion` rubric. Use this in scope INSTEAD of `modules` /
   * `module_members` for LLM-driven module-stage iterations.
   */
  | 'module_cohesion'
  /**
   * Virtual table — `compareInteractionRubric` resolves anchor defs to
   * their containing modules and verifies an interaction edge between them.
   * Use this in scope INSTEAD of `interactions` for LLM-driven iterations.
   */
  | 'interaction_rubric'
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
  /**
   * Judging mode. The two modes use different system prompts and different
   * cache namespaces:
   *
   * - 'prose' (default): the reference and candidate are both natural-language
   *   descriptions. The judge scores STRICT semantic similarity — it surfaces
   *   missing concepts and vague descriptions. Use for `purpose`, module
   *   descriptions, relationship semantics, etc.
   *
   * - 'theme': the reference describes what concept a tag list should reflect,
   *   and the candidate is a tag list (formatted as "tags: a, b, c"). The
   *   judge scores TOLERANT semantic fit — it accepts any reasonable tags for
   *   the concept, even if they use different vocabulary. Use for noisy
   *   LLM-generated tag fields like `domain`.
   */
  mode?: 'prose' | 'theme';
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
 * Single source of truth for "which tables have prose-judged fields, and how
 * to count declared references in a GroundTruth".
 *
 * Adding a new prose-bearing table = ONE new entry here. Previously this was
 * encoded in two places (PROSE_BEARING_TABLES set + a hardcoded if-chain in
 * countDeclaredProseReferences). The set is now derived from the keys.
 */
export const PROSE_REFERENCE_COUNTERS: Partial<Record<TableName, (gt: GroundTruth) => number>> = {
  definition_metadata: (gt) =>
    (gt.definitionMetadata ?? []).filter((m) => m.proseReference != null || m.themeReference != null).length,
  relationship_annotations: (gt) => (gt.relationships ?? []).filter((r) => r.semanticReference != null).length,
  modules: (gt) => (gt.modules ?? []).filter((m) => m.descriptionReference != null).length,
  // Cohesion rubric ALWAYS makes a judge call per group (the role check),
  // so the count is the entire rubric length.
  module_cohesion: (gt) => (gt.moduleCohesion ?? []).length,
  interaction_rubric: (gt) => (gt.interactionRubric ?? []).filter((i) => i.semanticReference != null).length,
  interactions: (gt) => (gt.interactions ?? []).filter((i) => i.semanticReference != null).length,
  flows: (gt) => (gt.flows ?? []).filter((f) => f.descriptionReference != null).length,
  features: (gt) => (gt.features ?? []).filter((f) => f.descriptionReference != null).length,
};

/**
 * Tables that involve prose-judged fields, derived from PROSE_REFERENCE_COUNTERS.
 * If any of these are in scope AND the GT actually declares prose references,
 * a stub judge is forbidden.
 */
export const PROSE_BEARING_TABLES: ReadonlySet<TableName> = new Set(
  Object.keys(PROSE_REFERENCE_COUNTERS) as TableName[]
);

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
