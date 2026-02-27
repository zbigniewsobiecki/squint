/**
 * Flows module - Entry point detection, LLM-first flow design, and journey composition.
 */

export * from './types.js';
export { deduplicateByInteractionOverlap, deduplicateByInteractionSet } from './dedup.js';
export { EntryPointDetector } from './entry-point-detector.js';
export { FlowArchitect } from './flow-architect.js';
export { JourneyBuilder } from './journey-builder.js';
