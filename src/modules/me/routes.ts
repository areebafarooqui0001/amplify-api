import { Router } from 'express';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { requireAuth } from '../../middleware/auth';
import { wrap } from '../../middleware/error';
import { createCampaignService } from '../campaigns/service';
import { statusFilter } from '../campaigns/schemas';
import { createContributionService } from '../contributions/service';
import { SimulatedProvider } from '../payments/provider';
import { createEngagementService } from '../engagement/service';
import { createNotificationService } from '../notifications/service';
import { listNotifications, preferencesInput } from '../notifications/schemas';

export function meRoutes(db: Db, config: Config) {
  const router = Router();
  const service = createCampaignService(db);
  const payments = createContributionService(db, config, new SimulatedProvider(false));
  const notes = createNotificationService(db);
  const engagement = createEngagementService(db);
  router.use(requireAuth(db, config));

  router.get('/campaigns', wrap(async (req, res) => {
    const { status } = statusFilter.parse(req.query);
    res.json(await service.listMine(req.user!.id, status ? [status] : undefined));
  }));

  router.get('/drafts', wrap(async (req, res) => {
    res.json(await service.listMine(req.user!.id, ['draft', 'changes_requested']));
  }));

  // Payment history, including attempts that did not succeed.
  router.get('/contributions', wrap(async (req, res) => {
    res.json(await payments.listMine(req.user!.id));
  }));

  router.get('/notifications', wrap(async (req, res) => {
    res.json(await notes.list(req.user!.id, listNotifications.parse(req.query)));
  }));
  router.get('/notifications/unread-count', wrap(async (req, res) => {
    res.json(await notes.unreadCount(req.user!.id));
  }));
  router.post('/notifications/read-all', wrap(async (req, res) => {
    res.json(await notes.markAllRead(req.user!.id));
  }));
  router.post('/notifications/:id/read', wrap(async (req, res) => {
    res.json(await notes.markRead(req.user!.id, String(req.params.id)));
  }));

  router.get('/notification-preferences', wrap(async (req, res) => {
    res.json(await notes.getPreferences(req.user!.id));
  }));
  router.put('/notification-preferences', wrap(async (req, res) => {
    res.json(await notes.setPreferences(req.user!.id, preferencesInput.parse(req.body)));
  }));

  router.get('/follows', wrap(async (req, res) => {
    res.json(await engagement.listFollowed(req.user!.id));
  }));
  router.get('/bookmarks', wrap(async (req, res) => {
    res.json(await engagement.listBookmarked(req.user!.id));
  }));

  return router;
}
