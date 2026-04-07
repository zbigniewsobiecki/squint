import type { GroundTruthDefinition } from '../../harness/types.js';

/**
 * Definitions squint should extract from each fixture file. Authored from
 * a careful manual reading of each file. The comparator allows ±2 line
 * tolerance, so minor formatting changes won't break this.
 *
 * Notes on `kind`:
 * - Arrow function consts (e.g. `export const foo = () => {}`) are 'const',
 *   NOT 'function' — squint classifies by declaration type, not value type.
 * - Generic inheritance like `extends BaseRepository<Task>` should yield
 *   `extendsName: 'BaseRepository'` (the type arg is stripped).
 */
export const definitions: GroundTruthDefinition[] = [
  // ----------------------------------------------------------
  // src/framework.ts (8 definitions)
  // ----------------------------------------------------------
  { file: 'src/framework.ts', name: 'Request', kind: 'interface', isExported: true, line: 5 },
  { file: 'src/framework.ts', name: 'Response', kind: 'interface', isExported: true, line: 12 },
  { file: 'src/framework.ts', name: 'NextFunction', kind: 'type', isExported: true, line: 17 },
  { file: 'src/framework.ts', name: 'Handler', kind: 'type', isExported: true, line: 18 },
  { file: 'src/framework.ts', name: 'Router', kind: 'interface', isExported: true, line: 20 },
  { file: 'src/framework.ts', name: 'App', kind: 'interface', isExported: true, line: 28 },
  { file: 'src/framework.ts', name: 'createRouter', kind: 'function', isExported: true, line: 33 },
  { file: 'src/framework.ts', name: 'createApp', kind: 'function', isExported: true, line: 38 },

  // ----------------------------------------------------------
  // src/types.ts (3 definitions)
  // ----------------------------------------------------------
  { file: 'src/types.ts', name: 'Task', kind: 'interface', isExported: true, line: 1 },
  { file: 'src/types.ts', name: 'User', kind: 'interface', isExported: true, line: 11 },
  { file: 'src/types.ts', name: 'NewTaskInput', kind: 'interface', isExported: true, line: 17 },

  // ----------------------------------------------------------
  // src/events/event-bus.ts (5 definitions)
  // ----------------------------------------------------------
  { file: 'src/events/event-bus.ts', name: 'EventName', kind: 'type', isExported: true, line: 5 },
  { file: 'src/events/event-bus.ts', name: 'EventHandler', kind: 'type', isExported: true, line: 7 },
  { file: 'src/events/event-bus.ts', name: 'EventBus', kind: 'class', isExported: true, line: 9 },
  { file: 'src/events/event-bus.ts', name: 'eventBus', kind: 'const', isExported: true, line: 26 },
  { file: 'src/events/event-bus.ts', name: 'auditLogger', kind: 'function', isExported: true, line: 30 },

  // ----------------------------------------------------------
  // src/repositories/base.repository.ts (1 definition)
  // ----------------------------------------------------------
  { file: 'src/repositories/base.repository.ts', name: 'BaseRepository', kind: 'class', isExported: true, line: 5 },

  // ----------------------------------------------------------
  // src/repositories/tasks.repository.ts (2 definitions)
  // ----------------------------------------------------------
  {
    file: 'src/repositories/tasks.repository.ts',
    name: 'TasksRepository',
    kind: 'class',
    isExported: true,
    line: 4,
    extendsName: 'BaseRepository', // Note: NOT 'BaseRepository<Task>' — type arg is stripped
  },
  { file: 'src/repositories/tasks.repository.ts', name: 'tasksRepository', kind: 'const', isExported: true, line: 14 },

  // ----------------------------------------------------------
  // src/services/auth.service.ts (7 definitions, including 5 unexported helpers)
  // ----------------------------------------------------------
  { file: 'src/services/auth.service.ts', name: 'usersByEmail', kind: 'const', isExported: false, line: 6 },
  { file: 'src/services/auth.service.ts', name: 'hashPassword', kind: 'function', isExported: false, line: 8 },
  { file: 'src/services/auth.service.ts', name: 'verifyPassword', kind: 'function', isExported: false, line: 12 },
  { file: 'src/services/auth.service.ts', name: 'signToken', kind: 'function', isExported: false, line: 16 },
  { file: 'src/services/auth.service.ts', name: 'decodeToken', kind: 'function', isExported: false, line: 20 },
  { file: 'src/services/auth.service.ts', name: 'AuthService', kind: 'class', isExported: true, line: 29 },
  { file: 'src/services/auth.service.ts', name: 'authService', kind: 'const', isExported: true, line: 56 },

  // ----------------------------------------------------------
  // src/services/tasks.service.ts (2 definitions)
  // ----------------------------------------------------------
  { file: 'src/services/tasks.service.ts', name: 'TasksService', kind: 'class', isExported: true, line: 5 },
  { file: 'src/services/tasks.service.ts', name: 'tasksService', kind: 'const', isExported: true, line: 51 },

  // ----------------------------------------------------------
  // src/middleware/auth.middleware.ts (1 definition)
  // ----------------------------------------------------------
  { file: 'src/middleware/auth.middleware.ts', name: 'requireAuth', kind: 'const', isExported: true, line: 4 },

  // ----------------------------------------------------------
  // src/controllers/base.controller.ts (1 definition)
  // ----------------------------------------------------------
  { file: 'src/controllers/base.controller.ts', name: 'BaseController', kind: 'class', isExported: true, line: 6 },

  // ----------------------------------------------------------
  // src/controllers/auth.controller.ts (2 definitions)
  // ----------------------------------------------------------
  {
    file: 'src/controllers/auth.controller.ts',
    name: 'AuthController',
    kind: 'class',
    isExported: true,
    line: 5,
    extendsName: 'BaseController',
  },
  { file: 'src/controllers/auth.controller.ts', name: 'authController', kind: 'const', isExported: true, line: 45 },

  // ----------------------------------------------------------
  // src/controllers/tasks.controller.ts (2 definitions)
  // ----------------------------------------------------------
  {
    file: 'src/controllers/tasks.controller.ts',
    name: 'TasksController',
    kind: 'class',
    isExported: true,
    line: 6,
    extendsName: 'BaseController',
  },
  { file: 'src/controllers/tasks.controller.ts', name: 'tasksController', kind: 'const', isExported: true, line: 75 },

  // ----------------------------------------------------------
  // src/index.ts (2 definitions, both unexported)
  // ----------------------------------------------------------
  { file: 'src/index.ts', name: 'app', kind: 'const', isExported: false, line: 8 },
  { file: 'src/index.ts', name: 'PORT', kind: 'const', isExported: false, line: 13 },

  // ----------------------------------------------------------
  // client/tasks.client.ts (12 definitions)
  // ----------------------------------------------------------
  { file: 'client/tasks.client.ts', name: 'BASE_URL', kind: 'const', isExported: false, line: 7 },
  { file: 'client/tasks.client.ts', name: 'HttpFn', kind: 'type', isExported: false, line: 9 },
  { file: 'client/tasks.client.ts', name: 'http', kind: 'const', isExported: false, line: 15 },
  { file: 'client/tasks.client.ts', name: 'request', kind: 'function', isExported: false, line: 20 },
  { file: 'client/tasks.client.ts', name: 'login', kind: 'function', isExported: true, line: 32 },
  { file: 'client/tasks.client.ts', name: 'register', kind: 'function', isExported: true, line: 36 },
  { file: 'client/tasks.client.ts', name: 'listTasks', kind: 'function', isExported: true, line: 40 },
  { file: 'client/tasks.client.ts', name: 'getTask', kind: 'function', isExported: true, line: 44 },
  { file: 'client/tasks.client.ts', name: 'createTask', kind: 'function', isExported: true, line: 48 },
  { file: 'client/tasks.client.ts', name: 'updateTask', kind: 'function', isExported: true, line: 52 },
  { file: 'client/tasks.client.ts', name: 'completeTask', kind: 'function', isExported: true, line: 60 },
  { file: 'client/tasks.client.ts', name: 'deleteTask', kind: 'function', isExported: true, line: 64 },

  // ----------------------------------------------------------
  // index.ts (barrel) — 0 definitions (only re-exports)
  // ----------------------------------------------------------
];
