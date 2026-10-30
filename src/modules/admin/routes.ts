import { Router } from 'express';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { requireAuth, requireRole } from '../../middleware/auth';
import { wrap } from '../../middleware/error';
import { decisionInput, statusFilter, transitionInput } from '../campaigns/schemas';
import { createCampaignService } from '../campaigns/service';

export function adminRoutes(db: Db, config: Config) {
  const router = Router();
  const service = createCampaignService(db);
  router.use(requireAuth(db, config), requireRole('admin'));

  router.get('/campaigns', wrap(async (req, res) => {
    res.json(await service.listAll(statusFilter.parse(req.query).status));
  }));

  router.post('/campaigns/:id/decision', wrap(async (req, res) => {
    res.json(await service.decide(req.user!.id, String(req.params.id), decisionInput.parse(req.body)));
  }));

  router.post('/campaigns/:id/transition', wrap(async (req, res) => {
    res.json(await service.adminTransition(req.user!.id, String(req.params.id), transitionInput.parse(req.body)));
  }));

  return router;
}
