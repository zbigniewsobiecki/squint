import type { GroundTruth } from '../../harness/types.js';
import { definitions } from './definitions.js';
import { files } from './files.js';
import { imports } from './imports.js';

/**
 * Composed ground truth for the todo-api fixture.
 *
 * Add new tables (modules, contracts, interactions, flows, ...) as
 * iterations advance. For iteration 1 we cover only the parse stage.
 */
export const todoApiGroundTruth: GroundTruth = {
  fixtureName: 'todo-api',
  files,
  definitions,
  imports,
};
