import type { Response } from '../framework.js';

// BaseController is the inheritance root for all HTTP controllers.
// squint should detect AuthController and TasksController as `extends BaseController`.

export abstract class BaseController {
  protected success<T>(res: Response, data: T, statusCode = 200): void {
    res.status(statusCode).json({ ok: true, data });
  }

  protected fail(res: Response, message: string, statusCode = 400): void {
    res.status(statusCode).json({ ok: false, error: message });
  }

  protected handleError(res: Response, err: unknown): void {
    const message = err instanceof Error ? err.message : 'unknown error';
    this.fail(res, message, 500);
  }
}
