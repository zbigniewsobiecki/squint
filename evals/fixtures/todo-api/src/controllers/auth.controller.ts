import { type Request, type Response, type Router, createRouter } from '../framework.js';
import { authService } from '../services/auth.service.js';
import { BaseController } from './base.controller.js';

export class AuthController extends BaseController {
  router: Router;

  constructor() {
    super();
    this.router = createRouter();
    this.router.post('/register', (req, res) => this.register(req, res));
    this.router.post('/login', (req, res) => this.login(req, res));
    this.router.get('/me', (req, res) => this.me(req, res));
  }

  async register(req: Request, res: Response): Promise<void> {
    try {
      const { email, password } = req.body as { email: string; password: string };
      const result = await authService.register(email, password);
      this.success(res, result, 201);
    } catch (err) {
      this.handleError(res, err);
    }
  }

  async login(req: Request, res: Response): Promise<void> {
    try {
      const { email, password } = req.body as { email: string; password: string };
      const result = await authService.login(email, password);
      this.success(res, result);
    } catch (err) {
      this.handleError(res, err);
    }
  }

  me(req: Request, res: Response): void {
    if (!req.user) {
      this.fail(res, 'unauthorized', 401);
      return;
    }
    this.success(res, req.user);
  }
}

export const authController = new AuthController();
