import { Router } from 'express';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { badRequest } from '../../lib/errors';
import { optionalAuth } from '../../middleware/auth';
import { wrap, zodFields } from '../../middleware/error';
import { SimulatedProvider, type PaymentProvider } from '../payments/provider';
import { accessTokenBody, createContribution, idempotencyKey } from './schemas';
import { contributionView, createContributionService } from './service';

export function contributionRoutes(db: Db, config: Config, provider: PaymentProvider = new SimulatedProvider(config.ALLOW_SIMULATED_OUTCOMES === 'true')) {
  const router = Router();
  const service = createContributionService(db, config, provider);
  const auth = optionalAuth(db, config); // guests may contribute, so no account is required

  router.post('/campaigns/:id/contributions', auth, wrap(async (req, res) => {
    const body = createContribution.parse(req.body);
    const rawKey = req.header('Idempotency-Key');
    let key: string | undefined;
    if (rawKey !== undefined) {
      const parsed = idempotencyKey.safeParse(rawKey);
      if (!parsed.success) throw badRequest('Invalid Idempotency-Key header.', { 'Idempotency-Key': zodFields(parsed.error).body });
      key = parsed.data;
    }
    const result = await service.create(String(req.params.id), body, req.user, key);
    if (result.replayed) res.setHeader('Idempotent-Replay', 'true');
    res.status(result.replayed ? 200 : 201).json({
      contribution: contributionView(result.contribution),
      // The access token is shown once, on creation, and only a hash is stored.
      ...(result.accessToken ? { accessToken: result.accessToken } : {})
    });
  }));

  router.get('/campaigns/:id/backers', wrap(async (req, res) => {
    res.json(await service.backers(String(req.params.id)));
  }));

  router.get('/contributions/:id', auth, wrap(async (req, res) => {
    res.json(await service.receipt(String(req.params.id), req.user, req.header('X-Access-Token') ?? undefined));
  }));

  router.post('/contributions/:id/confirm', wrap(async (req, res) => {
    const { accessToken } = accessTokenBody.parse(req.body);
    const { contribution, message } = await service.confirm(String(req.params.id), accessToken);
    res.json({ contribution: contributionView(contribution), ...(message ? { message } : {}) });
  }));

  router.post('/contributions/:id/cancel', wrap(async (req, res) => {
    const { accessToken } = accessTokenBody.parse(req.body);
    res.json({ contribution: contributionView(await service.cancel(String(req.params.id), accessToken)) });
  }));

  return router;
}
