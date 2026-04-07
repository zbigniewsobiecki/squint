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

export function createRouter(): Router {
  const noop = () => undefined;
  return { get: noop, post: noop, put: noop, patch: noop, delete: noop };
}

export function createApp(): App {
  return { use: () => undefined, listen: () => undefined };
}
