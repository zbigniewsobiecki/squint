import type { GroundTruthImport } from '../../harness/types.js';

/**
 * Imports squint should detect from each fixture file.
 *
 * Notes:
 * - The barrel `index.ts` uses `export ... from` which squint records as
 *   `re-export` type, not `import`.
 * - Type-only imports (`import type { X }`) are still recorded as `import` type.
 * - Local imports use the `.js` extension (TS convention for ESM resolution).
 */
export const imports: GroundTruthImport[] = [
  // src/repositories/tasks.repository.ts
  {
    fromFile: 'src/repositories/tasks.repository.ts',
    source: './base.repository.js',
    type: 'import',
    symbols: [{ name: 'BaseRepository', kind: 'named' }],
  },
  {
    fromFile: 'src/repositories/tasks.repository.ts',
    source: '../types.js',
    type: 'import',
    isTypeOnly: true,
    symbols: [{ name: 'Task', kind: 'named' }],
  },

  // src/services/auth.service.ts
  {
    fromFile: 'src/services/auth.service.ts',
    source: '../types.js',
    type: 'import',
    isTypeOnly: true,
    symbols: [{ name: 'User', kind: 'named' }],
  },

  // src/services/tasks.service.ts
  {
    fromFile: 'src/services/tasks.service.ts',
    source: '../repositories/tasks.repository.js',
    type: 'import',
    symbols: [{ name: 'tasksRepository', kind: 'named' }],
  },
  {
    fromFile: 'src/services/tasks.service.ts',
    source: '../events/event-bus.js',
    type: 'import',
    symbols: [{ name: 'eventBus', kind: 'named' }],
  },
  {
    fromFile: 'src/services/tasks.service.ts',
    source: '../types.js',
    type: 'import',
    isTypeOnly: true,
    symbols: [
      { name: 'NewTaskInput', kind: 'named' },
      { name: 'Task', kind: 'named' },
    ],
  },

  // src/middleware/auth.middleware.ts
  {
    fromFile: 'src/middleware/auth.middleware.ts',
    source: '../services/auth.service.js',
    type: 'import',
    symbols: [{ name: 'authService', kind: 'named' }],
  },
  {
    fromFile: 'src/middleware/auth.middleware.ts',
    source: '../framework.js',
    type: 'import',
    isTypeOnly: true,
    symbols: [{ name: 'Handler', kind: 'named' }],
  },

  // src/controllers/base.controller.ts
  {
    fromFile: 'src/controllers/base.controller.ts',
    source: '../framework.js',
    type: 'import',
    isTypeOnly: true,
    symbols: [{ name: 'Response', kind: 'named' }],
  },

  // src/controllers/auth.controller.ts
  {
    fromFile: 'src/controllers/auth.controller.ts',
    source: './base.controller.js',
    type: 'import',
    symbols: [{ name: 'BaseController', kind: 'named' }],
  },
  {
    fromFile: 'src/controllers/auth.controller.ts',
    source: '../services/auth.service.js',
    type: 'import',
    symbols: [{ name: 'authService', kind: 'named' }],
  },
  {
    fromFile: 'src/controllers/auth.controller.ts',
    source: '../framework.js',
    type: 'import',
    symbols: [
      // Mixed type/value import: `import { type Request, type Response, type Router, createRouter }`
      { name: 'Request', kind: 'named' },
      { name: 'Response', kind: 'named' },
      { name: 'Router', kind: 'named' },
      { name: 'createRouter', kind: 'named' },
    ],
  },

  // src/controllers/tasks.controller.ts
  {
    fromFile: 'src/controllers/tasks.controller.ts',
    source: './base.controller.js',
    type: 'import',
    symbols: [{ name: 'BaseController', kind: 'named' }],
  },
  {
    fromFile: 'src/controllers/tasks.controller.ts',
    source: '../services/tasks.service.js',
    type: 'import',
    symbols: [{ name: 'tasksService', kind: 'named' }],
  },
  {
    fromFile: 'src/controllers/tasks.controller.ts',
    source: '../middleware/auth.middleware.js',
    type: 'import',
    symbols: [{ name: 'requireAuth', kind: 'named' }],
  },
  {
    fromFile: 'src/controllers/tasks.controller.ts',
    source: '../framework.js',
    type: 'import',
    symbols: [
      { name: 'Request', kind: 'named' },
      { name: 'Response', kind: 'named' },
      { name: 'Router', kind: 'named' },
      { name: 'createRouter', kind: 'named' },
    ],
  },

  // src/index.ts
  {
    fromFile: 'src/index.ts',
    source: './controllers/auth.controller.js',
    type: 'import',
    symbols: [{ name: 'authController', kind: 'named' }],
  },
  {
    fromFile: 'src/index.ts',
    source: './controllers/tasks.controller.js',
    type: 'import',
    symbols: [{ name: 'tasksController', kind: 'named' }],
  },
  {
    fromFile: 'src/index.ts',
    source: './framework.js',
    type: 'import',
    symbols: [{ name: 'createApp', kind: 'named' }],
  },

  // client/tasks.client.ts
  {
    fromFile: 'client/tasks.client.ts',
    source: '../src/types.js',
    type: 'import',
    isTypeOnly: true,
    symbols: [
      { name: 'NewTaskInput', kind: 'named' },
      { name: 'Task', kind: 'named' },
    ],
  },

  // index.ts (barrel) — re-exports
  {
    fromFile: 'index.ts',
    source: './src/services/tasks.service.js',
    type: 're-export',
    symbols: [
      { name: 'TasksService', kind: 'named' },
      { name: 'tasksService', kind: 'named' },
    ],
  },
  {
    fromFile: 'index.ts',
    source: './src/services/auth.service.js',
    type: 're-export',
    symbols: [
      { name: 'AuthService', kind: 'named' },
      { name: 'authService', kind: 'named' },
    ],
  },
  {
    fromFile: 'index.ts',
    source: './src/repositories/tasks.repository.js',
    type: 're-export',
    symbols: [
      { name: 'TasksRepository', kind: 'named' },
      { name: 'tasksRepository', kind: 'named' },
    ],
  },
  {
    fromFile: 'index.ts',
    source: './src/events/event-bus.js',
    type: 're-export',
    symbols: [
      { name: 'eventBus', kind: 'named' },
      { name: 'auditLogger', kind: 'named' },
    ],
  },
  {
    fromFile: 'index.ts',
    source: './src/types.js',
    type: 're-export',
    isTypeOnly: true,
    symbols: [
      { name: 'Task', kind: 'named' },
      { name: 'User', kind: 'named' },
      { name: 'NewTaskInput', kind: 'named' },
    ],
  },
];
