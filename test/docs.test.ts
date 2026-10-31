import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildOpenApi, operations } from '../src/openapi';
import { createTestContext } from './helpers';

let ctx: Awaited<ReturnType<typeof createTestContext>>;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('API documentation', () => {
  it('serves a valid-looking OpenAPI document', async () => {
    const res = await request(ctx.app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths).length).toBeGreaterThan(25);
    expect(res.body.components.schemas.Error).toBeTruthy();
  });

  it('builds request schemas from the same rules the server validates with', () => {
    const spec = buildOpenApi() as any;
    const create = spec.paths['/campaigns'].post.requestBody.content['application/json'].schema;
    expect(create.properties.title.maxLength).toBe(60);
    expect(create.properties.goalAmountCents.minimum).toBe(10_000);
    const pay = spec.paths['/campaigns/{id}/contributions'].post;
    expect(pay.requestBody.content['application/json'].schema.properties.amountCents.minimum).toBe(500);
    expect(pay.parameters.some((p: { name: string }) => p.name === 'Idempotency-Key')).toBe(true);
  });

  it('has no duplicate operations, and every one has a tag and a summary', () => {
    const keys = operations.map(o => `${o.method} ${o.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const op of operations) {
      expect(op.tag).toBeTruthy();
      expect(op.summary).toBeTruthy();
    }
  });

  it('documents only routes that really exist', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    for (const op of operations) {
      const res = await (request(ctx.app) as any)[op.method](op.path.replace('{id}', id)).send({});
      const phantom = res.status === 404 && res.body?.error?.message === 'Route not found';
      expect(phantom, `${op.method.toUpperCase()} ${op.path} is documented but not implemented`).toBe(false);
    }
  });

  it('serves the docs page and its assets with the strict security headers still on', async () => {
    const page = await request(ctx.app).get('/docs');
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.text).not.toMatch(/<script>/); // no inline scripts
    expect((await request(ctx.app).get('/docs/init.js')).status).toBe(200);
    expect((await request(ctx.app).get('/docs/assets/swagger-ui-bundle.js')).status).toBe(200);
    expect((await request(ctx.app).get('/docs/assets/swagger-ui.css')).status).toBe(200);
  });
});
