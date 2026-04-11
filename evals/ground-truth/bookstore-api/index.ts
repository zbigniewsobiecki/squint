import type { GroundTruth } from '../../harness/types.js';
import { contracts } from './contracts.js';
import { definitionMetadata } from './definition-metadata.js';
import { definitions } from './definitions.js';
import { featureCohesion } from './feature-cohesion.js';
import { files } from './files.js';
import { flowRubric } from './flow-rubric.js';
import { imports } from './imports.js';
import { interactionRubric } from './interaction-rubric.js';
import { moduleCohesion } from './module-cohesion.js';
import { modules } from './modules.js';
import { relationships } from './relationships.js';

/**
 * Composed ground truth for the bookstore-api Ruby on Rails fixture.
 *
 * Iteration 1 (parse stage): files, definitions, imports
 * Iteration 2 (symbols stage): + definitionMetadata (purpose/domain/pure)
 * Iteration 3 (relationships stage): + relationships (extends/uses + semantic)
 * Iteration 4 (modules stage): + moduleCohesion (cohesion + role rubric)
 * Iteration 5 (contracts stage): + contracts (HTTP routes)
 * Iteration 6 (interactions stage): + interactionRubric (anchor-based edges)
 * Iteration 7 (flows stage): + flowRubric (theme-search user journeys)
 * Iteration 8 (features stage): + featureCohesion (theme-search features)
 */
export const bookstoreApiGroundTruth: GroundTruth = {
  fixtureName: 'bookstore-api',
  files,
  definitions,
  imports,
  definitionMetadata,
  relationships,
  modules,
  moduleCohesion,
  contracts,
  interactionRubric,
  flowRubric,
  featureCohesion,
};
