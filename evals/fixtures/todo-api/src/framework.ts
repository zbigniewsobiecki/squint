// Minimal in-fixture HTTP framework so the todo-api compiles without
// real Express. squint sees these calls as `router.METHOD(path, handler)`
// patterns just like the real thing.

export interface Request {
  body: Record<string, unknown>;
  params: Record<string, string>;
  headers: Record<string, string>;
  user?: { id: string; email: string };
}

export interface Response {
  status(code: number): Response;
  json(data: unknown): Response;
}

export type NextFunction = () => void;
export type Handler = (req: Request, res: Response, next?: NextFunction) => unknown;

export interface Router {
  get(path: string, ...handlers: Handler[]): void;
  post(path: string, ...handlers: Handler[]): void;
  put(path: string, ...handlers: Handler[]): void;
  patch(path: string, ...handlers: Handler[]): void;
  delete(path: string, ...handlers: Handler[]): void;
}

export interface App {
  use(pathOrRouter: string | Router, router?: Router): void;
  listen(port: number, cb?: () => void): void;
}

/**
 * Module-level registry of every router instance constructed at runtime.
 * Used by the framework to track mounted routes for diagnostics.
 *
 * Mutated by createRouter() — this is what makes the function unambiguously
 * impure (it has a side effect on module state, not just returning a value).
 */
const routerRegistry: Router[] = [];

/**
 * Module-level registry of every app instance constructed at runtime.
 * Mutated by createApp(). Same purpose as routerRegistry above — keeps
 * createApp's classification as impure unambiguous.
 */
const appRegistry: App[] = [];

export function createRouter(): Router {
  const handlers: Map<string, Handler[]> = new Map();
  const register =
    (method: string) =>
    (path: string, ...hs: Handler[]) => {
      handlers.set(`${method} ${path}`, hs);
    };
  const router: Router = {
    get: register('GET'),
    post: register('POST'),
    put: register('PUT'),
    patch: register('PATCH'),
    delete: register('DELETE'),
  };
  // Side effect: append to module-level registry. Makes this function impure.
  routerRegistry.push(router);
  return router;
}

export function createApp(): App {
  const mounted: Array<{ path: string; router: Router }> = [];
  let started = false;
  const app: App = {
    use(pathOrRouter, router) {
      if (typeof pathOrRouter === 'string' && router) {
        mounted.push({ path: pathOrRouter, router });
      }
    },
    listen(_port, cb) {
      // Side effect: mutate the captured `started` flag.
      started = true;
      if (cb) cb();
    },
  };
  // Side effect: append to module-level registry. Makes this function impure.
  appRegistry.push(app);
  // Reference `started` so the closure capture is observable to the LLM.
  void started;
  return app;
}
