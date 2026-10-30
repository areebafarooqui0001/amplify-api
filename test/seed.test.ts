import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/db/seed-data';
import { createTestContext } from './helpers';

let ctx: Awaited<ReturnType<typeof createTestContext>>;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('demo seed', () => {
  const opts = { adminEmail: 'Reviewer@Amplify.Local', adminPassword: 'a-long-test-password', bcryptCost: 4 };

  it('creates a reviewer and public demo campaigns, and is safe to run twice', async () => {
    const first = await seedDemo(ctx.db, opts);
    const second = await seedDemo(ctx.db, opts);
    expect(first).toEqual({ adminCreated: true, campaignsCreated: 5 });
    expect(second).toEqual({ adminCreated: false, campaignsCreated: 0 });

    const list = await request(ctx.app).get('/campaigns');
    expect(list.body.total).toBe(5);
  });

  it('lets the seeded reviewer sign in with the password from the environment', async () => {
    const login = await request(ctx.app).post('/auth/login').send({ email: 'reviewer@amplify.local', password: opts.adminPassword });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('admin');
  });

  it('never exposes a way to sign in as the demo creator', async () => {
    const res = await request(ctx.app).post('/auth/login').send({ email: 'demo-creator@amplify.local', password: 'password' });
    expect(res.status).toBe(401);
  });
});
