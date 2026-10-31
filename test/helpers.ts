import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { schema, type Db } from '../src/db/client';

const baseEnv = {
  NODE_ENV: 'test',
  JWT_SECRET: 'test-secret-test-secret-test-secret-123456',
  BCRYPT_COST: '4',
  RATE_LIMIT_ENABLED: 'false'
};
export const testConfig = loadConfig(baseEnv);

// By default tests run on in-memory PostgreSQL (no setup needed). Set TEST_DATABASE_URL to run the very same
// tests against a real PostgreSQL server. Each context then gets its own fresh database, so test files can run in parallel.
export async function createTestContext(overrides: Record<string, string> = {}) {
  const config = overrides ? loadConfig({ ...baseEnv, ...overrides }) : testConfig;
  const adminUrl = process.env.TEST_DATABASE_URL;

  let db: Db;
  let closeDb: () => Promise<void>;

  if (adminUrl) {
    const name = `amplify_test_${randomBytes(6).toString('hex')}`;
    const admin = new Pool({ connectionString: adminUrl, max: 1 });
    await admin.query(`create database ${name}`);
    await admin.end();
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.toString(), max: 10 });
    const real = drizzlePg(pool, { schema });
    await migratePg(real, { migrationsFolder: './drizzle' });
    db = real as unknown as Db;
    closeDb = async () => {
      await pool.end();
      const cleanup = new Pool({ connectionString: adminUrl, max: 1 });
      await cleanup.query(`drop database if exists ${name} with (force)`);
      await cleanup.end();
    };
  } else {
    const client = new PGlite();
    const lite = drizzle(client, { schema });
    await migrate(lite, { migrationsFolder: './drizzle' });
    db = lite as unknown as Db;
    closeDb = () => client.close();
  }

  const app = createApp(db, config);
  return {
    db,
    app,
    usingRealPostgres: !!adminUrl,
    async reset() {
      await db.execute(sql`truncate table users, campaigns, contributions, audit_log, notifications, follows, bookmarks, notification_preferences, delivery_reports, refresh_tokens, story_blocks, sources restart identity cascade`);
    },
    close: closeDb
  };
}

export const credentials = { email: 'areeb@example.com', name: 'Areeb', password: 'correct-horse-battery' };

export async function registerUser(app: ReturnType<typeof createApp>, overrides: Partial<typeof credentials> = {}) {
  const res = await request(app).post('/auth/register').send({ ...credentials, ...overrides });
  return res;
}

// ---------- Stage 2 helpers ----------
import { eq } from 'drizzle-orm';

type Ctx = Awaited<ReturnType<typeof createTestContext>>;

export async function signUp(ctx: Ctx, email: string, name = 'Test User') {
  const res = await request(ctx.app).post('/auth/register').send({ email, name, password: 'correct-horse-battery' });
  return { token: res.body.accessToken as string, id: res.body.user.id as string };
}

// The role lives in the database, so promoting a user takes effect on their existing token.
export async function signUpAdmin(ctx: Ctx, email = 'reviewer@example.com') {
  const user = await signUp(ctx, email, 'Reviewer');
  await ctx.db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, user.id));
  return user;
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

export const completeInput = (overrides: Record<string, unknown> = {}) => ({
  title: 'Clean drinking water testing in rural areas',
  category: 'Health',
  creatorName: 'Areeb',
  summary: 'What a year of water testing found, and what residents can ask for.',
  goalAmountCents: 250_000,
  targeting: { regions: ['India'], demographics: 'Adults 18 to 55', channels: ['Meta Ads (FB/IG)'], durationDays: 14 },
  story: [
    { type: 'heading', content: 'What we found' },
    { type: 'paragraph', content: 'Samples from forty wells were tested over twelve months.' }
  ],
  sources: [{ title: 'Testing summary', publication: 'Example Journal', url: 'https://example.org/summary' }],
  ...overrides
});

export const confirmations = { agreedToTruthfulness: true, agreedToTerms: true };

export async function draftAndSubmit(ctx: Ctx, token: string, overrides: Record<string, unknown> = {}) {
  const created = await request(ctx.app).post('/campaigns').set(auth(token)).send(completeInput(overrides));
  const submitted = await request(ctx.app).post(`/campaigns/${created.body.id}/submit`).set(auth(token)).send(confirmations);
  return { id: created.body.id as string, created, submitted };
}

// Walks a campaign through submit and approval so it is open for backing.
export async function publish(ctx: Ctx, ownerToken: string, adminToken: string, overrides: Record<string, unknown> = {}) {
  const { id } = await draftAndSubmit(ctx, ownerToken, overrides);
  await request(ctx.app).post(`/admin/campaigns/${id}/decision`).set(auth(adminToken)).send({ action: 'approve' });
  return id;
}
