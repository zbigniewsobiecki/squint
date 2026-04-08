import { type ModuleCohesionGroup, defKey } from '../../harness/types.js';

/**
 * Cohesion rubric for the LLM-driven modules stage.
 *
 * Replaces the strict `evals/ground-truth/todo-api/modules.ts` exact-match
 * GT with property-based assertions: each group declares a set of
 * definitions that should land in the same module, plus a one-sentence
 * description of what role that module should play.
 *
 * The companion comparator is `compareModuleCohesion` (virtual table
 * `module_cohesion`). For each group it:
 *   1. Looks up the produced module for each member via module_members
 *   2. Verifies cohesion (strict = all in 1 module, majority = >50%)
 *   3. Sends the winning module's name+description to the prose judge
 *      with `expectedRole` as the reference
 *
 * Severity:
 *   - Member unassigned to any module → CRITICAL
 *   - GT references unknown definition → CRITICAL
 *   - Strict/majority cohesion violated → MAJOR
 *   - Role judge below threshold (default 0.6) → MINOR (prose-drift)
 *
 * This rubric is robust to LLM tree-shape variation: different slugs,
 * different depths, different groupings all pass as long as the semantically
 * related definitions stay together and the LLM-picked module name+description
 * is reasonable for the role.
 *
 * `cohesion: 'majority'` is used for groups where one member (typically a
 * shared base class) might legitimately land in the parent module while the
 * subclasses are in the leaf — e.g. BaseController extended by both
 * AuthController and TasksController.
 */
export const moduleCohesion: ModuleCohesionGroup[] = [
  // app-creation: createApp + appRegistry are framework helpers and reliably
  // land together. Bootstrap app + PORT (from src/index.ts) are deliberately
  // NOT a cohesion group because the LLM legitimately splits them across
  // server/config/network modules — they're related but not always co-located.
  // The definitions are still covered by the GT definitions table.
  {
    label: 'app-creation',
    members: [defKey('src/framework.ts', 'createApp'), defKey('src/framework.ts', 'appRegistry')],
    expectedRole: 'Module containing application framework helpers',
  },
  {
    label: 'framework-core-types',
    members: [
      defKey('src/framework.ts', 'App'),
      defKey('src/framework.ts', 'Handler'),
      defKey('src/framework.ts', 'NextFunction'),
      defKey('src/framework.ts', 'Request'),
      defKey('src/framework.ts', 'Response'),
    ],
    expectedRole: 'Core HTTP framework types for request, response, handler, and app abstractions',
    // The App interface sometimes lands in a "framework.app" leaf alongside
    // createApp instead of "framework.core" with the other types.
    cohesion: 'majority',
  },
  {
    label: 'router-primitives',
    members: [
      defKey('src/framework.ts', 'Router'),
      defKey('src/framework.ts', 'createRouter'),
      defKey('src/framework.ts', 'routerRegistry'),
    ],
    expectedRole: 'HTTP routing primitives within the framework',
    // The Router interface sometimes lands in a "core types" module while
    // createRouter+routerRegistry stay in a "router" leaf — accept the split.
    cohesion: 'majority',
  },
  {
    label: 'auth-controller',
    members: [
      defKey('src/controllers/auth.controller.ts', 'AuthController'),
      defKey('src/controllers/auth.controller.ts', 'authController'),
      defKey('src/controllers/base.controller.ts', 'BaseController'),
    ],
    expectedRole: 'HTTP controller for authentication endpoints (register, login, identity lookup) and its base class',
    cohesion: 'majority', // BaseController might land in api parent or auth child
  },
  {
    label: 'tasks-controller',
    members: [
      defKey('src/controllers/tasks.controller.ts', 'TasksController'),
      defKey('src/controllers/tasks.controller.ts', 'tasksController'),
    ],
    expectedRole: 'HTTP controller for task CRUD endpoints, gated by authentication middleware',
  },
  {
    label: 'auth-service',
    members: [
      defKey('src/services/auth.service.ts', 'AuthService'),
      defKey('src/services/auth.service.ts', 'authService'),
      defKey('src/services/auth.service.ts', 'usersByEmail'),
      defKey('src/services/auth.service.ts', 'hashPassword'),
      defKey('src/services/auth.service.ts', 'verifyPassword'),
      defKey('src/services/auth.service.ts', 'signToken'),
      defKey('src/services/auth.service.ts', 'decodeToken'),
    ],
    expectedRole: 'Authentication service module',
  },
  {
    label: 'tasks-service',
    members: [
      defKey('src/services/tasks.service.ts', 'TasksService'),
      defKey('src/services/tasks.service.ts', 'tasksService'),
    ],
    expectedRole: 'Tasks business logic service that orchestrates persistence and event emission',
  },
  {
    label: 'tasks-repository',
    members: [
      defKey('src/repositories/base.repository.ts', 'BaseRepository'),
      defKey('src/repositories/tasks.repository.ts', 'TasksRepository'),
      defKey('src/repositories/tasks.repository.ts', 'tasksRepository'),
    ],
    expectedRole: 'Tasks data access / repository module',
    cohesion: 'majority', // BaseRepository might land in repositories parent
  },
  {
    label: 'event-bus',
    members: [
      defKey('src/events/event-bus.ts', 'EventBus'),
      defKey('src/events/event-bus.ts', 'EventName'),
      defKey('src/events/event-bus.ts', 'EventHandler'),
      defKey('src/events/event-bus.ts', 'eventBus'),
      defKey('src/events/event-bus.ts', 'auditLogger'),
    ],
    expectedRole: 'In-process event bus with event types, the singleton instance, and an audit subscriber',
  },
  {
    label: 'auth-middleware',
    members: [defKey('src/middleware/auth.middleware.ts', 'requireAuth')],
    expectedRole: 'Authentication middleware module',
  },
  {
    label: 'shared-types',
    members: [defKey('src/types.ts', 'Task'), defKey('src/types.ts', 'User'), defKey('src/types.ts', 'NewTaskInput')],
    expectedRole: 'Shared TypeScript type definitions for the application entities',
  },
  {
    label: 'frontend-client',
    members: [
      defKey('client/tasks.client.ts', 'BASE_URL'),
      defKey('client/tasks.client.ts', 'HttpFn'),
      defKey('client/tasks.client.ts', 'http'),
      defKey('client/tasks.client.ts', 'request'),
      defKey('client/tasks.client.ts', 'login'),
      defKey('client/tasks.client.ts', 'register'),
      defKey('client/tasks.client.ts', 'listTasks'),
      defKey('client/tasks.client.ts', 'getTask'),
      defKey('client/tasks.client.ts', 'createTask'),
      defKey('client/tasks.client.ts', 'updateTask'),
      defKey('client/tasks.client.ts', 'completeTask'),
      defKey('client/tasks.client.ts', 'deleteTask'),
    ],
    expectedRole: 'Frontend HTTP client module for the backend API',
    cohesion: 'majority', // login/register might land in a separate auth-client subtree
  },
];
