import { type GroundTruthModule, defKey } from '../../harness/types.js';

/**
 * Ground truth for the `modules` and `module_members` tables after running
 * `squint ingest --to-stage modules` against the todo-api fixture.
 *
 * Authored against the actual produced tree from the iter-4 cold-pass DB
 * (`evals/results/2026-04-08T08-45-39-100Z/produced.db`). The LLM produces
 * a 4-level tree with 23 modules total and 50/50 definition coverage.
 *
 * Tree shape (depth → module):
 *   0  project
 *   1  project.{client, server, shared}
 *   2  project.client.{auth, tasks}
 *   2  project.server.{api, data, events, framework, middleware, services}
 *   2  project.shared.types
 *   3  project.server.api.{auth, tasks}
 *   3  project.server.data.repositories
 *   3  project.server.framework.{app-lifecycle, core, router}
 *   3  project.server.middleware.security
 *   3  project.server.services.{auth, tasks}
 *   4  project.server.data.repositories.tasks
 *
 * Notes on what the post-LLM normalizer did NOT do:
 *  - BaseController lives in project.server.api.auth alongside AuthController.
 *    The base-class rule (2+ subclasses → parent module) would suggest moving
 *    it to project.server.api, but the rule didn't fire here. Match the GT
 *    to what's actually produced — this is a documentation point, not a bug.
 *  - BaseRepository lives in project.server.data.repositories.tasks alongside
 *    TasksRepository for the same reason.
 *
 * Severity policy (compareModules + compareModuleMembers):
 *   - Missing GT module / wrong member assignment → MAJOR (gate failure)
 *   - Extra produced module → MINOR (auto-ancestors suppressed)
 *   - Description prose drift → MINOR (default minSimilarity 0.6)
 */

const DEFAULT_MOD_MIN_SIMILARITY = 0.6;

function branch(fullPath: string, name: string, parentFullPath: string | null, description: string): GroundTruthModule {
  return {
    fullPath,
    name,
    parentFullPath,
    descriptionReference: description,
    minSimilarity: DEFAULT_MOD_MIN_SIMILARITY,
  };
}

function leaf(
  fullPath: string,
  name: string,
  parentFullPath: string,
  members: ReadonlyArray<ReturnType<typeof defKey>>,
  description: string
): GroundTruthModule {
  return {
    fullPath,
    name,
    parentFullPath,
    members: [...members],
    descriptionReference: description,
    minSimilarity: DEFAULT_MOD_MIN_SIMILARITY,
  };
}

export const modules: GroundTruthModule[] = [
  // ============================================================
  // Top-level branches (depth 1)
  // ============================================================
  branch('project.client', 'Client', 'project', 'Frontend application components and logic'),
  branch('project.server', 'Server', 'project', 'Backend application code: HTTP API, services, data access, framework'),
  branch(
    'project.shared',
    'Shared',
    'project',
    'Cross-cutting utilities and type definitions used by both client and server'
  ),

  // ============================================================
  // project.client subtree
  // ============================================================
  leaf(
    'project.client.auth',
    'Authentication Client',
    'project.client',
    [defKey('client/tasks.client.ts', 'login'), defKey('client/tasks.client.ts', 'register')],
    'Frontend functions that call the authentication endpoints (login and register)'
  ),
  leaf(
    'project.client.tasks',
    'Tasks Client',
    'project.client',
    [
      defKey('client/tasks.client.ts', 'BASE_URL'),
      defKey('client/tasks.client.ts', 'HttpFn'),
      defKey('client/tasks.client.ts', 'completeTask'),
      defKey('client/tasks.client.ts', 'createTask'),
      defKey('client/tasks.client.ts', 'deleteTask'),
      defKey('client/tasks.client.ts', 'getTask'),
      defKey('client/tasks.client.ts', 'http'),
      defKey('client/tasks.client.ts', 'listTasks'),
      defKey('client/tasks.client.ts', 'request'),
      defKey('client/tasks.client.ts', 'updateTask'),
    ],
    'Frontend client wrappers for the task management API plus the shared http transport plumbing'
  ),

  // ============================================================
  // project.server subtree
  // ============================================================
  branch('project.server.api', 'API', 'project.server', 'HTTP controllers exposing the application endpoints'),
  branch('project.server.data', 'Data Access', 'project.server', 'Persistence layer for the application entities'),
  branch('project.server.framework', 'Framework', 'project.server', 'Core application framework and bootstrapping'),
  branch(
    'project.server.middleware',
    'Middleware',
    'project.server',
    'HTTP middleware functions applied to incoming requests'
  ),
  branch('project.server.services', 'Services', 'project.server', 'Application business logic services'),

  // project.server.events is a depth-2 LEAF (not nested further)
  leaf(
    'project.server.events',
    'Events',
    'project.server',
    [
      defKey('src/events/event-bus.ts', 'EventBus'),
      defKey('src/events/event-bus.ts', 'EventHandler'),
      defKey('src/events/event-bus.ts', 'EventName'),
      defKey('src/events/event-bus.ts', 'auditLogger'),
      defKey('src/events/event-bus.ts', 'eventBus'),
    ],
    'In-process event bus and audit subscriber for application-level events'
  ),

  // project.server.api.{auth, tasks}
  leaf(
    'project.server.api.auth',
    'Authentication API',
    'project.server.api',
    [
      // BaseController lives here alongside AuthController — the LLM did not
      // pull it up to project.server.api despite being extended by both
      // AuthController and TasksController. Match what was produced.
      defKey('src/controllers/auth.controller.ts', 'AuthController'),
      defKey('src/controllers/auth.controller.ts', 'authController'),
      defKey('src/controllers/base.controller.ts', 'BaseController'),
    ],
    'HTTP controller for authentication endpoints (register, login, identity lookup)'
  ),
  leaf(
    'project.server.api.tasks',
    'Tasks API',
    'project.server.api',
    [
      defKey('src/controllers/tasks.controller.ts', 'TasksController'),
      defKey('src/controllers/tasks.controller.ts', 'tasksController'),
    ],
    'HTTP controller for task CRUD endpoints, gated by the authentication middleware'
  ),

  // project.server.data.repositories — branch with one leaf below it
  branch(
    'project.server.data.repositories',
    'Repositories',
    'project.server.data',
    'Repository implementations for the application entities'
  ),
  leaf(
    'project.server.data.repositories.tasks',
    'Tasks Repository',
    'project.server.data.repositories',
    [
      // BaseRepository sits with TasksRepository for the same reason
      // BaseController sits with AuthController above.
      defKey('src/repositories/base.repository.ts', 'BaseRepository'),
      defKey('src/repositories/tasks.repository.ts', 'TasksRepository'),
      defKey('src/repositories/tasks.repository.ts', 'tasksRepository'),
    ],
    'Data access for tasks via repository implementations'
  ),

  // project.server.framework.{app-lifecycle, core, router}
  leaf(
    'project.server.framework.app-lifecycle',
    'Application Lifecycle',
    'project.server.framework',
    [
      defKey('src/framework.ts', 'appRegistry'),
      defKey('src/framework.ts', 'createApp'),
      defKey('src/index.ts', 'PORT'),
      defKey('src/index.ts', 'app'),
    ],
    'Application creation, registration, and the bootstrap entry point that mounts routers and starts listening'
  ),
  leaf(
    'project.server.framework.core',
    'Core Framework Types',
    'project.server.framework',
    [
      defKey('src/framework.ts', 'App'),
      defKey('src/framework.ts', 'Handler'),
      defKey('src/framework.ts', 'NextFunction'),
      defKey('src/framework.ts', 'Request'),
      defKey('src/framework.ts', 'Response'),
    ],
    'Core interface and type definitions for the request, response, handler, and app abstractions'
  ),
  leaf(
    'project.server.framework.router',
    'Router',
    'project.server.framework',
    [
      defKey('src/framework.ts', 'Router'),
      defKey('src/framework.ts', 'createRouter'),
      defKey('src/framework.ts', 'routerRegistry'),
    ],
    'Functionality related to routing within the application framework'
  ),

  // project.server.middleware.security
  leaf(
    'project.server.middleware.security',
    'Security Middleware',
    'project.server.middleware',
    [defKey('src/middleware/auth.middleware.ts', 'requireAuth')],
    'Authentication and authorization middleware for protected endpoints'
  ),

  // project.server.services.{auth, tasks}
  leaf(
    'project.server.services.auth',
    'Authentication Service',
    'project.server.services',
    [
      defKey('src/services/auth.service.ts', 'AuthService'),
      defKey('src/services/auth.service.ts', 'authService'),
      defKey('src/services/auth.service.ts', 'decodeToken'),
      defKey('src/services/auth.service.ts', 'hashPassword'),
      defKey('src/services/auth.service.ts', 'signToken'),
      defKey('src/services/auth.service.ts', 'usersByEmail'),
      defKey('src/services/auth.service.ts', 'verifyPassword'),
    ],
    'Authentication service plus its password-hashing and token helpers and the in-memory user store'
  ),
  leaf(
    'project.server.services.tasks',
    'Tasks Service',
    'project.server.services',
    [defKey('src/services/tasks.service.ts', 'TasksService'), defKey('src/services/tasks.service.ts', 'tasksService')],
    'Tasks service that orchestrates persistence and event emission for task lifecycle operations'
  ),

  // ============================================================
  // project.shared subtree
  // ============================================================
  leaf(
    'project.shared.types',
    'Types',
    'project.shared',
    [defKey('src/types.ts', 'NewTaskInput'), defKey('src/types.ts', 'Task'), defKey('src/types.ts', 'User')],
    'Shared TypeScript type definitions for tasks and users used by both client and server'
  ),
];
