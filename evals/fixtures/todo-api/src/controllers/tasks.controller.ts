import { type Request, type Response, type Router, createRouter } from '../framework.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { tasksService } from '../services/tasks.service.js';
import { BaseController } from './base.controller.js';

export class TasksController extends BaseController {
  router: Router;

  constructor() {
    super();
    this.router = createRouter();
    this.router.get('/', requireAuth, (req, res) => this.list(req, res));
    this.router.get('/:id', requireAuth, (req, res) => this.get(req, res));
    this.router.post('/', requireAuth, (req, res) => this.create(req, res));
    this.router.put('/:id', requireAuth, (req, res) => this.update(req, res));
    this.router.patch('/:id/complete', requireAuth, (req, res) => this.complete(req, res));
    this.router.delete('/:id', requireAuth, (req, res) => this.delete(req, res));
  }

  list(req: Request, res: Response): void {
    if (!req.user) {
      this.fail(res, 'unauthorized', 401);
      return;
    }
    this.success(res, tasksService.list(req.user.id));
  }

  get(req: Request, res: Response): void {
    const task = tasksService.get(req.params.id);
    if (!task) {
      this.fail(res, 'not found', 404);
      return;
    }
    this.success(res, task);
  }

  create(req: Request, res: Response): void {
    if (!req.user) {
      this.fail(res, 'unauthorized', 401);
      return;
    }
    const { title, description } = req.body as { title: string; description: string };
    const task = tasksService.create(req.user.id, { title, description });
    this.success(res, task, 201);
  }

  update(req: Request, res: Response): void {
    const task = tasksService.update(req.params.id, req.body as { title?: string; description?: string });
    if (!task) {
      this.fail(res, 'not found', 404);
      return;
    }
    this.success(res, task);
  }

  complete(req: Request, res: Response): void {
    const task = tasksService.complete(req.params.id);
    if (!task) {
      this.fail(res, 'not found', 404);
      return;
    }
    this.success(res, task);
  }

  delete(req: Request, res: Response): void {
    const ok = tasksService.delete(req.params.id);
    if (!ok) {
      this.fail(res, 'not found', 404);
      return;
    }
    this.success(res, { deleted: true });
  }
}

export const tasksController = new TasksController();
