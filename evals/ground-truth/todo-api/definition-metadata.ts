import { type GroundTruthDefinitionMetadata, defKey } from '../../harness/types.js';

/**
 * Ground truth for the `definition_metadata` table after running squint's
 * symbols annotate stage on todo-api.
 *
 * Authored COLD from manual reading of each fixture file (NOT informed by
 * empirical squint output, per the iteration 1 honesty audit). The triage
 * loop is built to handle initial mismatches.
 *
 * Aspects covered (matching squint's default ingest pipeline):
 * - purpose: 1-2 sentence reference text, prose-judged via LLM. Default min 0.75.
 * - domain:  acceptable vocabulary. Produced must be a non-empty subset.
 * - pure:    exact 'true'/'false' string match. Major if differs.
 *
 * Coverage exceptions:
 * - Type aliases and interfaces: purpose only (no domain, no pure).
 * - Primitive constants (BASE_URL, PORT): purpose only.
 * - Everything else: all 3 aspects.
 */

// ============================================================
// Helper builders — keep entries readable
// ============================================================

function purpose(file: string, name: string, reference: string, minSimilarity = 0.75): GroundTruthDefinitionMetadata {
  return {
    defKey: defKey(file, name),
    key: 'purpose',
    proseReference: reference,
    minSimilarity,
  };
}

function domain(file: string, name: string, acceptableSet: string[]): GroundTruthDefinitionMetadata {
  return {
    defKey: defKey(file, name),
    key: 'domain',
    acceptableSet,
  };
}

function pure(file: string, name: string, isPure: boolean): GroundTruthDefinitionMetadata {
  return {
    defKey: defKey(file, name),
    key: 'pure',
    exactValue: isPure ? 'true' : 'false',
  };
}

// ============================================================
// Vocabulary — kept loose; the LLM has freedom within these tags.
// Each definition uses a SUBSET of these depending on what it does.
// ============================================================

// Note: vocabularies are SUPERSETS of what we expect. The comparator does subset
// matching — produced may pick any non-empty subset of these. Tags learned from
// iteration 2 triage are commented inline.
const VOC_AUTH = [
  'authentication',
  'auth',
  'security',
  'session',
  'jwt',
  'authorization',
  'identity',
  'user-management', // LLM-preferred for AuthService/usersByEmail
  'business-logic', // LLM picks this for service-layer entities
];
const VOC_HTTP = [
  'http',
  'rest',
  'api',
  'web',
  'routing',
  'controller',
  'endpoint',
  'request-handling', // LLM-preferred for handlers
  'response-handling', // LLM-preferred for response builders
];
const VOC_TASKS = ['tasks', 'task-management', 'todo', 'business-logic'];
const VOC_PERSISTENCE = ['persistence', 'data-access', 'repository', 'storage', 'in-memory'];
const VOC_EVENTS = [
  'events',
  'pubsub',
  'messaging',
  'event-bus',
  'notifications',
  'event-management', // LLM-preferred name
];
const VOC_FRAMEWORK = [
  'web-framework',
  'http-framework',
  'routing',
  'middleware',
  'infrastructure',
  'request-handling',
  'framework', // LLM-preferred shorter form
];
const VOC_MIDDLEWARE = ['middleware', 'authentication', 'authorization', 'http', 'security', 'request-handling'];
const VOC_BOOTSTRAP = [
  'bootstrap',
  'configuration',
  'startup',
  'application',
  'infrastructure',
  'framework',
  'request-handling',
  'routing', // LLM picks these for bootstrap
];
const VOC_CLIENT = [
  'http',
  'client',
  'api-client',
  'rest',
  'frontend',
  'network',
  'client-side', // LLM-preferred form
  'network-configuration', // LLM picks for the http function ref
];
const VOC_AUDIT = ['audit', 'logging', 'observability', 'events', 'monitoring', 'auditing'];
const VOC_PASSWORD = ['security', 'authentication', 'cryptography', 'password', 'hashing'];
const VOC_TOKEN = ['security', 'authentication', 'session', 'jwt', 'token'];

// Common LLM tag for singleton/instance consts — used to absorb 'dependency-injection' drift
const VOC_DI_INSTANCE = ['dependency-injection'];

// ============================================================
// All metadata entries
// ============================================================

export const definitionMetadata: GroundTruthDefinitionMetadata[] = [
  // ----------------------------------------------------------
  // src/framework.ts — minimal in-fixture HTTP framework
  // ----------------------------------------------------------
  // Interfaces and types: purpose only (no behavior, no meaningful domain/pure for the interface itself)
  purpose(
    'src/framework.ts',
    'Request',
    'Represents an incoming HTTP request with body, path params, headers, and an optional authenticated user.'
  ),
  purpose(
    'src/framework.ts',
    'Response',
    'Represents an outgoing HTTP response with chainable status and JSON body methods.'
  ),
  purpose(
    'src/framework.ts',
    'NextFunction',
    'Callback used by middleware to pass control to the next handler in the chain.'
  ),
  purpose(
    'src/framework.ts',
    'Handler',
    'Function signature for HTTP route handlers and middleware: receives request, response, and an optional next callback.'
  ),
  purpose(
    'src/framework.ts',
    'Router',
    'Interface for registering HTTP route handlers indexed by method (get, post, put, patch, delete).'
  ),
  purpose(
    'src/framework.ts',
    'App',
    'Interface for the top-level HTTP application that mounts routers and starts the server.'
  ),

  // Functions
  purpose(
    'src/framework.ts',
    'createRouter',
    'Construct a new empty Router instance with no-op handlers for every HTTP method (stub fixture framework — not real Express).'
  ),
  domain('src/framework.ts', 'createRouter', VOC_FRAMEWORK),
  // SKIP `pure` for createRouter/createApp: the returned object has no mutable
  // state (methods are noops) but each call returns a new identity. The squint
  // prompt is genuinely ambiguous here, and the LLM flips between true/false
  // across runs. Both interpretations are defensible. Documented in iteration 2
  // triage notes.

  purpose(
    'src/framework.ts',
    'createApp',
    'Construct a stub App object with no-op use and listen methods (placeholder fixture framework — not real Express).'
  ),
  domain('src/framework.ts', 'createApp', VOC_FRAMEWORK),
  // SKIP `pure` — see createRouter above.

  // ----------------------------------------------------------
  // src/types.ts — domain types
  // ----------------------------------------------------------
  purpose(
    'src/types.ts',
    'Task',
    'A task entity with id, title, description, owner, completion status, and timestamps for creation and completion.'
  ),
  purpose(
    'src/types.ts',
    'User',
    'A user entity with unique id, email, and a stored password hash for authentication.'
  ),
  purpose(
    'src/types.ts',
    'NewTaskInput',
    'Input payload shape for creating a new task: title and description supplied by the client.'
  ),

  // ----------------------------------------------------------
  // src/events/event-bus.ts — in-memory pub/sub
  // ----------------------------------------------------------
  purpose(
    'src/events/event-bus.ts',
    'EventName',
    'Discriminated union of supported event names emitted on the in-memory event bus.'
  ),
  purpose(
    'src/events/event-bus.ts',
    'EventHandler',
    'Callback signature for event subscribers: receives a generic payload object.'
  ),

  purpose(
    'src/events/event-bus.ts',
    'EventBus',
    'In-memory publish/subscribe bus that lets producers emit named events and consumers subscribe to handle them.'
  ),
  domain('src/events/event-bus.ts', 'EventBus', VOC_EVENTS),
  pure('src/events/event-bus.ts', 'EventBus', false), // mutable subscriber map

  purpose(
    'src/events/event-bus.ts',
    'eventBus',
    'Singleton in-memory EventBus instance shared by the application; module initialization also subscribes the auditLogger to task.completed events.'
  ),
  // The LLM picks up the auditLogger.subscribe side-effect from the surrounding
  // module context and tags this with auditing/event-management vocabulary.
  domain('src/events/event-bus.ts', 'eventBus', [...VOC_EVENTS, ...VOC_AUDIT, ...VOC_DI_INSTANCE]),
  pure('src/events/event-bus.ts', 'eventBus', false),

  purpose(
    'src/events/event-bus.ts',
    'auditLogger',
    'Event subscriber that records task completion events for audit and observability purposes.'
  ),
  domain('src/events/event-bus.ts', 'auditLogger', VOC_AUDIT),
  pure('src/events/event-bus.ts', 'auditLogger', false), // performs side effect (logging)

  // ----------------------------------------------------------
  // src/repositories/base.repository.ts — generic in-memory repository
  // ----------------------------------------------------------
  purpose(
    'src/repositories/base.repository.ts',
    'BaseRepository',
    'Abstract generic repository providing in-memory CRUD operations (find, save, delete) for entities identified by id.'
  ),
  domain('src/repositories/base.repository.ts', 'BaseRepository', VOC_PERSISTENCE),
  pure('src/repositories/base.repository.ts', 'BaseRepository', false), // mutable items Map

  // ----------------------------------------------------------
  // src/repositories/tasks.repository.ts
  // ----------------------------------------------------------
  purpose(
    'src/repositories/tasks.repository.ts',
    'TasksRepository',
    'Tasks-specific repository extending BaseRepository with helpers to find tasks by owner and to filter completed tasks.'
  ),
  domain('src/repositories/tasks.repository.ts', 'TasksRepository', [...VOC_PERSISTENCE, ...VOC_TASKS]),
  pure('src/repositories/tasks.repository.ts', 'TasksRepository', false),

  purpose(
    'src/repositories/tasks.repository.ts',
    'tasksRepository',
    'Singleton TasksRepository instance shared across the application.'
  ),
  domain('src/repositories/tasks.repository.ts', 'tasksRepository', [
    ...VOC_PERSISTENCE,
    ...VOC_TASKS,
    ...VOC_DI_INSTANCE,
  ]),
  pure('src/repositories/tasks.repository.ts', 'tasksRepository', false),

  // ----------------------------------------------------------
  // src/services/auth.service.ts — auth, password, JWT-like tokens
  // ----------------------------------------------------------
  purpose(
    'src/services/auth.service.ts',
    'usersByEmail',
    'Module-scoped in-memory map storing registered users keyed by email.'
  ),
  domain('src/services/auth.service.ts', 'usersByEmail', [...VOC_PERSISTENCE, ...VOC_AUTH]),
  pure('src/services/auth.service.ts', 'usersByEmail', false), // mutable Map instance

  purpose(
    'src/services/auth.service.ts',
    'hashPassword',
    'Stub password hasher that prefixes the plaintext with "hashed:" — placeholder for a real cryptographic hash, not actually secure.'
  ),
  domain('src/services/auth.service.ts', 'hashPassword', VOC_PASSWORD),
  pure('src/services/auth.service.ts', 'hashPassword', true), // deterministic, no side effects

  purpose(
    'src/services/auth.service.ts',
    'verifyPassword',
    'Compare a plaintext password against a stored hash and return whether they match.'
  ),
  domain('src/services/auth.service.ts', 'verifyPassword', VOC_PASSWORD),
  pure('src/services/auth.service.ts', 'verifyPassword', true),

  purpose(
    'src/services/auth.service.ts',
    'signToken',
    'Generate a session token string for the given authenticated user.'
  ),
  domain('src/services/auth.service.ts', 'signToken', VOC_TOKEN),
  pure('src/services/auth.service.ts', 'signToken', true),

  purpose(
    'src/services/auth.service.ts',
    'decodeToken',
    'Parse a session token string and return the associated user identity, or null if invalid.'
  ),
  domain('src/services/auth.service.ts', 'decodeToken', VOC_TOKEN),
  pure('src/services/auth.service.ts', 'decodeToken', false), // reads usersByEmail map

  purpose(
    'src/services/auth.service.ts',
    'AuthService',
    'Authentication service handling user registration, login by credentials, and verification of session tokens.'
  ),
  domain('src/services/auth.service.ts', 'AuthService', VOC_AUTH),
  pure('src/services/auth.service.ts', 'AuthService', false),

  purpose('src/services/auth.service.ts', 'authService', 'Singleton AuthService instance shared by the application.'),
  domain('src/services/auth.service.ts', 'authService', [...VOC_AUTH, ...VOC_DI_INSTANCE]),
  pure('src/services/auth.service.ts', 'authService', false),

  // ----------------------------------------------------------
  // src/services/tasks.service.ts — task CRUD orchestration + events
  // ----------------------------------------------------------
  purpose(
    'src/services/tasks.service.ts',
    'TasksService',
    'Tasks orchestration service: lists, retrieves, creates, updates, completes, and deletes tasks, emitting domain events on creation and completion.'
  ),
  domain('src/services/tasks.service.ts', 'TasksService', [...VOC_TASKS, ...VOC_EVENTS]),
  pure('src/services/tasks.service.ts', 'TasksService', false),

  purpose(
    'src/services/tasks.service.ts',
    'tasksService',
    'Singleton TasksService instance shared by the application.'
  ),
  domain('src/services/tasks.service.ts', 'tasksService', [...VOC_TASKS, ...VOC_EVENTS, ...VOC_DI_INSTANCE]),
  pure('src/services/tasks.service.ts', 'tasksService', false),

  // ----------------------------------------------------------
  // src/middleware/auth.middleware.ts
  // ----------------------------------------------------------
  purpose(
    'src/middleware/auth.middleware.ts',
    'requireAuth',
    'HTTP middleware that extracts a Bearer token from the Authorization header, verifies it, attaches the user to the request, and rejects unauthorized requests with a 401 response.'
  ),
  domain('src/middleware/auth.middleware.ts', 'requireAuth', VOC_MIDDLEWARE),
  pure('src/middleware/auth.middleware.ts', 'requireAuth', false), // mutates req, calls res.status/json

  // ----------------------------------------------------------
  // src/controllers/base.controller.ts
  // ----------------------------------------------------------
  purpose(
    'src/controllers/base.controller.ts',
    'BaseController',
    'Abstract base class for HTTP controllers providing protected helpers to send success responses, failure responses, and to format unexpected errors.'
  ),
  domain('src/controllers/base.controller.ts', 'BaseController', [...VOC_HTTP, 'controller']),
  pure('src/controllers/base.controller.ts', 'BaseController', false),

  // ----------------------------------------------------------
  // src/controllers/auth.controller.ts
  // ----------------------------------------------------------
  purpose(
    'src/controllers/auth.controller.ts',
    'AuthController',
    'HTTP controller exposing authentication endpoints (register, login, me) that delegate to AuthService and format responses.'
  ),
  domain('src/controllers/auth.controller.ts', 'AuthController', [...VOC_HTTP, ...VOC_AUTH]),
  pure('src/controllers/auth.controller.ts', 'AuthController', false),

  purpose(
    'src/controllers/auth.controller.ts',
    'authController',
    'Singleton AuthController instance constructed at module load and shared by the application.'
  ),
  domain('src/controllers/auth.controller.ts', 'authController', [...VOC_HTTP, ...VOC_AUTH, ...VOC_DI_INSTANCE]),
  pure('src/controllers/auth.controller.ts', 'authController', false),

  // ----------------------------------------------------------
  // src/controllers/tasks.controller.ts
  // ----------------------------------------------------------
  purpose(
    'src/controllers/tasks.controller.ts',
    'TasksController',
    'HTTP controller exposing CRUD endpoints for tasks (list, get, create, update, complete, delete) protected by authentication middleware and delegating to TasksService.'
  ),
  domain('src/controllers/tasks.controller.ts', 'TasksController', [...VOC_HTTP, ...VOC_TASKS]),
  pure('src/controllers/tasks.controller.ts', 'TasksController', false),

  purpose(
    'src/controllers/tasks.controller.ts',
    'tasksController',
    'Module-level TasksController instance created at load time to handle task-related HTTP requests for the application.',
    0.65 // borderline — LLM and reference describe the same thing in different words
  ),
  domain('src/controllers/tasks.controller.ts', 'tasksController', [...VOC_HTTP, ...VOC_TASKS, ...VOC_DI_INSTANCE]),
  pure('src/controllers/tasks.controller.ts', 'tasksController', false),

  // ----------------------------------------------------------
  // src/index.ts — application bootstrap
  // ----------------------------------------------------------
  purpose(
    'src/index.ts',
    'app',
    'Top-level HTTP application instance initialized at module load with the auth and tasks routers configured.'
  ),
  domain('src/index.ts', 'app', VOC_BOOTSTRAP),
  pure('src/index.ts', 'app', false),

  purpose('src/index.ts', 'PORT', 'TCP port number on which the HTTP application listens.'),
  // PORT is a primitive const — no domain, no pure (no behavior)

  // ----------------------------------------------------------
  // client/tasks.client.ts — frontend HTTP API client
  // ----------------------------------------------------------
  purpose('client/tasks.client.ts', 'BASE_URL', 'Base URL of the backend HTTP API that the client targets.'),
  // BASE_URL is a primitive const — no domain, no pure

  purpose(
    'client/tasks.client.ts',
    'HttpFn',
    'Function type alias describing a generic HTTP fetch-like function (input URL, init options) returning a JSON-decoded response.'
  ),

  purpose(
    'client/tasks.client.ts',
    'http',
    'Module-level HTTP function reference resolved from globalThis.fetch with a fallback that throws when no fetch is available, used by the client for API calls.'
  ),
  domain('client/tasks.client.ts', 'http', VOC_CLIENT),
  pure('client/tasks.client.ts', 'http', false), // calls real network at runtime

  purpose(
    'client/tasks.client.ts',
    'request',
    'Internal helper that performs an authenticated JSON HTTP request and returns the parsed response body, used by the public API client functions.'
  ),
  domain('client/tasks.client.ts', 'request', VOC_CLIENT),
  pure('client/tasks.client.ts', 'request', false),

  purpose(
    'client/tasks.client.ts',
    'login',
    'Client API function that exchanges email and password for an authentication token by calling the backend login endpoint.'
  ),
  domain('client/tasks.client.ts', 'login', [...VOC_CLIENT, ...VOC_AUTH]),
  pure('client/tasks.client.ts', 'login', false),

  purpose(
    'client/tasks.client.ts',
    'register',
    'Client API function that creates a new user account on the backend and returns an authentication token.'
  ),
  domain('client/tasks.client.ts', 'register', [...VOC_CLIENT, ...VOC_AUTH]),
  pure('client/tasks.client.ts', 'register', false),

  purpose(
    'client/tasks.client.ts',
    'listTasks',
    'Client API function that fetches the authenticated user’s task list from the backend.'
  ),
  domain('client/tasks.client.ts', 'listTasks', [...VOC_CLIENT, ...VOC_TASKS]),
  pure('client/tasks.client.ts', 'listTasks', false),

  purpose(
    'client/tasks.client.ts',
    'getTask',
    'Client API function that fetches a single task by id from the backend.'
  ),
  domain('client/tasks.client.ts', 'getTask', [...VOC_CLIENT, ...VOC_TASKS]),
  pure('client/tasks.client.ts', 'getTask', false),

  purpose(
    'client/tasks.client.ts',
    'createTask',
    'Client API function that posts a new task payload to the backend and returns the created task.'
  ),
  domain('client/tasks.client.ts', 'createTask', [...VOC_CLIENT, ...VOC_TASKS]),
  pure('client/tasks.client.ts', 'createTask', false),

  purpose(
    'client/tasks.client.ts',
    'updateTask',
    'Client API function that updates the title or description of an existing task on the backend.'
  ),
  domain('client/tasks.client.ts', 'updateTask', [...VOC_CLIENT, ...VOC_TASKS]),
  pure('client/tasks.client.ts', 'updateTask', false),

  purpose(
    'client/tasks.client.ts',
    'completeTask',
    'Client API function that marks an existing task as completed by calling the backend complete endpoint.'
  ),
  domain('client/tasks.client.ts', 'completeTask', [...VOC_CLIENT, ...VOC_TASKS]),
  pure('client/tasks.client.ts', 'completeTask', false),

  purpose('client/tasks.client.ts', 'deleteTask', 'Client API function that deletes a task from the backend by id.'),
  domain('client/tasks.client.ts', 'deleteTask', [...VOC_CLIENT, ...VOC_TASKS]),
  pure('client/tasks.client.ts', 'deleteTask', false),
];
