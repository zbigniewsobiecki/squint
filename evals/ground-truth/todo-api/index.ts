import type { GroundTruth } from '../../harness/types.js';
import { definitionMetadata } from './definition-metadata.js';
import { definitions } from './definitions.js';
import { files } from './files.js';
import { imports } from './imports.js';

/**
 * Composed ground truth for the todo-api fixture.
 *
 * Iteration 1 (parse stage): files, definitions, imports
 * Iteration 2 (symbols stage): + definitionMetadata (purpose/domain/pure)
 *
 * Add new tables (modules, contracts, interactions, flows, ...) as
 * iterations advance.
 */
export const todoApiGroundTruth: GroundTruth = {
  fixtureName: 'todo-api',
  files,
  definitions,
  imports,
  definitionMetadata,
};
