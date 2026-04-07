export { openDatabase, withDatabase, resolveDbPath } from './db-helper.js';
export { resolveFileId } from './file-resolver.js';
export { SymbolResolver, type ResolvedSymbol, type ResolvedSymbolWithDetails } from './symbol-resolver.js';
export { SharedFlags, LlmFlags } from './flags.js';
export { outputJsonOrPlain, truncate, tableSeparator, formatLineNumber } from './output.js';
export { readSourceLines, readSourceAsString, readAllLines } from './source-reader.js';
export {
  formatModuleRef,
  collectFeaturesForFlows,
  resolveModuleIds,
  collectModuleIdsFromSteps,
  collectFlowsForInteractions,
} from './context-helpers.js';
export { enhanceSymbols, type EnhancedSymbol } from './symbol-enhancer.js';
export { buildSourceGroups } from './relationship-source-groups.js';
export { validateAnnotationValue } from './annotation-validators.js';
export { RelationshipRetryQueue } from './retry-queue.js';
export { detectProjectLanguage, buildFileLanguageMap } from './language-detection.js';
export {
  processSymbolAnnotations,
  processRelationshipAnnotations,
  getCoverageForPrompt,
  type ProcessSymbolAnnotationsOptions,
  type ProcessSymbolAnnotationsResult,
  type ProcessRelationshipAnnotationsOptions,
  type ProcessRelationshipAnnotationsResult,
  type GetCoverageForPromptOptions,
} from './annotation-processor.js';
