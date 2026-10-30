import { Router } from 'express';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { requireAuth } from '../../middleware/auth';
import { wrap } from '../../middleware/error';
import { createCampaignService } from '../campaigns/service';
import { statusFilter } from '../campaigns/schemas';

export function meRoutes(db: Db, config: Config) {
  const router = Router();
  const service = createCampaignService(db);
  router.use(requireAuth(db, config));

  router.get('/campaigns', wrap(async (req, res) => {
    const { status } = statusFilter.parse(req.query);
    res.json(await service.listMine(req.user!.id, status ? [status] : undefined));
  }));

  router.get('/drafts', wrap(async (req, res) => {
    res.json(await service.listMine(req.user!.id, ['draft', 'changes_requested']));
  }));

  return router;
}
