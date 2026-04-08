import { type InteractionRubricEntry, defKey } from '../../harness/types.js';

/**
 * Anchor-based ground truth for the LLM-driven interactions stage.
 *
 * Each entry asserts that the module containing FROM_ANCHOR has an
 * interaction edge to the module containing TO_ANCHOR. The actual module
 * full_paths are LLM-picked, so we use definitions as deterministic
 * anchors and let the comparator resolve them at compare time.
 *
 * The 5 high-confidence edges below are the AST-derivable
 * controller-service-repository pipeline that the squint interactions
 * stage should always detect:
 *
 *   - AuthController → AuthService            (HTTP layer → business logic)
 *   - TasksController → TasksService          (HTTP layer → business logic)
 *   - TasksController → requireAuth           (controller → middleware guard)
 *   - TasksService → TasksRepository          (service → persistence)
 *   - TasksService → eventBus                 (service → event emission)
 *
 * Authored COLD against the controller / service / repository source code.
 * If the cold run reveals that any edge isn't detected by squint (or that
 * the modules iter-4 places these defs into the SAME module — which would
 * make the rubric a self-loop), the entry will be removed and triaged.
 *
 * Severity (compareInteractionRubric):
 *   - Anchor def doesn't exist                → CRITICAL
 *   - Anchor unassigned to a module           → CRITICAL
 *   - Anchors resolve to the same module      → MAJOR (no cross-module edge)
 *   - No interaction between resolved modules → MAJOR
 *   - Source not in acceptable set            → MAJOR
 *   - Semantic prose drift                    → MINOR
 */
export const interactionRubric: InteractionRubricEntry[] = [
  {
    label: 'auth-controller-uses-auth-service',
    fromAnchor: defKey('src/controllers/auth.controller.ts', 'AuthController'),
    toAnchor: defKey('src/services/auth.service.ts', 'AuthService'),
    semanticReference: 'Authentication controller delegates to the authentication service',
  },
  {
    label: 'tasks-controller-uses-tasks-service',
    fromAnchor: defKey('src/controllers/tasks.controller.ts', 'TasksController'),
    toAnchor: defKey('src/services/tasks.service.ts', 'TasksService'),
    semanticReference: 'Tasks controller delegates to the tasks business logic service',
  },
  {
    label: 'tasks-controller-uses-auth-middleware',
    fromAnchor: defKey('src/controllers/tasks.controller.ts', 'TasksController'),
    toAnchor: defKey('src/middleware/auth.middleware.ts', 'requireAuth'),
    semanticReference: 'Tasks controller guards endpoints with the authentication middleware',
  },
  {
    label: 'tasks-service-uses-tasks-repository',
    fromAnchor: defKey('src/services/tasks.service.ts', 'TasksService'),
    toAnchor: defKey('src/repositories/tasks.repository.ts', 'TasksRepository'),
    semanticReference: 'Tasks service persists tasks via the tasks repository',
  },
  // tasks-service-uses-event-bus removed: in some runs the LLM groups
  // TasksService and EventBus into the same module (project.server.services.tasks),
  // making this a self-loop with no cross-module edge to verify. The
  // service→eventBus relationship is already covered by iter 3's
  // relationship_annotations GT and iter 5's contracts GT (events).
];
