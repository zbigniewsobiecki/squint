import type { GroundTruth } from '../../harness/types.js';
import { contracts } from './contracts.js';
import { definitionMetadata } from './definition-metadata.js';
import { definitions } from './definitions.js';
import { files } from './files.js';
import { imports } from './imports.js';
import { moduleCohesion } from './module-cohesion.js';
import { modules } from './modules.js';
import { relationships } from './relationships.js';

/**
 * Composed ground truth for the todo-api fixture.
 *
 * Iteration 1 (parse stage): files, definitions, imports
 * Iteration 2 (symbols stage): + definitionMetadata (purpose/domain/pure)
 * Iteration 3 (relationships stage): + relationships (extends/implements/uses + semantic)
 * Iteration 4 (modules stage): + moduleCohesion (cohesion + role rubric, replaces strict modules GT)
 * Iteration 5 (contracts stage): + contracts (HTTP routes + events with participants)
 *
 * The legacy `modules` field is still composed for backward-compat with the
 * old `compareModules`/`compareModuleMembers` strategies; iter 4/4.5 don't
 * include those tables in scope anymore.
 *
 * Add new tables (interactions, flows, ...) as iterations advance.
 */
export const todoApiGroundTruth: GroundTruth = {
  fixtureName: 'todo-api',
  files,
  definitions,
  imports,
  definitionMetadata,
  relationships,
  modules,
  moduleCohesion,
  contracts,
};
