import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { schema, type Db } from '../src/db/client';

export const testConfig = loadConfig({
  NODE_ENV: 'test',
  JWT_SECRET: 'test-secret-test-secret-test-secret-123456',
  BCRYPT_COST: '4',
  RATE_LIMIT_ENABLED: 'false'
});

// In-memory PostgreSQL running the same migration files as production.
export async function createTestContext() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: './drizzle' });
  const app = createApp(db as unknown as Db, testConfig);
  return {
    db: db as unknown as Db,
    app,
    async reset() {
      await db.execute(sql`truncate table users, campaigns, contributions, audit_log, notifications, follows, refresh_tokens, story_blocks, sources restart identity cascade`);
    },
    async close() {
      await client.close();
    }
  };
}

export const credentials = { email: 'areeb@example.com', name: 'Areeb', password: 'correct-horse-battery' };

export async function registerUser(app: ReturnType<typeof createApp>, overrides: Partial<typeof credentials> = {}) {
  const res = await request(app).post('/auth/register').send({ ...credentials, ...overrides });
  return res;
}
