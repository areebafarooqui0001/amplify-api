import { Router } from 'express';
import type { Config } from '../../config';
import type { Db } from '../../db/client';
import { requireAuth } from '../../middleware/auth';
import { wrap } from '../../middleware/error';
import { createReportService } from './service';

export function reportRoutes(db: Db, config: Config) {
  const router = Router();
  const service = createReportService(db);

  router.get('/:id/report', requireAuth(db, config), wrap(async (req, res) => {
    res.json(await service.report(String(req.params.id), req.user!));
  }));

  return router;
}
