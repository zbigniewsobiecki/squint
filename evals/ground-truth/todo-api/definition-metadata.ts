import type { GroundTruthDefinitionMetadata } from '../../harness/types.js';
import { assertedDomain, assertedPurpose, exactPure } from '../_shared/assertion-builders.js';

/**
 * Ground truth for the `definition_metadata` table after running squint's
 * symbols annotate stage on todo-api.
 *
 * PR4: migrated from prose-similarity grading to property-based assertions.
 * Each entry asserts factual properties about the produced output instead
 * of trying to paraphrase the LLM's exact phrasing.
 *
 * Aspects covered:
 * - purpose: assertedPurpose with `mentions`/`anyOf`/`forbids`
 * - domain:  assertedDomain with `anyOf`/`noneOf`
 * - pure:    exactPure with a boolean
 *
 * Coverage exceptions:
 * - Type aliases and interfaces: purpose only
 * - Primitive constants (BASE_URL, PORT): purpose only
 * - Everything else: all 3 aspects
 */
export const definitionMetadata: GroundTruthDefinitionMetadata[] = [
  // ----------------------------------------------------------
  // src/framework.ts — minimal in-fixture HTTP framework
  // ----------------------------------------------------------
  // Interfaces and types: purpose only
  assertedPurpose('src/framework.ts', 'Request', {
    anyOf: ['request', 'http', 'incoming'],
  }),
  assertedPurpose('src/framework.ts', 'Response', {
    anyOf: ['response', 'http', 'outgoing', 'json', 'status'],
  }),
  assertedPurpose('src/framework.ts', 'NextFunction', {
    anyOf: ['next', 'middleware', 'callback', 'pass', 'control'],
  }),
  assertedPurpose('src/framework.ts', 'Handler', {
    anyOf: ['handler', 'middleware', 'request', 'response', 'function', 'route'],
  }),
  assertedPurpose('src/framework.ts', 'Router', {
    anyOf: ['router', 'route', 'method', 'register', 'http'],
  }),
  assertedPurpose('src/framework.ts', 'App', {
    anyOf: ['app', 'application', 'mount', 'server', 'http'],
  }),

  // Module-level registries
  assertedPurpose('src/framework.ts', 'routerRegistry', {
    anyOf: ['router', 'registry', 'array', 'list', 'instance', 'tracking'],
  }),
  assertedDomain('src/framework.ts', 'routerRegistry', {
    anyOf: ['router', 'framework', 'registry', 'http', 'routing', 'configuration'],
    noneOf: ['user-management', 'authentication', 'task-management', 'event-bus'],
  }),
  exactPure('src/framework.ts', 'routerRegistry', false),

  assertedPurpose('src/framework.ts', 'appRegistry', {
    anyOf: ['app', 'registry', 'array', 'list', 'instance', 'tracking'],
  }),
  assertedDomain('src/framework.ts', 'appRegistry', {
    anyOf: ['app', 'application', 'framework', 'registry', 'http', 'routing', 'configuration'],
    noneOf: ['user-management', 'authentication', 'task-management', 'event-bus'],
  }),
  exactPure('src/framework.ts', 'appRegistry', false),

  // Functions
  assertedPurpose('src/framework.ts', 'createRouter', {
    anyOf: ['create', 'construct', 'router', 'factory'],
  }),
  assertedDomain('src/framework.ts', 'createRouter', {
    anyOf: ['router', 'framework', 'http', 'factory'],
    noneOf: ['user', 'auth', 'task', 'event'],
  }),
  exactPure('src/framework.ts', 'createRouter', false),

  assertedPurpose('src/framework.ts', 'createApp', {
    anyOf: ['create', 'construct', 'app', 'application', 'factory'],
  }),
  assertedDomain('src/framework.ts', 'createApp', {
    anyOf: ['app', 'application', 'framework', 'http', 'factory'],
    noneOf: ['user', 'auth', 'task', 'event'],
  }),
  exactPure('src/framework.ts', 'createApp', false),

  // ----------------------------------------------------------
  // src/types.ts — domain types
  // ----------------------------------------------------------
  assertedPurpose('src/types.ts', 'Task', {
    mentions: ['task'],
    anyOf: ['entity', 'id', 'title', 'completion', 'owner'],
  }),
  assertedPurpose('src/types.ts', 'User', {
    mentions: ['user'],
    anyOf: ['entity', 'id', 'email', 'password', 'authentication'],
  }),
  assertedPurpose('src/types.ts', 'NewTaskInput', {
    anyOf: ['task', 'input', 'payload', 'create', 'title', 'description'],
  }),

  // ----------------------------------------------------------
  // src/events/event-bus.ts — in-memory pub/sub
  // ----------------------------------------------------------
  assertedPurpose('src/events/event-bus.ts', 'EventName', {
    anyOf: ['event', 'name', 'union', 'type'],
  }),
  assertedPurpose('src/events/event-bus.ts', 'EventHandler', {
    anyOf: ['event', 'handler', 'callback', 'subscriber', 'payload'],
  }),

  assertedPurpose('src/events/event-bus.ts', 'EventBus', {
    anyOf: ['event', 'bus', 'subscribe', 'publish', 'pub', 'sub', 'emit'],
    forbids: ['task management', 'user management'],
  }),
  assertedDomain('src/events/event-bus.ts', 'EventBus', {
    anyOf: ['event', 'bus', 'pub', 'sub', 'message', 'observer'],
    noneOf: ['task-management', 'user-management', 'authentication'],
  }),
  exactPure('src/events/event-bus.ts', 'EventBus', false),

  assertedPurpose('src/events/event-bus.ts', 'eventBus', {
    anyOf: ['singleton', 'instance', 'shared', 'event', 'bus'],
  }),
  assertedDomain('src/events/event-bus.ts', 'eventBus', {
    anyOf: ['event', 'bus', 'pub', 'sub', 'singleton'],
    noneOf: ['task-management', 'user-management'],
  }),
  exactPure('src/events/event-bus.ts', 'eventBus', false),

  assertedPurpose('src/events/event-bus.ts', 'auditLogger', {
    anyOf: ['audit', 'log', 'subscribe', 'event', 'task', 'completion'],
  }),
  assertedDomain('src/events/event-bus.ts', 'auditLogger', {
    anyOf: ['audit', 'log', 'event', 'observability', 'subscriber'],
    noneOf: ['authentication', 'http-client'],
  }),
  exactPure('src/events/event-bus.ts', 'auditLogger', false),

  // ----------------------------------------------------------
  // src/repositories/base.repository.ts
  // ----------------------------------------------------------
  assertedPurpose('src/repositories/base.repository.ts', 'BaseRepository', {
    anyOf: ['repository', 'crud', 'persistence', 'generic', 'abstract', 'storage'],
  }),
  assertedDomain('src/repositories/base.repository.ts', 'BaseRepository', {
    anyOf: ['repository', 'persistence', 'storage', 'crud', 'base', 'data'],
    noneOf: ['authentication', 'http-server', 'event-bus'],
  }),
  exactPure('src/repositories/base.repository.ts', 'BaseRepository', false),

  // ----------------------------------------------------------
  // src/repositories/tasks.repository.ts
  // ----------------------------------------------------------
  assertedPurpose('src/repositories/tasks.repository.ts', 'TasksRepository', {
    mentions: ['task'],
    anyOf: ['repository', 'crud', 'persistence', 'storage', 'find', 'owner'],
  }),
  assertedDomain('src/repositories/tasks.repository.ts', 'TasksRepository', {
    anyOf: ['task', 'repository', 'persistence', 'storage'],
    noneOf: ['authentication', 'http-server', 'event-bus'],
  }),
  exactPure('src/repositories/tasks.repository.ts', 'TasksRepository', false),

  assertedPurpose('src/repositories/tasks.repository.ts', 'tasksRepository', {
    anyOf: ['singleton', 'instance', 'shared', 'task', 'repository'],
  }),
  assertedDomain('src/repositories/tasks.repository.ts', 'tasksRepository', {
    anyOf: ['task', 'repository', 'persistence', 'storage', 'singleton'],
    noneOf: ['authentication', 'http-server', 'event-bus'],
  }),
  exactPure('src/repositories/tasks.repository.ts', 'tasksRepository', false),

  // ----------------------------------------------------------
  // src/services/auth.service.ts
  // ----------------------------------------------------------
  assertedPurpose('src/services/auth.service.ts', 'usersByEmail', {
    anyOf: ['user', 'map', 'store', 'email', 'memory', 'in-memory'],
  }),
  assertedDomain('src/services/auth.service.ts', 'usersByEmail', {
    anyOf: ['user', 'auth', 'storage', 'memory', 'identity'],
    noneOf: ['task', 'event', 'http-server'],
  }),
  exactPure('src/services/auth.service.ts', 'usersByEmail', false),

  // hashPassword: the LLM tends to skip the "stub" caveat. Forbid the
  // exact misleading phrase the LLM produced ("storing user passwords
  // securely") so we catch that drift class.
  assertedPurpose('src/services/auth.service.ts', 'hashPassword', {
    anyOf: ['hash', 'password', 'prefix', 'stub'],
    forbids: ['actually secure', 'cryptographically secure', 'securely store'],
  }),
  assertedDomain('src/services/auth.service.ts', 'hashPassword', {
    anyOf: ['password', 'hash', 'crypto', 'auth', 'security'],
    noneOf: ['task', 'event'],
  }),
  exactPure('src/services/auth.service.ts', 'hashPassword', true),

  assertedPurpose('src/services/auth.service.ts', 'verifyPassword', {
    anyOf: ['verify', 'compare', 'password', 'hash', 'match'],
  }),
  assertedDomain('src/services/auth.service.ts', 'verifyPassword', {
    anyOf: ['password', 'verify', 'auth', 'security'],
    noneOf: ['task', 'event'],
  }),
  exactPure('src/services/auth.service.ts', 'verifyPassword', true),

  assertedPurpose('src/services/auth.service.ts', 'signToken', {
    anyOf: ['token', 'sign', 'session', 'authenticated', 'user'],
  }),
  // PR4 calibration: the LLM consistently tags auth-related symbols as
  // 'user-management' or 'security' or 'dependency-injection' — all
  // defensible (auth IS managing users for credential purposes; the
  // singleton instances ARE dependency-injection wiring). We accept those
  // as equivalent to identity/auth tags. Still ban task/event domains.
  assertedDomain('src/services/auth.service.ts', 'signToken', {
    anyOf: ['token', 'auth', 'session', 'sign', 'identity', 'user', 'security', 'jwt'],
    noneOf: ['task-management', 'event-bus'],
  }),
  exactPure('src/services/auth.service.ts', 'signToken', true),

  assertedPurpose('src/services/auth.service.ts', 'decodeToken', {
    anyOf: ['decode', 'token', 'parse', 'user', 'session'],
  }),
  assertedDomain('src/services/auth.service.ts', 'decodeToken', {
    anyOf: ['token', 'auth', 'session', 'decode', 'identity', 'user', 'security', 'jwt'],
    noneOf: ['task-management', 'event-bus'],
  }),
  exactPure('src/services/auth.service.ts', 'decodeToken', false),

  assertedPurpose('src/services/auth.service.ts', 'AuthService', {
    anyOf: ['auth', 'authentication', 'service', 'register', 'login', 'token'],
  }),
  assertedDomain('src/services/auth.service.ts', 'AuthService', {
    anyOf: ['auth', 'authentication', 'service', 'identity', 'session', 'user', 'security'],
    noneOf: ['task-management', 'event-bus'],
  }),
  exactPure('src/services/auth.service.ts', 'AuthService', false),

  assertedPurpose('src/services/auth.service.ts', 'authService', {
    anyOf: ['singleton', 'instance', 'shared', 'auth', 'service', 'dependency'],
  }),
  assertedDomain('src/services/auth.service.ts', 'authService', {
    anyOf: ['auth', 'service', 'singleton', 'identity', 'user', 'security', 'dependency', 'injection'],
    noneOf: ['task-management', 'event-bus'],
  }),
  exactPure('src/services/auth.service.ts', 'authService', false),

  // ----------------------------------------------------------
  // src/services/tasks.service.ts
  // ----------------------------------------------------------
  assertedPurpose('src/services/tasks.service.ts', 'TasksService', {
    mentions: ['task'],
    // Use stems ('creat', 'updat', 'delet') so substring matching catches
    // both verb forms ('create') and gerunds ('creating') — see the
    // substring trap note in assertion-builders.ts. Plus broad CRUD-flavoured
    // synonyms ('manage', 'operation', 'business', 'logic') that match
    // whichever vocabulary the LLM picks for a service-layer description.
    anyOf: [
      'service',
      'crud',
      'orchestrat',
      'creat',
      'updat',
      'delet',
      'event',
      'manage',
      'operation',
      'business',
      'logic',
    ],
  }),
  assertedDomain('src/services/tasks.service.ts', 'TasksService', {
    anyOf: ['task', 'service', 'crud', 'orchestration'],
    noneOf: ['authentication', 'http-server'],
  }),
  exactPure('src/services/tasks.service.ts', 'TasksService', false),

  assertedPurpose('src/services/tasks.service.ts', 'tasksService', {
    anyOf: ['singleton', 'instance', 'shared', 'task', 'service'],
  }),
  assertedDomain('src/services/tasks.service.ts', 'tasksService', {
    anyOf: ['task', 'service', 'singleton'],
    noneOf: ['authentication', 'http-server'],
  }),
  exactPure('src/services/tasks.service.ts', 'tasksService', false),

  // ----------------------------------------------------------
  // src/middleware/auth.middleware.ts
  // ----------------------------------------------------------
  assertedPurpose('src/middleware/auth.middleware.ts', 'requireAuth', {
    anyOf: ['middleware', 'token', 'authorization', 'bearer', 'authenticate', 'guard', 'reject', '401'],
  }),
  assertedDomain('src/middleware/auth.middleware.ts', 'requireAuth', {
    anyOf: ['middleware', 'auth', 'authentication', 'token', 'guard', 'http', 'security', 'user'],
    noneOf: ['task-management', 'event-bus'],
  }),
  exactPure('src/middleware/auth.middleware.ts', 'requireAuth', false),

  // ----------------------------------------------------------
  // src/controllers/base.controller.ts
  // ----------------------------------------------------------
  assertedPurpose('src/controllers/base.controller.ts', 'BaseController', {
    anyOf: ['base', 'controller', 'abstract', 'shared', 'helper', 'response'],
  }),
  assertedDomain('src/controllers/base.controller.ts', 'BaseController', {
    anyOf: ['controller', 'http', 'base', 'helper', 'response'],
    noneOf: ['task', 'auth-only', 'event'],
  }),
  exactPure('src/controllers/base.controller.ts', 'BaseController', false),

  // ----------------------------------------------------------
  // src/controllers/auth.controller.ts
  // ----------------------------------------------------------
  assertedPurpose('src/controllers/auth.controller.ts', 'AuthController', {
    anyOf: ['controller', 'auth', 'register', 'login', 'endpoint', 'http'],
  }),
  assertedDomain('src/controllers/auth.controller.ts', 'AuthController', {
    anyOf: ['auth', 'authentication', 'controller', 'http', 'identity'],
    noneOf: ['task', 'event'],
  }),
  exactPure('src/controllers/auth.controller.ts', 'AuthController', false),

  assertedPurpose('src/controllers/auth.controller.ts', 'authController', {
    anyOf: ['singleton', 'instance', 'shared', 'auth', 'controller', 'route', 'dependency'],
  }),
  assertedDomain('src/controllers/auth.controller.ts', 'authController', {
    anyOf: ['auth', 'controller', 'singleton', 'http', 'user', 'security', 'dependency', 'injection'],
    noneOf: ['task-management', 'event-bus'],
  }),
  exactPure('src/controllers/auth.controller.ts', 'authController', false),

  // ----------------------------------------------------------
  // src/controllers/tasks.controller.ts
  // ----------------------------------------------------------
  assertedPurpose('src/controllers/tasks.controller.ts', 'TasksController', {
    mentions: ['task'],
    anyOf: ['controller', 'crud', 'endpoint', 'http', 'middleware', 'auth'],
  }),
  assertedDomain('src/controllers/tasks.controller.ts', 'TasksController', {
    anyOf: ['task', 'controller', 'http', 'crud'],
    noneOf: ['authentication-only', 'event-bus'],
  }),
  exactPure('src/controllers/tasks.controller.ts', 'TasksController', false),

  assertedPurpose('src/controllers/tasks.controller.ts', 'tasksController', {
    anyOf: ['singleton', 'instance', 'shared', 'task', 'controller', 'route'],
  }),
  assertedDomain('src/controllers/tasks.controller.ts', 'tasksController', {
    anyOf: ['task', 'controller', 'singleton', 'http'],
    noneOf: ['authentication-only', 'event-bus'],
  }),
  exactPure('src/controllers/tasks.controller.ts', 'tasksController', false),

  // ----------------------------------------------------------
  // src/index.ts — application bootstrap
  // ----------------------------------------------------------
  assertedPurpose('src/index.ts', 'app', {
    anyOf: ['app', 'application', 'http', 'mount', 'server', 'route', 'bootstrap'],
  }),
  assertedDomain('src/index.ts', 'app', {
    anyOf: ['app', 'application', 'bootstrap', 'http', 'server'],
    noneOf: ['task', 'event'],
  }),
  exactPure('src/index.ts', 'app', false),

  assertedPurpose('src/index.ts', 'PORT', {
    anyOf: ['port', 'tcp', 'listen', 'http'],
  }),
  // PORT is a primitive const — no domain, no pure (no behavior)

  // ----------------------------------------------------------
  // client/tasks.client.ts — frontend HTTP API client
  // ----------------------------------------------------------
  assertedPurpose('client/tasks.client.ts', 'BASE_URL', {
    anyOf: ['url', 'base', 'backend', 'api', 'endpoint'],
  }),
  // BASE_URL is a primitive const — no domain, no pure

  assertedPurpose('client/tasks.client.ts', 'HttpFn', {
    anyOf: ['http', 'function', 'fetch', 'type', 'alias', 'request'],
  }),

  assertedPurpose('client/tasks.client.ts', 'http', {
    anyOf: ['http', 'fetch', 'global', 'function', 'reference'],
  }),
  assertedDomain('client/tasks.client.ts', 'http', {
    anyOf: ['http', 'network', 'fetch', 'client', 'frontend'],
    noneOf: ['task-management', 'event'],
  }),
  exactPure('client/tasks.client.ts', 'http', false),

  assertedPurpose('client/tasks.client.ts', 'request', {
    anyOf: ['request', 'http', 'json', 'helper', 'authenticated'],
  }),
  assertedDomain('client/tasks.client.ts', 'request', {
    anyOf: ['http', 'client', 'request', 'frontend'],
    noneOf: ['task-management', 'event'],
  }),
  exactPure('client/tasks.client.ts', 'request', false),

  assertedPurpose('client/tasks.client.ts', 'login', {
    anyOf: ['login', 'auth', 'token', 'email', 'password', 'backend'],
  }),
  assertedDomain('client/tasks.client.ts', 'login', {
    anyOf: ['client', 'auth', 'login', 'http', 'frontend'],
    noneOf: ['task-management', 'event'],
  }),
  exactPure('client/tasks.client.ts', 'login', false),

  assertedPurpose('client/tasks.client.ts', 'register', {
    anyOf: ['register', 'create', 'user', 'account', 'backend', 'token'],
  }),
  assertedDomain('client/tasks.client.ts', 'register', {
    anyOf: ['client', 'auth', 'register', 'http', 'frontend'],
    noneOf: ['task-management', 'event'],
  }),
  exactPure('client/tasks.client.ts', 'register', false),

  assertedPurpose('client/tasks.client.ts', 'listTasks', {
    mentions: ['task'],
    anyOf: ['list', 'fetch', 'backend', 'client'],
  }),
  assertedDomain('client/tasks.client.ts', 'listTasks', {
    anyOf: ['task', 'client', 'http', 'frontend'],
    noneOf: ['authentication-only', 'event-bus'],
  }),
  exactPure('client/tasks.client.ts', 'listTasks', false),

  assertedPurpose('client/tasks.client.ts', 'getTask', {
    mentions: ['task'],
    anyOf: ['get', 'fetch', 'id', 'backend', 'client'],
  }),
  assertedDomain('client/tasks.client.ts', 'getTask', {
    anyOf: ['task', 'client', 'http', 'frontend'],
    noneOf: ['authentication-only', 'event-bus'],
  }),
  exactPure('client/tasks.client.ts', 'getTask', false),

  assertedPurpose('client/tasks.client.ts', 'createTask', {
    mentions: ['task'],
    anyOf: ['create', 'post', 'new', 'backend', 'client'],
  }),
  assertedDomain('client/tasks.client.ts', 'createTask', {
    anyOf: ['task', 'client', 'http', 'frontend'],
    noneOf: ['authentication-only', 'event-bus'],
  }),
  exactPure('client/tasks.client.ts', 'createTask', false),

  assertedPurpose('client/tasks.client.ts', 'updateTask', {
    mentions: ['task'],
    anyOf: ['update', 'modify', 'edit', 'backend', 'client', 'title'],
  }),
  assertedDomain('client/tasks.client.ts', 'updateTask', {
    anyOf: ['task', 'client', 'http', 'frontend'],
    noneOf: ['authentication-only', 'event-bus'],
  }),
  exactPure('client/tasks.client.ts', 'updateTask', false),

  assertedPurpose('client/tasks.client.ts', 'completeTask', {
    mentions: ['task'],
    anyOf: ['complete', 'mark', 'finish', 'done', 'backend', 'client'],
  }),
  assertedDomain('client/tasks.client.ts', 'completeTask', {
    anyOf: ['task', 'client', 'http', 'frontend'],
    noneOf: ['authentication-only', 'event-bus'],
  }),
  exactPure('client/tasks.client.ts', 'completeTask', false),

  assertedPurpose('client/tasks.client.ts', 'deleteTask', {
    mentions: ['task'],
    anyOf: ['delete', 'remove', 'destroy', 'backend', 'client', 'id'],
  }),
  assertedDomain('client/tasks.client.ts', 'deleteTask', {
    anyOf: ['task', 'client', 'http', 'frontend'],
    noneOf: ['authentication-only', 'event-bus'],
  }),
  exactPure('client/tasks.client.ts', 'deleteTask', false),
];
