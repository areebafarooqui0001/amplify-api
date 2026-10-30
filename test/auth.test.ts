import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { sha256 } from '../src/lib/crypto';
import { createTestContext, credentials, registerUser } from './helpers';

let ctx: Awaited<ReturnType<typeof createTestContext>>;

beforeAll(async () => {
  ctx = await createTestContext();
});
beforeEach(async () => {
  await ctx.reset();
});
afterAll(async () => {
  await ctx.close();
});

describe('health', () => {
  it('reports the database is up', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.database).toBe('up');
  });

  it('returns a consistent 404 shape', async () => {
    const res = await request(ctx.app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});

describe('register', () => {
  it('creates an account and returns tokens without any password data', async () => {
    const res = await registerUser(ctx.app);
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user).toMatchObject({ email: credentials.email, name: 'Areeb', role: 'user' });
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain(credentials.password);
  });

  it('stores only a bcrypt hash of the password', async () => {
    await registerUser(ctx.app);
    const [row] = await ctx.db.select().from(schema.users);
    expect(row.passwordHash).not.toBe(credentials.password);
    expect(row.passwordHash.startsWith('$2')).toBe(true);
  });

  it('rejects a duplicate email, ignoring letter case', async () => {
    await registerUser(ctx.app);
    const res = await registerUser(ctx.app, { email: 'AREEB@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('email_taken');
  });

  it('validates the fields and says which ones are wrong', async () => {
    const res = await registerUser(ctx.app, { email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.fields.email).toBeTruthy();
    expect(res.body.error.fields.password).toBeTruthy();
  });

  it('rejects malformed JSON with a clear error', async () => {
    const res = await request(ctx.app).post('/auth/register').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });
});

describe('login', () => {
  it('signs in with the right password', async () => {
    await registerUser(ctx.app);
    const res = await request(ctx.app).post('/auth/login').send({ email: credentials.email, password: credentials.password });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    await registerUser(ctx.app);
    const wrong = await request(ctx.app).post('/auth/login').send({ email: credentials.email, password: 'wrong-password-1' });
    const unknown = await request(ctx.app).post('/auth/login').send({ email: 'nobody@example.com', password: 'wrong-password-1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error.message).toBe(unknown.body.error.message);
  });
});

describe('current user and roles', () => {
  it('requires a valid token', async () => {
    expect((await request(ctx.app).get('/auth/me')).status).toBe(401);
    expect((await request(ctx.app).get('/auth/me').set('Authorization', 'Bearer garbage')).status).toBe(401);
  });

  it('returns the signed-in user', async () => {
    const { body } = await registerUser(ctx.app);
    const res = await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(credentials.email);
  });

  it('reads the role from the database, not from the token', async () => {
    const { body } = await registerUser(ctx.app);
    await ctx.db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, body.user.id));
    const res = await request(ctx.app).get('/auth/me').set('Authorization', `Bearer ${body.accessToken}`);
    expect(res.body.user.role).toBe('admin');
  });
});

describe('refresh tokens', () => {
  it('rotates: a new pair is issued and the old token stops working', async () => {
    const { body } = await registerUser(ctx.app);
    const res = await request(ctx.app).post('/auth/refresh').send({ refreshToken: body.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(body.refreshToken);
    const again = await request(ctx.app).post('/auth/refresh').send({ refreshToken: body.refreshToken });
    expect(again.status).toBe(401);
  });

  it('treats reuse of an old token as theft and revokes every session', async () => {
    const { body } = await registerUser(ctx.app);
    const rotated = await request(ctx.app).post('/auth/refresh').send({ refreshToken: body.refreshToken });
    const reuse = await request(ctx.app).post('/auth/refresh').send({ refreshToken: body.refreshToken });
    expect(reuse.body.error.code).toBe('token_reuse');
    const afterwards = await request(ctx.app).post('/auth/refresh').send({ refreshToken: rotated.body.refreshToken });
    expect(afterwards.status).toBe(401);
  });

  it('stores only a hash of the refresh token', async () => {
    const { body } = await registerUser(ctx.app);
    const [row] = await ctx.db.select().from(schema.refreshTokens);
    expect(row.tokenHash).toBe(sha256(body.refreshToken));
    expect(row.tokenHash).not.toBe(body.refreshToken);
  });

  it('rejects an expired refresh token', async () => {
    const { body } = await registerUser(ctx.app);
    await ctx.db.update(schema.refreshTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    const res = await request(ctx.app).post('/auth/refresh').send({ refreshToken: body.refreshToken });
    expect(res.status).toBe(401);
  });

  it('logout revokes the refresh token', async () => {
    const { body } = await registerUser(ctx.app);
    expect((await request(ctx.app).post('/auth/logout').send({ refreshToken: body.refreshToken })).status).toBe(204);
    const res = await request(ctx.app).post('/auth/refresh').send({ refreshToken: body.refreshToken });
    expect(res.status).toBe(401);
  });
});
