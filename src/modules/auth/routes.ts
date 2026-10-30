import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { requireAuth } from '../../middleware/auth';
import { wrap } from '../../middleware/error';
import { loginSchema, refreshSchema, registerSchema } from './schemas';
import { createAuthService } from './service';

export function authRoutes(db: Db, config: Config) {
  const router = Router();
  const service = createAuthService(db, config);

  // Slows down password guessing. Switched off in tests.
  if (config.RATE_LIMIT_ENABLED === 'true') {
    router.use(['/login', '/register'], rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 30,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: { code: 'rate_limited', message: 'Too many attempts. Try again in a few minutes.' } }
    }));
  }

  router.post('/register', wrap(async (req, res) => {
    res.status(201).json(await service.register(registerSchema.parse(req.body)));
  }));

  router.post('/login', wrap(async (req, res) => {
    res.json(await service.login(loginSchema.parse(req.body)));
  }));

  router.post('/refresh', wrap(async (req, res) => {
    res.json(await service.refresh(refreshSchema.parse(req.body).refreshToken));
  }));

  router.post('/logout', wrap(async (req, res) => {
    await service.logout(refreshSchema.parse(req.body).refreshToken);
    res.status(204).end();
  }));

  router.get('/me', requireAuth(db, config), (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
