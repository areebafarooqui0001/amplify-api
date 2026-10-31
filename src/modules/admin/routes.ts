import { Router } from 'express';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { requireAuth, requireRole } from '../../middleware/auth';
import { wrap } from '../../middleware/error';
import { decisionInput, statusFilter, transitionInput } from '../campaigns/schemas';
import { createCampaignService } from '../campaigns/service';
import { createContributionService } from '../contributions/service';
import { SimulatedProvider } from '../payments/provider';
import { deliveryInput } from '../reports/schemas';
import { createReportService } from '../reports/service';

export function adminRoutes(db: Db, config: Config) {
  const router = Router();
  const service = createCampaignService(db);
  const payments = createContributionService(db, config, new SimulatedProvider(false));
  const reports = createReportService(db);
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

  // Returns every confirmed payment once a campaign is in refund_pending, then cancels the campaign.
  router.post('/campaigns/:id/refunds', wrap(async (req, res) => {
    res.json(await payments.refundCampaign(req.user!.id, String(req.params.id)));
  }));

  // A reviewer records measured delivery figures from the ad platform.
  router.post('/campaigns/:id/delivery-reports', wrap(async (req, res) => {
    res.status(201).json(await reports.recordDelivery(req.user!.id, String(req.params.id), deliveryInput.parse(req.body)));
  }));

  return router;
}
