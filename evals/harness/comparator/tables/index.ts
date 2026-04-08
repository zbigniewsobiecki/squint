/**
 * Per-table comparator strategies.
 *
 * Each comparator returns a TableDiff with structural diffs only — prose-judged
 * fields are handled inline by the per-table comparator that needs them, using
 * the ProseJudgeFn injected via the dispatcher.
 *
 * Key invariant: comparisons are ID-agnostic. Joins use natural keys (file
 * paths, definition names, module full_paths, contract protocol+key, etc.) so
 * that two DBs built with different insertion orders still match.
 *
 * Adding a new comparator: create a new file in this directory, then re-export
 * it here AND wire it into the COMPARATORS map in `comparator/index.ts`.
 */

export { compareContracts } from './contracts.js';
export { compareDefinitionMetadata } from './definition-metadata.js';
export { compareDefinitions } from './definitions.js';
export { compareFiles } from './files.js';
export { compareFlows } from './flows.js';
export { compareImports } from './imports.js';
export { compareInteractions } from './interactions.js';
export { compareModuleMembers } from './module-members.js';
export { compareModules } from './modules.js';
export { compareRelationshipAnnotations } from './relationship-annotations.js';
