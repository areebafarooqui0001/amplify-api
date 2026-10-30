import { Router } from 'express';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { optionalAuth, requireAuth } from '../../middleware/auth';
import { wrap } from '../../middleware/error';
import { campaignInput, listQuery, submitInput } from './schemas';
import { createCampaignService } from './service';

export function campaignRoutes(db: Db, config: Config) {
  const router = Router();
  const service = createCampaignService(db);

  router.get('/', wrap(async (req, res) => {
    res.json(await service.listPublic(listQuery.parse(req.query)));
  }));

  router.get('/:id', optionalAuth(db, config), wrap(async (req, res) => {
    res.json(await service.getDetail(String(req.params.id), req.user));
  }));

  router.post('/', requireAuth(db, config), wrap(async (req, res) => {
    res.status(201).json(await service.createDraft(req.user!, campaignInput.parse(req.body)));
  }));

  router.patch('/:id', requireAuth(db, config), wrap(async (req, res) => {
    res.json(await service.updateDraft(req.user!.id, String(req.params.id), campaignInput.parse(req.body)));
  }));

  router.post('/:id/submit', requireAuth(db, config), wrap(async (req, res) => {
    submitInput.parse(req.body);
    res.json(await service.submit(req.user!.id, String(req.params.id)));
  }));

  router.post('/:id/cancel', requireAuth(db, config), wrap(async (req, res) => {
    res.json(await service.cancel(req.user!.id, String(req.params.id)));
  }));

  router.get('/:id/audit', requireAuth(db, config), wrap(async (req, res) => {
    res.json(await service.audit(String(req.params.id), req.user!));
  }));

  return router;
}
