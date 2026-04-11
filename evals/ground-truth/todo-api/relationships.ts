import { type GroundTruthRelationship, defKey } from '../../harness/types.js';

/**
 * Ground truth for the `relationship_annotations` table after running
 * `squint ingest --to-stage relationships` against the todo-api fixture.
 *
 * The comparator treats this list as an EXISTENCE claim: every entry must
 * have a matching produced row, but extra produced rows (call-graph edges
 * we didn't enumerate) are intentionally ignored. This matches how an end
 * user reads the table — "did the LLM annotate the inheritance and the
 * core uses edges?" rather than "did it produce exactly N edges".
 *
 * Severity policy (from compareRelationshipAnnotations):
 *   - Missing GT edge      → CRITICAL (LLM dropped a real edge OR GT is wrong)
 *   - Wrong relationship_type → MAJOR
 *   - PENDING_LLM_ANNOTATION leaked through → MAJOR
 *   - Prose drift below threshold → MINOR (does not flip the gate)
 *
 * Default minSimilarity is 0.6 (vs 0.75 for definition_metadata): the LLM
 * relationship prompt asks for terse 1-sentence justifications, so the
 * cosine similarity to a hand-written reference is naturally lower than
 * for the longer 'purpose' field. Iteration 2 confirmed 0.6 is the right
 * floor for terse semantic descriptions.
 */
const DEFAULT_REL_MIN_SIMILARITY = 0.6;

function uses(
  fromFile: string,
  fromName: string,
  toFile: string,
  toName: string,
  semantic: string,
  minSimilarity: number = DEFAULT_REL_MIN_SIMILARITY
): GroundTruthRelationship {
  return {
    fromDef: defKey(fromFile, fromName),
    toDef: defKey(toFile, toName),
    relationshipType: 'uses',
    semanticReference: semantic,
    minSimilarity,
  };
}

function extendsRel(
  fromFile: string,
  fromName: string,
  toFile: string,
  toName: string,
  semantic: string,
  minSimilarity: number = DEFAULT_REL_MIN_SIMILARITY
): GroundTruthRelationship {
  return {
    fromDef: defKey(fromFile, fromName),
    toDef: defKey(toFile, toName),
    relationshipType: 'extends',
    semanticReference: semantic,
    minSimilarity,
  };
}

export const relationships: GroundTruthRelationship[] = [
  // ============================================================
  // Inheritance (3 edges) — Phase 2 of relationships annotate.
  // These start at parse time as PENDING_LLM_ANNOTATION; the eval
  // verifies the LLM replaces every one. A leaked placeholder = MAJOR.
  // ============================================================
  extendsRel(
    'src/repositories/tasks.repository.ts',
    'TasksRepository',
    'src/repositories/base.repository.ts',
    'BaseRepository',
    'specializes the generic in-memory repository with task-specific filtering by owner and completion state'
  ),
  extendsRel(
    'src/controllers/auth.controller.ts',
    'AuthController',
    'src/controllers/base.controller.ts',
    'BaseController',
    'inherits common HTTP response helpers (success, fail, error handling) for the authentication endpoints'
  ),
  extendsRel(
    'src/controllers/tasks.controller.ts',
    'TasksController',
    'src/controllers/base.controller.ts',
    'BaseController',
    'inherits common HTTP response helpers (success, fail, error handling) for the task management endpoints'
  ),

  // ============================================================
  // Framework — module-level mutable registries make these unambiguously impure.
  // ============================================================
  uses(
    'src/framework.ts',
    'createRouter',
    'src/framework.ts',
    'routerRegistry',
    'records every router instance in the module-level registry for runtime tracking'
  ),
  uses(
    'src/framework.ts',
    'createApp',
    'src/framework.ts',
    'appRegistry',
    'records every app instance in the module-level registry for runtime tracking'
  ),

  // ============================================================
  // Event bus — singleton instantiation.
  // ============================================================
  uses(
    'src/events/event-bus.ts',
    'eventBus',
    'src/events/event-bus.ts',
    'EventBus',
    'creates the singleton event bus instance shared across the application'
  ),

  // ============================================================
  // Repositories — singleton instantiation of TasksRepository.
  // ============================================================
  uses(
    'src/repositories/tasks.repository.ts',
    'tasksRepository',
    'src/repositories/tasks.repository.ts',
    'TasksRepository',
    'creates the singleton tasks repository instance for application-wide use'
  ),

  // ============================================================
  // Auth service — class methods access the in-memory user store and
  // the password/token helpers.
  // ============================================================
  uses(
    'src/services/auth.service.ts',
    'AuthService',
    'src/services/auth.service.ts',
    'usersByEmail',
    'reads and writes the in-memory user store keyed by email for registration and login'
  ),
  uses(
    'src/services/auth.service.ts',
    'AuthService',
    'src/services/auth.service.ts',
    'hashPassword',
    'hashes new user passwords during registration before persisting them'
  ),
  uses(
    'src/services/auth.service.ts',
    'AuthService',
    'src/services/auth.service.ts',
    'verifyPassword',
    'verifies submitted credentials against the stored password hash during login'
  ),
  uses(
    'src/services/auth.service.ts',
    'AuthService',
    'src/services/auth.service.ts',
    'signToken',
    'signs an authentication token after successful registration or login'
  ),
  uses(
    'src/services/auth.service.ts',
    'AuthService',
    'src/services/auth.service.ts',
    'decodeToken',
    'decodes the bearer token to identify the requesting user'
  ),
  uses(
    'src/services/auth.service.ts',
    'decodeToken',
    'src/services/auth.service.ts',
    'usersByEmail',
    'looks up the authenticated user from the in-memory store by decoded id'
  ),
  uses(
    'src/services/auth.service.ts',
    'authService',
    'src/services/auth.service.ts',
    'AuthService',
    'creates the singleton auth service instance for application-wide use'
  ),

  // ============================================================
  // Tasks service — orchestrates persistence and event emission.
  // ============================================================
  uses(
    'src/services/tasks.service.ts',
    'TasksService',
    'src/repositories/tasks.repository.ts',
    'tasksRepository',
    'persists and queries tasks through the repository abstraction'
  ),
  uses(
    'src/services/tasks.service.ts',
    'TasksService',
    'src/events/event-bus.ts',
    'eventBus',
    'publishes task lifecycle events (created, completed) for downstream consumers'
  ),
  uses(
    'src/services/tasks.service.ts',
    'tasksService',
    'src/services/tasks.service.ts',
    'TasksService',
    'creates the singleton tasks service instance for application-wide use'
  ),

  // ============================================================
  // Middleware — bearer-token validation gate.
  // ============================================================
  uses(
    'src/middleware/auth.middleware.ts',
    'requireAuth',
    'src/services/auth.service.ts',
    'authService',
    'validates the bearer token via the auth service and rejects unauthenticated requests'
  ),

  // ============================================================
  // Auth controller — wires HTTP endpoints to the auth service.
  // ============================================================
  uses(
    'src/controllers/auth.controller.ts',
    'AuthController',
    'src/services/auth.service.ts',
    'authService',
    'delegates registration, login, and identity lookup to the auth service'
  ),
  uses(
    'src/controllers/auth.controller.ts',
    'AuthController',
    'src/framework.ts',
    'createRouter',
    'creates a router during construction to register the authentication endpoints'
  ),
  uses(
    'src/controllers/auth.controller.ts',
    'authController',
    'src/controllers/auth.controller.ts',
    'AuthController',
    'creates the singleton auth controller instance mounted by the bootstrap'
  ),

  // ============================================================
  // Tasks controller — wires HTTP endpoints to the tasks service,
  // gated by the auth middleware.
  // ============================================================
  uses(
    'src/controllers/tasks.controller.ts',
    'TasksController',
    'src/services/tasks.service.ts',
    'tasksService',
    'delegates CRUD operations on tasks to the tasks service'
  ),
  uses(
    'src/controllers/tasks.controller.ts',
    'TasksController',
    'src/framework.ts',
    'createRouter',
    'creates a router during construction to register the task management endpoints'
  ),
  uses(
    'src/controllers/tasks.controller.ts',
    'TasksController',
    'src/middleware/auth.middleware.ts',
    'requireAuth',
    'guards every task endpoint with the bearer-token authentication middleware'
  ),
  uses(
    'src/controllers/tasks.controller.ts',
    'tasksController',
    'src/controllers/tasks.controller.ts',
    'TasksController',
    'creates the singleton tasks controller instance mounted by the bootstrap'
  ),

  // ============================================================
  // Bootstrap (src/index.ts) — wires the app and mounts routers.
  // The `app` const is the natural anchor for the call-graph edges
  // emitted at module top-level.
  // ============================================================
  uses('src/index.ts', 'app', 'src/framework.ts', 'createApp', 'constructs the application instance during bootstrap'),

  // ============================================================
  // Frontend client — every endpoint wrapper funnels through `request`,
  // which itself routes through the http transport.
  //
  // NOTE: `request → BASE_URL` is NOT enumerated. The reference
  // (`http(\`${BASE_URL}${path}\`, ...)`) is a bare identifier inside
  // a template literal, and squint's call-graph extractor only tracks
  // CALLS, INSTANTIATIONS, and INHERITANCE — not arbitrary identifier
  // references. This is a deliberate scope choice, not a bug. If squint
  // ever grows reference-level tracking, this entry should be added back.
  // ============================================================
  uses(
    'client/tasks.client.ts',
    'request',
    'client/tasks.client.ts',
    'http',
    'sends the request through the injected http transport (fetch)'
  ),
  uses(
    'client/tasks.client.ts',
    'login',
    'client/tasks.client.ts',
    'request',
    'submits the login credentials through the shared request helper'
  ),
  uses(
    'client/tasks.client.ts',
    'register',
    'client/tasks.client.ts',
    'request',
    'submits the registration payload through the shared request helper'
  ),
  uses(
    'client/tasks.client.ts',
    'listTasks',
    'client/tasks.client.ts',
    'request',
    'fetches the authenticated user’s tasks through the shared request helper'
  ),
  uses(
    'client/tasks.client.ts',
    'getTask',
    'client/tasks.client.ts',
    'request',
    'fetches a single task by id through the shared request helper'
  ),
  uses(
    'client/tasks.client.ts',
    'createTask',
    'client/tasks.client.ts',
    'request',
    'submits a new task payload through the shared request helper'
  ),
  uses(
    'client/tasks.client.ts',
    'updateTask',
    'client/tasks.client.ts',
    'request',
    'submits a task update payload through the shared request helper'
  ),
  uses(
    'client/tasks.client.ts',
    'completeTask',
    'client/tasks.client.ts',
    'request',
    'marks a task as completed through the shared request helper'
  ),
  uses(
    'client/tasks.client.ts',
    'deleteTask',
    'client/tasks.client.ts',
    'request',
    'removes a task by id through the shared request helper'
  ),
];
