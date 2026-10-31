import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { auth, createTestContext, publish, signUp, signUpAdmin } from './helpers';

let ctx: Awaited<ReturnType<typeof createTestContext>>;
let owner: { token: string; id: string };
let stranger: { token: string; id: string };
let admin: { token: string; id: string };
let campaignId: string;

beforeAll(async () => {
  ctx = await createTestContext();
});
beforeEach(async () => {
  await ctx.reset();
  owner = await signUp(ctx, 'owner@example.com', 'Owner');
  stranger = await signUp(ctx, 'stranger@example.com');
  admin = await signUpAdmin(ctx);
  campaignId = await publish(ctx, owner.token, admin.token, { goalAmountCents: 10_000 });
});
afterAll(async () => {
  await ctx.close();
});

const api = () => request(ctx.app);
const pay = (amountCents: number, extra: Record<string, unknown> = {}) =>
  api().post(`/campaigns/${campaignId}/contributions`).send({ amountCents, paymentMethod: 'Google Pay', ...extra });
const report = (token = owner.token) => api().get(`/campaigns/${campaignId}/report`).set(auth(token));
const startPromoting = async () => {
  await pay(10_000); // reaches the goal
  await api().post(`/admin/campaigns/${campaignId}/transition`).set(auth(admin.token)).send({ to: 'distribution_prep' });
  await api().post(`/admin/campaigns/${campaignId}/transition`).set(auth(admin.token)).send({ to: 'promoting', adSetupConfirmed: true });
};
const record = (body: Record<string, unknown>) =>
  api().post(`/admin/campaigns/${campaignId}/delivery-reports`).set(auth(admin.token)).send(body);

describe('campaign report', () => {
  it('is visible to the creator and reviewers only', async () => {
    expect((await report()).status).toBe(200);
    expect((await report(admin.token)).status).toBe(200);
    expect((await report(stranger.token)).status).toBe(404);
    expect((await api().get(`/campaigns/${campaignId}/report`)).status).toBe(401);
  });

  it('adds up funds from confirmed payments only, with fees and ad budget in cents', async () => {
    await pay(2000);
    await pay(4000);
    await pay(1000, { simulateOutcome: 'declined' });
    await pay(1500, { simulateOutcome: 'pending' });
    const { body } = await report();
    expect(body.funds).toMatchObject({
      raisedAmountCents: 6000,
      platformFeesCents: 300,
      adBudgetAllocatedCents: 5700,
      contributions: { succeeded: 2, declined: 1, pending: 1, failed: 0, cancelled: 0, refunded: 0 }
    });
  });

  it('keeps the estimate separate from measured delivery, and says no delivery data exists yet', async () => {
    await pay(4000);
    const { body } = await report();
    expect(body.delivery.available).toBe(false);
    expect(body.estimated.reachWithFundsRaised.low).toBeLessThan(body.estimated.reachWithFundsRaised.high);
    expect(body.estimated.basis).toMatch(/Assumed/);
    expect(body.delivery).not.toHaveProperty('impressions'); // nothing is invented
  });
});

describe('recording delivery', () => {
  it('only reviewers can record, and only while promoting or completed', async () => {
    expect((await api().post(`/admin/campaigns/${campaignId}/delivery-reports`).set(auth(owner.token)).send({ impressions: 1, clicks: 0, spendCents: 0 })).status).toBe(403);
    const early = await record({ impressions: 1000, clicks: 10, spendCents: 100 });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('not_delivering');
  });

  it('shows measured figures, click-through rate and the remaining budget once ads have run', async () => {
    await startPromoting(); // $100 raised, $95 for ads
    expect((await record({ impressions: 40_000, clicks: 480, spendCents: 4000, reach: 22_000 })).status).toBe(201);
    expect((await record({ impressions: 20_000, clicks: 240, spendCents: 2000, reach: 31_000 })).status).toBe(201);
    const { body } = await report();
    expect(body.delivery).toMatchObject({
      available: true,
      source: 'reviewer-recorded',
      reports: 2,
      impressions: 60_000,
      clicks: 720,
      clickThroughRate: 0.012,
      adSpendCents: 6000,
      adBudgetRemainingCents: 3500,
      reachMeasured: 31_000
    });
    expect(body.estimated.reachAtGoal).toBeTruthy(); // the estimate is still its own section
  });

  it('refuses spend above the advertising budget raised', async () => {
    await startPromoting();
    const res = await record({ impressions: 100_000, clicks: 100, spendCents: 9600 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('exceeds_budget');
    expect((await report()).body.delivery.available).toBe(false);
  });

  it('rejects impossible figures', async () => {
    await startPromoting();
    const clicks = await record({ impressions: 100, clicks: 500, spendCents: 10 });
    expect(clicks.status).toBe(400);
    expect(clicks.body.error.fields.clicks).toBeTruthy();
    expect((await record({ impressions: 100, clicks: 1, spendCents: 10, reach: 900 })).status).toBe(400);
    expect((await record({ impressions: -5, clicks: 0, spendCents: 0 })).status).toBe(400);
  });

  it('tells the creator when the first figures arrive, once', async () => {
    await startPromoting();
    await record({ impressions: 1000, clicks: 10, spendCents: 100 });
    await record({ impressions: 1000, clicks: 10, spendCents: 100 });
    const notes = await ctx.db.select().from(schema.notifications).where(eq(schema.notifications.userId, owner.id));
    expect(notes.filter(n => n.title === 'Delivery figures available')).toHaveLength(1);
  });
});
