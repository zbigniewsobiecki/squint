// Public API barrel. Exercises squint's re-export resolver
// (src/sync/reference-resolver.ts), which is currently dirty in git status —
// strong hint that bugs may live there.

export { TasksService, tasksService } from './src/services/tasks.service.js';
export { AuthService, authService } from './src/services/auth.service.js';
export { TasksRepository, tasksRepository } from './src/repositories/tasks.repository.js';
export { eventBus, auditLogger } from './src/events/event-bus.js';
export type { Task, User, NewTaskInput } from './src/types.js';
