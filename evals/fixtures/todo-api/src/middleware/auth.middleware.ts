import type { Handler } from '../framework.js';
import { authService } from '../services/auth.service.js';

export const requireAuth: Handler = (req, res, next) => {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const user = authService.verify(token);
  if (!user) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.user = user;
  next?.();
};
