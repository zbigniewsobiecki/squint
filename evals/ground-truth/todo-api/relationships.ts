import type { GroundTruthRelationship } from '../../harness/types.js';
import { assertedRelationship } from '../_shared/assertion-builders.js';

/**
 * Ground truth for the `relationship_annotations` table after running
 * `squint ingest --to-stage relationships` against the todo-api fixture.
 *
 * PR4: migrated from `semanticReference` prose-similarity to property-based
 * assertions. Each entry asserts factual properties about the produced
 * semantic field instead of paraphrasing the LLM's exact wording.
 *
 * The comparator treats this list as an EXISTENCE claim: every entry must
 * have a matching produced row, but extra produced rows (call-graph edges
 * we didn't enumerate) are intentionally ignored. This matches how an end
 * user reads the table — "did the LLM annotate the inheritance and the
 * core uses edges?" rather than "did it produce exactly N edges".
 *
 * Severity policy (from compareRelationshipAnnotations):
 *   - Missing GT edge      → CRITICAL
 *   - Wrong relationship_type → MAJOR
 *   - PENDING_LLM_ANNOTATION leaked through → MAJOR
 *   - Assertion failure → MINOR (counted in proseChecks.failed)
 */
export const relationships: GroundTruthRelationship[] = [
  // ============================================================
  // Inheritance (3 edges)
  // ============================================================
  assertedRelationship(
    'src/repositories/tasks.repository.ts',
    'TasksRepository',
    'src/repositories/base.repository.ts',
    'BaseRepository',
    'extends',
    {
      anyOf: ['inherit', 'extend', 'specialize', 'task', 'repository', 'crud', 'generic'],
    }
  ),
  assertedRelationship(
    'src/controllers/auth.controller.ts',
    'AuthController',
    'src/controllers/base.controller.ts',
    'BaseController',
    'extends',
    {
      anyOf: ['inherit', 'extend', 'shared', 'helper', 'response', 'controller', 'auth'],
    }
  ),
  assertedRelationship(
    'src/controllers/tasks.controller.ts',
    'TasksController',
    'src/controllers/base.controller.ts',
    'BaseController',
    'extends',
    {
      anyOf: ['inherit', 'extend', 'shared', 'helper', 'response', 'controller', 'task'],
    }
  ),

  // ============================================================
  // Framework — module-level mutable registries
  // ============================================================
  assertedRelationship('src/framework.ts', 'createRouter', 'src/framework.ts', 'routerRegistry', 'uses', {
    anyOf: ['register', 'router', 'instance', 'tracking', 'add', 'push'],
  }),
  assertedRelationship('src/framework.ts', 'createApp', 'src/framework.ts', 'appRegistry', 'uses', {
    anyOf: ['register', 'app', 'instance', 'tracking', 'add', 'push'],
  }),

  // ============================================================
  // Event bus
  // ============================================================
  assertedRelationship('src/events/event-bus.ts', 'eventBus', 'src/events/event-bus.ts', 'EventBus', 'uses', {
    anyOf: ['create', 'instance', 'singleton', 'event', 'bus', 'shared'],
  }),

  // ============================================================
  // Repositories — singleton instantiation
  // ============================================================
  assertedRelationship(
    'src/repositories/tasks.repository.ts',
    'tasksRepository',
    'src/repositories/tasks.repository.ts',
    'TasksRepository',
    'uses',
    {
      anyOf: ['create', 'instance', 'singleton', 'task', 'repository', 'shared'],
    }
  ),

  // ============================================================
  // Auth service — class methods access user store + token helpers
  // ============================================================
  assertedRelationship(
    'src/services/auth.service.ts',
    'AuthService',
    'src/services/auth.service.ts',
    'usersByEmail',
    'uses',
    {
      anyOf: ['user', 'store', 'email', 'register', 'login', 'lookup', 'map'],
    }
  ),
  assertedRelationship(
    'src/services/auth.service.ts',
    'AuthService',
    'src/services/auth.service.ts',
    'hashPassword',
    'uses',
    {
      anyOf: ['hash', 'password', 'register', 'persist', 'store'],
    }
  ),
  assertedRelationship(
    'src/services/auth.service.ts',
    'AuthService',
    'src/services/auth.service.ts',
    'verifyPassword',
    'uses',
    {
      anyOf: ['verify', 'password', 'login', 'compare', 'check'],
    }
  ),
  assertedRelationship(
    'src/services/auth.service.ts',
    'AuthService',
    'src/services/auth.service.ts',
    'signToken',
    'uses',
    {
      anyOf: ['sign', 'token', 'authentication', 'session', 'login', 'register'],
    }
  ),
  assertedRelationship(
    'src/services/auth.service.ts',
    'AuthService',
    'src/services/auth.service.ts',
    'decodeToken',
    'uses',
    {
      anyOf: ['decode', 'token', 'identify', 'verify', 'session', 'user'],
    }
  ),
  assertedRelationship(
    'src/services/auth.service.ts',
    'decodeToken',
    'src/services/auth.service.ts',
    'usersByEmail',
    'uses',
    {
      anyOf: ['user', 'lookup', 'email', 'store', 'find'],
    }
  ),
  assertedRelationship(
    'src/services/auth.service.ts',
    'authService',
    'src/services/auth.service.ts',
    'AuthService',
    'uses',
    {
      anyOf: ['create', 'instance', 'singleton', 'auth', 'service', 'shared'],
    }
  ),

  // ============================================================
  // Tasks service
  // ============================================================
  assertedRelationship(
    'src/services/tasks.service.ts',
    'TasksService',
    'src/repositories/tasks.repository.ts',
    'tasksRepository',
    'uses',
    {
      anyOf: ['persist', 'task', 'repository', 'query', 'crud', 'storage'],
    }
  ),
  assertedRelationship('src/services/tasks.service.ts', 'TasksService', 'src/events/event-bus.ts', 'eventBus', 'uses', {
    anyOf: ['publish', 'event', 'task', 'lifecycle', 'emit'],
  }),
  assertedRelationship(
    'src/services/tasks.service.ts',
    'tasksService',
    'src/services/tasks.service.ts',
    'TasksService',
    'uses',
    {
      anyOf: ['create', 'instance', 'singleton', 'task', 'service', 'shared'],
    }
  ),

  // ============================================================
  // Middleware — bearer-token validation gate
  // ============================================================
  assertedRelationship(
    'src/middleware/auth.middleware.ts',
    'requireAuth',
    'src/services/auth.service.ts',
    'authService',
    'uses',
    {
      anyOf: ['validate', 'token', 'auth', 'reject', 'unauthenticated', 'verify', 'bearer'],
    }
  ),

  // ============================================================
  // Auth controller
  // ============================================================
  assertedRelationship(
    'src/controllers/auth.controller.ts',
    'AuthController',
    'src/services/auth.service.ts',
    'authService',
    'uses',
    {
      anyOf: ['delegate', 'register', 'login', 'auth', 'service'],
    }
  ),
  assertedRelationship(
    'src/controllers/auth.controller.ts',
    'AuthController',
    'src/framework.ts',
    'createRouter',
    'uses',
    {
      anyOf: ['create', 'router', 'register', 'endpoint', 'route', 'auth'],
    }
  ),
  assertedRelationship(
    'src/controllers/auth.controller.ts',
    'authController',
    'src/controllers/auth.controller.ts',
    'AuthController',
    'uses',
    {
      anyOf: ['create', 'instance', 'singleton', 'auth', 'controller', 'mount'],
    }
  ),

  // ============================================================
  // Tasks controller
  // ============================================================
  assertedRelationship(
    'src/controllers/tasks.controller.ts',
    'TasksController',
    'src/services/tasks.service.ts',
    'tasksService',
    'uses',
    {
      anyOf: ['delegate', 'task', 'service', 'crud'],
    }
  ),
  assertedRelationship(
    'src/controllers/tasks.controller.ts',
    'TasksController',
    'src/framework.ts',
    'createRouter',
    'uses',
    {
      anyOf: ['create', 'router', 'register', 'endpoint', 'route', 'task'],
    }
  ),
  assertedRelationship(
    'src/controllers/tasks.controller.ts',
    'TasksController',
    'src/middleware/auth.middleware.ts',
    'requireAuth',
    'uses',
    {
      anyOf: ['guard', 'middleware', 'auth', 'protect', 'token', 'endpoint'],
    }
  ),
  assertedRelationship(
    'src/controllers/tasks.controller.ts',
    'tasksController',
    'src/controllers/tasks.controller.ts',
    'TasksController',
    'uses',
    {
      anyOf: ['create', 'instance', 'singleton', 'task', 'controller', 'mount'],
    }
  ),

  // ============================================================
  // Bootstrap (src/index.ts)
  // ============================================================
  assertedRelationship('src/index.ts', 'app', 'src/framework.ts', 'createApp', 'uses', {
    anyOf: ['create', 'app', 'application', 'bootstrap', 'construct'],
  }),

  // ============================================================
  // Frontend client
  // ============================================================
  assertedRelationship('client/tasks.client.ts', 'request', 'client/tasks.client.ts', 'http', 'uses', {
    anyOf: ['http', 'fetch', 'transport', 'send', 'request'],
  }),
  assertedRelationship('client/tasks.client.ts', 'login', 'client/tasks.client.ts', 'request', 'uses', {
    anyOf: ['login', 'credential', 'submit', 'helper', 'request'],
  }),
  assertedRelationship('client/tasks.client.ts', 'register', 'client/tasks.client.ts', 'request', 'uses', {
    anyOf: ['register', 'submit', 'helper', 'request', 'create'],
  }),
  assertedRelationship('client/tasks.client.ts', 'listTasks', 'client/tasks.client.ts', 'request', 'uses', {
    anyOf: ['list', 'fetch', 'task', 'helper', 'request'],
  }),
  assertedRelationship('client/tasks.client.ts', 'getTask', 'client/tasks.client.ts', 'request', 'uses', {
    anyOf: ['get', 'fetch', 'task', 'helper', 'request', 'id'],
  }),
  assertedRelationship('client/tasks.client.ts', 'createTask', 'client/tasks.client.ts', 'request', 'uses', {
    anyOf: ['create', 'submit', 'task', 'helper', 'request'],
  }),
  assertedRelationship('client/tasks.client.ts', 'updateTask', 'client/tasks.client.ts', 'request', 'uses', {
    anyOf: ['update', 'submit', 'task', 'helper', 'request'],
  }),
  assertedRelationship('client/tasks.client.ts', 'completeTask', 'client/tasks.client.ts', 'request', 'uses', {
    anyOf: ['complete', 'mark', 'task', 'helper', 'request'],
  }),
  assertedRelationship('client/tasks.client.ts', 'deleteTask', 'client/tasks.client.ts', 'request', 'uses', {
    anyOf: ['delete', 'remove', 'task', 'helper', 'request'],
  }),
];
