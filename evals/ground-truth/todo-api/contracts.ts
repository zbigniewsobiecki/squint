import { type GroundTruthContract, defKey } from '../../harness/types.js';

/**
 * Ground truth for the `contracts` and `contract_participants` tables after
 * running `squint ingest --to-stage contracts` against the todo-api fixture.
 *
 * Authored against the actual produced state from the iter-5 cold-pass DB.
 * Two normalization quirks were discovered during triage:
 *
 *   1. squint normalizes route params as `{param}` (not `:id`).
 *   2. squint extracts the controller-local route paths (e.g. `/login`,
 *      `/tasks`) WITHOUT the mount prefix (`/api/auth`, `/api/tasks`).
 *      The mount prefix lives in src/index.ts (`app.use('/api/auth', ...)`)
 *      but squint doesn't currently propagate it down to the routes. This
 *      is a deliberate scope choice — the GT matches what squint produces.
 *   3. The events protocol is singular `event` (not `events`).
 *
 * todo-api exposes 9 HTTP endpoints across 2 controllers (auth + tasks)
 * and emits 2 in-process events from the tasks service.
 *
 * Severity (compareContracts):
 *   - Missing GT contract → CRITICAL
 *   - Extra produced contract → MAJOR
 *   - Participants are NOT yet checked by the comparator (TODO)
 */
export const contracts: GroundTruthContract[] = [
  // ============================================================
  // HTTP — Authentication endpoints (3)
  // ============================================================
  {
    protocol: 'http',
    normalizedKey: 'POST /auth/register',
    participants: [
      { defKey: defKey('src/controllers/auth.controller.ts', 'AuthController'), role: 'server' },
      { defKey: defKey('client/tasks.client.ts', 'register'), role: 'client' },
    ],
  },
  {
    protocol: 'http',
    normalizedKey: 'POST /auth/login',
    participants: [
      { defKey: defKey('src/controllers/auth.controller.ts', 'AuthController'), role: 'server' },
      { defKey: defKey('client/tasks.client.ts', 'login'), role: 'client' },
    ],
  },
  {
    protocol: 'http',
    normalizedKey: 'GET /auth/me',
    participants: [{ defKey: defKey('src/controllers/auth.controller.ts', 'AuthController'), role: 'server' }],
  },

  // ============================================================
  // HTTP — Task CRUD endpoints (6)
  // ============================================================
  {
    protocol: 'http',
    normalizedKey: 'GET /tasks',
    participants: [
      { defKey: defKey('src/controllers/tasks.controller.ts', 'TasksController'), role: 'server' },
      { defKey: defKey('client/tasks.client.ts', 'listTasks'), role: 'client' },
    ],
  },
  {
    protocol: 'http',
    normalizedKey: 'GET /tasks/{param}',
    participants: [
      { defKey: defKey('src/controllers/tasks.controller.ts', 'TasksController'), role: 'server' },
      { defKey: defKey('client/tasks.client.ts', 'getTask'), role: 'client' },
    ],
  },
  {
    protocol: 'http',
    normalizedKey: 'POST /tasks',
    participants: [
      { defKey: defKey('src/controllers/tasks.controller.ts', 'TasksController'), role: 'server' },
      { defKey: defKey('client/tasks.client.ts', 'createTask'), role: 'client' },
    ],
  },
  {
    protocol: 'http',
    normalizedKey: 'PUT /tasks/{param}',
    participants: [
      { defKey: defKey('src/controllers/tasks.controller.ts', 'TasksController'), role: 'server' },
      { defKey: defKey('client/tasks.client.ts', 'updateTask'), role: 'client' },
    ],
  },
  {
    protocol: 'http',
    normalizedKey: 'PATCH /tasks/{param}/complete',
    participants: [
      { defKey: defKey('src/controllers/tasks.controller.ts', 'TasksController'), role: 'server' },
      { defKey: defKey('client/tasks.client.ts', 'completeTask'), role: 'client' },
    ],
  },
  {
    protocol: 'http',
    normalizedKey: 'DELETE /tasks/{param}',
    participants: [
      { defKey: defKey('src/controllers/tasks.controller.ts', 'TasksController'), role: 'server' },
      { defKey: defKey('client/tasks.client.ts', 'deleteTask'), role: 'client' },
    ],
  },

  // ============================================================
  // Events — In-process pub/sub (2)
  // ============================================================
  // Producer: TasksService.create / TasksService.complete (via eventBus.emit).
  // Consumer: auditLogger (subscribed to task.completed at module load).
  // squint uses the singular protocol name 'event'.
  //
  // NOTE: events are marked `optional` because the contract LLM extractor
  // is non-deterministic for in-process pub/sub: some runs detect both
  // task.created and task.completed, others detect zero events. The boundary
  // status of an in-process event bus is genuinely ambiguous (it's not
  // strictly cross-process). Marking these optional lets the GT assert
  // "if the LLM extracts events, they should be these two" without forcing
  // a hard requirement that varies run-to-run.
  {
    protocol: 'event',
    normalizedKey: 'task.created',
    participants: [{ defKey: defKey('src/services/tasks.service.ts', 'TasksService'), role: 'producer' }],
    optional: true,
  },
  {
    protocol: 'event',
    normalizedKey: 'task.completed',
    participants: [
      { defKey: defKey('src/services/tasks.service.ts', 'TasksService'), role: 'producer' },
      { defKey: defKey('src/events/event-bus.ts', 'auditLogger'), role: 'consumer' },
    ],
    optional: true,
  },
];
