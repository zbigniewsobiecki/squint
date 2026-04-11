import type { GroundTruthFile } from '../../harness/types.js';

/**
 * Files squint should index when running on evals/fixtures/todo-api/.
 * Excludes package.json/tsconfig.json (not TS) and any .d.ts (none in fixture).
 */
export const files: GroundTruthFile[] = [
  { path: 'client/tasks.client.ts', language: 'typescript' },
  { path: 'index.ts', language: 'typescript' },
  { path: 'src/controllers/auth.controller.ts', language: 'typescript' },
  { path: 'src/controllers/base.controller.ts', language: 'typescript' },
  { path: 'src/controllers/tasks.controller.ts', language: 'typescript' },
  { path: 'src/events/event-bus.ts', language: 'typescript' },
  { path: 'src/framework.ts', language: 'typescript' },
  { path: 'src/index.ts', language: 'typescript' },
  { path: 'src/middleware/auth.middleware.ts', language: 'typescript' },
  { path: 'src/repositories/base.repository.ts', language: 'typescript' },
  { path: 'src/repositories/tasks.repository.ts', language: 'typescript' },
  { path: 'src/services/auth.service.ts', language: 'typescript' },
  { path: 'src/services/tasks.service.ts', language: 'typescript' },
  { path: 'src/types.ts', language: 'typescript' },
];
