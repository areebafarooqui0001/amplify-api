import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { sql } from 'drizzle-orm';
import type { Config } from './config';
import type { Db } from './db/client';
import { errorHandler } from './middleware/error';
import { adminRoutes } from './modules/admin/routes';
import { authRoutes } from './modules/auth/routes';
import { campaignRoutes } from './modules/campaigns/routes';
import { contributionRoutes } from './modules/contributions/routes';
import { meRoutes } from './modules/me/routes';

// The app is built from its dependencies so tests can run it against an in-memory database.
export function createApp(db: Db, config: Config) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',') }));
  app.use(express.json({ limit: '100kb' }));

  app.get('/', (_req, res) => {
    res.json({ name: 'Amplify API', status: 'ok' });
  });

  app.get('/health', async (_req, res) => {
    try {
      await db.execute(sql`select 1`);
      res.json({ status: 'ok', database: 'up', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', database: 'down' });
    }
  });

  app.use('/auth', authRoutes(db, config));
  app.use('/campaigns', campaignRoutes(db, config));
  app.use('/', contributionRoutes(db, config));
  app.use('/me', meRoutes(db, config));
  app.use('/admin', adminRoutes(db, config));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });
  app.use(errorHandler);
  return app;
}
