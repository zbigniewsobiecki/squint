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
 * - domain:  one-sentence semantic theme, judged via LLM (themeReference).
 *            Replaces the previous acceptableSet vocabulary lists — see
 *            Phase 1 redesign notes in the `feat/eval-harness` history.
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

/**
 * Tag-array semantic theme. Replaces the previous `domain(file, name, vocab)`
 * helper that consumed long acceptableSet vocabularies. Each call now passes
 * a one-sentence prose theme that the LLM judge scores against the produced
 * tag array (formatted as "tags: a, b, c"). The judge handles synonym drift
 * automatically — no more vocabulary whack-a-mole.
 *
 * Default minSimilarity is 0.6 (set inside the comparator), tuned for short
 * comma-separated tag candidates.
 */
function domainTheme(file: string, name: string, theme: string): GroundTruthDefinitionMetadata {
  return {
    defKey: defKey(file, name),
    key: 'domain',
    themeReference: theme,
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

  // Module-level registries (mutated by createRouter/createApp to make
  // those functions unambiguously impure)
  purpose(
    'src/framework.ts',
    'routerRegistry',
    'Module-level mutable array tracking every Router instance constructed by createRouter, used by the framework for diagnostics.'
  ),
  domainTheme(
    'src/framework.ts',
    'routerRegistry',
    'tags should reflect a module-level registry tracking router instances within an HTTP framework'
  ),
  pure('src/framework.ts', 'routerRegistry', false),

  purpose(
    'src/framework.ts',
    'appRegistry',
    'Module-level mutable array tracking every App instance constructed by createApp, used by the framework for diagnostics.'
  ),
  domainTheme(
    'src/framework.ts',
    'appRegistry',
    'tags should reflect a module-level registry tracking app instances within an HTTP framework'
  ),
  pure('src/framework.ts', 'appRegistry', false),

  // Functions
  purpose(
    'src/framework.ts',
    'createRouter',
    'Construct a new Router instance that registers HTTP route handlers per method and path.'
  ),
  domainTheme(
    'src/framework.ts',
    'createRouter',
    'tags should reflect a factory function that constructs HTTP routers within a web framework'
  ),
  // Now unambiguously impure: each call mutates the module-level routerRegistry.
  pure('src/framework.ts', 'createRouter', false),

  purpose(
    'src/framework.ts',
    'createApp',
    'Construct a new App instance for mounting routers and starting the HTTP server.'
  ),
  domainTheme(
    'src/framework.ts',
    'createApp',
    'tags should reflect a factory function that constructs an HTTP application within a web framework'
  ),
  // Now unambiguously impure: each call mutates the module-level appRegistry.
  pure('src/framework.ts', 'createApp', false),

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
  domainTheme(
    'src/events/event-bus.ts',
    'EventBus',
    'tags should reflect an in-memory publish/subscribe event bus carrying named application events'
  ),
  pure('src/events/event-bus.ts', 'EventBus', false), // mutable subscriber map

  purpose(
    'src/events/event-bus.ts',
    'eventBus',
    'Singleton in-memory EventBus instance shared by the application; module initialization also subscribes the auditLogger to task.completed events.'
  ),
  domainTheme(
    'src/events/event-bus.ts',
    'eventBus',
    'tags should reflect a singleton event bus instance shared by the application, also tied to audit subscriptions for task lifecycle events'
  ),
  pure('src/events/event-bus.ts', 'eventBus', false),

  purpose(
    'src/events/event-bus.ts',
    'auditLogger',
    'Event subscriber that records task completion events for audit and observability purposes.'
  ),
  domainTheme(
    'src/events/event-bus.ts',
    'auditLogger',
    'tags should reflect an event-subscriber audit logger recording task completion events'
  ),
  pure('src/events/event-bus.ts', 'auditLogger', false), // performs side effect (logging)

  // ----------------------------------------------------------
  // src/repositories/base.repository.ts — generic in-memory repository
  // ----------------------------------------------------------
  purpose(
    'src/repositories/base.repository.ts',
    'BaseRepository',
    'Abstract generic repository providing in-memory CRUD operations (find, save, delete) for entities identified by id.'
  ),
  domainTheme(
    'src/repositories/base.repository.ts',
    'BaseRepository',
    'tags should reflect an abstract in-memory repository providing generic CRUD persistence for entities'
  ),
  pure('src/repositories/base.repository.ts', 'BaseRepository', false), // mutable items Map

  // ----------------------------------------------------------
  // src/repositories/tasks.repository.ts
  // ----------------------------------------------------------
  purpose(
    'src/repositories/tasks.repository.ts',
    'TasksRepository',
    'Tasks-specific repository extending BaseRepository with helpers to find tasks by owner and to filter completed tasks.'
  ),
  domainTheme(
    'src/repositories/tasks.repository.ts',
    'TasksRepository',
    'tags should reflect a tasks-specific in-memory repository extending a generic base repository'
  ),
  pure('src/repositories/tasks.repository.ts', 'TasksRepository', false),

  purpose(
    'src/repositories/tasks.repository.ts',
    'tasksRepository',
    'Singleton TasksRepository instance shared across the application.'
  ),
  domainTheme(
    'src/repositories/tasks.repository.ts',
    'tasksRepository',
    'tags should reflect a singleton tasks repository instance shared across the application'
  ),
  pure('src/repositories/tasks.repository.ts', 'tasksRepository', false),

  // ----------------------------------------------------------
  // src/services/auth.service.ts — auth, password, JWT-like tokens
  // ----------------------------------------------------------
  purpose(
    'src/services/auth.service.ts',
    'usersByEmail',
    'Module-scoped Map of registered users keyed by email — the in-memory user store backing the auth service.',
    0.6 // tolerant: LLM tends to describe surrounding auth context, not just the storage
  ),
  domainTheme(
    'src/services/auth.service.ts',
    'usersByEmail',
    'tags should reflect an in-memory user store keyed by email backing the authentication service'
  ),
  pure('src/services/auth.service.ts', 'usersByEmail', false), // mutable Map instance

  purpose(
    'src/services/auth.service.ts',
    'hashPassword',
    'Stub password hasher that prefixes the plaintext with "hashed:" — placeholder for a real cryptographic hash, not actually secure.'
  ),
  domainTheme(
    'src/services/auth.service.ts',
    'hashPassword',
    'tags should reflect a password hashing function used during user registration'
  ),
  pure('src/services/auth.service.ts', 'hashPassword', true), // deterministic, no side effects

  purpose(
    'src/services/auth.service.ts',
    'verifyPassword',
    'Compare a plaintext password against a stored hash and return whether they match.'
  ),
  domainTheme(
    'src/services/auth.service.ts',
    'verifyPassword',
    'tags should reflect a password verification function comparing plaintext against a stored hash'
  ),
  pure('src/services/auth.service.ts', 'verifyPassword', true),

  purpose(
    'src/services/auth.service.ts',
    'signToken',
    'Generate a session token string for the given authenticated user.'
  ),
  domainTheme(
    'src/services/auth.service.ts',
    'signToken',
    'tags should reflect a function that signs an authentication token for a user'
  ),
  pure('src/services/auth.service.ts', 'signToken', true),

  purpose(
    'src/services/auth.service.ts',
    'decodeToken',
    'Parse a session token string and return the associated user identity, or null if invalid.'
  ),
  domainTheme(
    'src/services/auth.service.ts',
    'decodeToken',
    'tags should reflect a function that decodes an authentication token and returns the associated user'
  ),
  pure('src/services/auth.service.ts', 'decodeToken', false), // reads usersByEmail map

  purpose(
    'src/services/auth.service.ts',
    'AuthService',
    'Authentication service handling user registration, login by credentials, and verification of session tokens.'
  ),
  domainTheme(
    'src/services/auth.service.ts',
    'AuthService',
    'tags should reflect an authentication service handling user registration, login, and token verification'
  ),
  pure('src/services/auth.service.ts', 'AuthService', false),

  purpose('src/services/auth.service.ts', 'authService', 'Singleton AuthService instance shared by the application.'),
  domainTheme(
    'src/services/auth.service.ts',
    'authService',
    'tags should reflect a singleton authentication service instance shared by the application'
  ),
  pure('src/services/auth.service.ts', 'authService', false),

  // ----------------------------------------------------------
  // src/services/tasks.service.ts — task CRUD orchestration + events
  // ----------------------------------------------------------
  purpose(
    'src/services/tasks.service.ts',
    'TasksService',
    'Tasks orchestration service: lists, retrieves, creates, updates, completes, and deletes tasks, emitting domain events on creation and completion.'
  ),
  domainTheme(
    'src/services/tasks.service.ts',
    'TasksService',
    'tags should reflect a tasks orchestration service handling CRUD operations and emitting domain events'
  ),
  pure('src/services/tasks.service.ts', 'TasksService', false),

  purpose(
    'src/services/tasks.service.ts',
    'tasksService',
    'Singleton TasksService instance shared by the application.'
  ),
  domainTheme(
    'src/services/tasks.service.ts',
    'tasksService',
    'tags should reflect a singleton tasks service instance shared by the application'
  ),
  pure('src/services/tasks.service.ts', 'tasksService', false),

  // ----------------------------------------------------------
  // src/middleware/auth.middleware.ts
  // ----------------------------------------------------------
  purpose(
    'src/middleware/auth.middleware.ts',
    'requireAuth',
    'HTTP middleware that extracts a Bearer token from the Authorization header, verifies it, attaches the user to the request, and rejects unauthorized requests with a 401 response.'
  ),
  domainTheme(
    'src/middleware/auth.middleware.ts',
    'requireAuth',
    'tags should reflect HTTP middleware that authenticates a bearer token before a protected endpoint runs'
  ),
  pure('src/middleware/auth.middleware.ts', 'requireAuth', false), // mutates req, calls res.status/json

  // ----------------------------------------------------------
  // src/controllers/base.controller.ts
  // ----------------------------------------------------------
  purpose(
    'src/controllers/base.controller.ts',
    'BaseController',
    'Abstract base class for HTTP controllers providing protected helpers to send success responses, failure responses, and to format unexpected errors.'
  ),
  domainTheme(
    'src/controllers/base.controller.ts',
    'BaseController',
    'tags should reflect an abstract HTTP controller base class with shared response and error helpers'
  ),
  pure('src/controllers/base.controller.ts', 'BaseController', false),

  // ----------------------------------------------------------
  // src/controllers/auth.controller.ts
  // ----------------------------------------------------------
  purpose(
    'src/controllers/auth.controller.ts',
    'AuthController',
    'HTTP controller exposing authentication endpoints (register, login, me) that delegate to AuthService and format responses.'
  ),
  domainTheme(
    'src/controllers/auth.controller.ts',
    'AuthController',
    'tags should reflect an HTTP controller exposing authentication endpoints (register, login, identity)'
  ),
  pure('src/controllers/auth.controller.ts', 'AuthController', false),

  purpose(
    'src/controllers/auth.controller.ts',
    'authController',
    'Module-level AuthController instance whose handlers are wired into the auth HTTP routes.',
    0.6 // tolerant — LLM and reference describe the same instantiation in different words
  ),
  domainTheme(
    'src/controllers/auth.controller.ts',
    'authController',
    'tags should reflect a singleton auth controller instance mounted into the HTTP routes'
  ),
  pure('src/controllers/auth.controller.ts', 'authController', false),

  // ----------------------------------------------------------
  // src/controllers/tasks.controller.ts
  // ----------------------------------------------------------
  purpose(
    'src/controllers/tasks.controller.ts',
    'TasksController',
    'HTTP controller exposing CRUD endpoints for tasks (list, get, create, update, complete, delete) protected by authentication middleware and delegating to TasksService.'
  ),
  domainTheme(
    'src/controllers/tasks.controller.ts',
    'TasksController',
    'tags should reflect an HTTP controller exposing task CRUD endpoints gated by authentication middleware'
  ),
  pure('src/controllers/tasks.controller.ts', 'TasksController', false),

  purpose(
    'src/controllers/tasks.controller.ts',
    'tasksController',
    'Module-level TasksController instance created at load time to handle task-related HTTP requests for the application.',
    0.65 // borderline — LLM and reference describe the same thing in different words
  ),
  domainTheme(
    'src/controllers/tasks.controller.ts',
    'tasksController',
    'tags should reflect a singleton tasks controller instance mounted into the HTTP routes'
  ),
  pure('src/controllers/tasks.controller.ts', 'tasksController', false),

  // ----------------------------------------------------------
  // src/index.ts — application bootstrap
  // ----------------------------------------------------------
  purpose(
    'src/index.ts',
    'app',
    'HTTP application instance initialized at module load that mounts the auth and tasks routes and starts the server.',
    0.6 // tolerant — LLM describes the lifecycle, reference describes the role
  ),
  domainTheme(
    'src/index.ts',
    'app',
    'tags should reflect the bootstrap HTTP application instance that mounts routers and starts the server'
  ),
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
  domainTheme(
    'client/tasks.client.ts',
    'http',
    'tags should reflect a network HTTP function used by a frontend API client for backend requests'
  ),
  pure('client/tasks.client.ts', 'http', false), // calls real network at runtime

  purpose(
    'client/tasks.client.ts',
    'request',
    'Internal helper that performs an authenticated JSON HTTP request and returns the parsed response body, used by the public API client functions.'
  ),
  domainTheme(
    'client/tasks.client.ts',
    'request',
    'tags should reflect an internal HTTP request helper used by a frontend API client'
  ),
  pure('client/tasks.client.ts', 'request', false),

  purpose(
    'client/tasks.client.ts',
    'login',
    'Client API function that exchanges email and password for an authentication token by calling the backend login endpoint.'
  ),
  domainTheme(
    'client/tasks.client.ts',
    'login',
    'tags should reflect a frontend client function that authenticates a user against the backend login endpoint'
  ),
  pure('client/tasks.client.ts', 'login', false),

  purpose(
    'client/tasks.client.ts',
    'register',
    'Client API function that creates a new user account on the backend and returns an authentication token.'
  ),
  domainTheme(
    'client/tasks.client.ts',
    'register',
    'tags should reflect a frontend client function that registers a new user on the backend'
  ),
  pure('client/tasks.client.ts', 'register', false),

  purpose(
    'client/tasks.client.ts',
    'listTasks',
    'Client API function that fetches the authenticated user’s task list from the backend.'
  ),
  domainTheme(
    'client/tasks.client.ts',
    'listTasks',
    'tags should reflect a frontend client function that lists tasks from the backend'
  ),
  pure('client/tasks.client.ts', 'listTasks', false),

  purpose(
    'client/tasks.client.ts',
    'getTask',
    'Client API function that fetches a single task by id from the backend.'
  ),
  domainTheme(
    'client/tasks.client.ts',
    'getTask',
    'tags should reflect a frontend client function that fetches a task by id from the backend'
  ),
  pure('client/tasks.client.ts', 'getTask', false),

  purpose(
    'client/tasks.client.ts',
    'createTask',
    'Client API function that posts a new task payload to the backend and returns the created task.'
  ),
  domainTheme(
    'client/tasks.client.ts',
    'createTask',
    'tags should reflect a frontend client function that creates a new task on the backend'
  ),
  pure('client/tasks.client.ts', 'createTask', false),

  purpose(
    'client/tasks.client.ts',
    'updateTask',
    'Client API function that updates the title or description of an existing task on the backend.'
  ),
  domainTheme(
    'client/tasks.client.ts',
    'updateTask',
    'tags should reflect a frontend client function that updates an existing task on the backend'
  ),
  pure('client/tasks.client.ts', 'updateTask', false),

  purpose(
    'client/tasks.client.ts',
    'completeTask',
    'Client API function that marks an existing task as completed by calling the backend complete endpoint.'
  ),
  domainTheme(
    'client/tasks.client.ts',
    'completeTask',
    'tags should reflect a frontend client function that marks a task as completed on the backend'
  ),
  pure('client/tasks.client.ts', 'completeTask', false),

  purpose('client/tasks.client.ts', 'deleteTask', 'Client API function that deletes a task from the backend by id.'),
  domainTheme(
    'client/tasks.client.ts',
    'deleteTask',
    'tags should reflect a frontend client function that deletes a task from the backend'
  ),
  pure('client/tasks.client.ts', 'deleteTask', false),
];
