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
