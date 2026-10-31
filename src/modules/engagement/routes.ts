import { Router } from 'express';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { requireAuth } from '../../middleware/auth';
import { wrap } from '../../middleware/error';
import { createEngagementService } from './service';

export function engagementRoutes(db: Db, config: Config) {
  const router = Router();
  const service = createEngagementService(db);
  const auth = requireAuth(db, config);

  router.post('/:id/follow', auth, wrap(async (req, res) => res.json(await service.follow(req.user!.id, String(req.params.id)))));
  router.delete('/:id/follow', auth, wrap(async (req, res) => res.json(await service.unfollow(req.user!.id, String(req.params.id)))));
  router.post('/:id/bookmark', auth, wrap(async (req, res) => res.json(await service.bookmark(req.user!.id, String(req.params.id)))));
  router.delete('/:id/bookmark', auth, wrap(async (req, res) => res.json(await service.unbookmark(req.user!.id, String(req.params.id)))));

  return router;
}
