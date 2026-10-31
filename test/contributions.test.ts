import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { auth, createTestContext, publish, signUp, signUpAdmin } from './helpers';

let ctx: Awaited<ReturnType<typeof createTestContext>>;
let owner: { token: string; id: string };
let backer: { token: string; id: string };
let admin: { token: string; id: string };
let campaignId: string;

beforeAll(async () => {
  ctx = await createTestContext();
});
beforeEach(async () => {
  await ctx.reset();
  owner = await signUp(ctx, 'owner@example.com', 'Owner');
  backer = await signUp(ctx, 'backer@example.com', 'Backer');
  admin = await signUpAdmin(ctx);
  campaignId = await publish(ctx, owner.token, admin.token); // goal $2,500
});
afterAll(async () => {
  await ctx.close();
});

const api = () => request(ctx.app);
const pay = (id: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  api().post(`/campaigns/${id}/contributions`).set(headers).send({ amountCents: 2500, paymentMethod: 'Google Pay', ...body });
const funding = async (id = campaignId) => (await api().get(`/campaigns/${id}`)).body.funding;
const notesFor = async (userId: string) =>
  (await ctx.db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId))).map(n => n.title);

describe('contributing', () => {
  it('lets a guest contribute, with the 5% fee worked out in cents', async () => {
    const res = await pay(campaignId);
    expect(res.status).toBe(201);
    expect(res.body.contribution).toMatchObject({ amountCents: 2500, feeCents: 125, netAdCents: 2375, status: 'succeeded', anonymous: true });
    expect(res.body.contribution.estimatedReach.low).toBeLessThan(res.body.contribution.estimatedReach.high);
    expect(res.body.accessToken).toBeTruthy();
    expect(await funding()).toMatchObject({ raisedAmountCents: 2500, backerCount: 1 });
  });

  it('never exposes the payer id or the stored token hash', async () => {
    const res = await pay(campaignId, {}, auth(backer.token));
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('backerId');
    expect(text).not.toContain('settleTokenHash');
    expect(text).not.toContain(backer.id);
    const [row] = await ctx.db.select().from(schema.contributions);
    expect(row.settleTokenHash).not.toBe(res.body.accessToken); // only a hash is stored
  });

  it('validates the amount and the payment method', async () => {
    expect((await pay(campaignId, { amountCents: 100 })).body.error.fields.amountCents).toBeTruthy(); // under $5
    expect((await pay(campaignId, { amountCents: 25.5 })).status).toBe(400); // fractions of a cent
    expect((await pay(campaignId, { amountCents: 600_000 })).status).toBe(400); // over $5,000
    expect((await pay(campaignId, { paymentMethod: 'Bitcoin' })).status).toBe(400);
    expect((await funding()).raisedAmountCents).toBe(0);
  });

  it('cannot back a campaign that is not open, or does not exist', async () => {
    const draft = await api().post('/campaigns').set(auth(owner.token)).send({ title: 'Not yet' });
    expect((await pay(draft.body.id)).status).toBe(409);
    expect((await pay('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await pay('nonsense')).status).toBe(404);
  });

  it('keeps names private by default and shows only those who chose to be public', async () => {
    await pay(campaignId);
    await pay(campaignId, { anonymous: false, backerName: 'Priya' });
    const res = await api().get(`/campaigns/${campaignId}/backers`);
    expect(res.body).toEqual({ totalBackers: 2, anonymousBackers: 1, publicBackers: ['Priya'] });
  });

  it('only counts the allowed outcome when simulation is switched on', async () => {
    const strict = await createTestContext({ ALLOW_SIMULATED_OUTCOMES: 'false' });
    const o = await signUp(strict, 'o@example.com');
    const a = await signUpAdmin(strict);
    const id = await publish(strict, o.token, a.token);
    const res = await request(strict.app).post(`/campaigns/${id}/contributions`)
      .send({ amountCents: 2500, paymentMethod: 'Google Pay', simulateOutcome: 'declined' });
    expect(res.body.contribution.status).toBe('succeeded'); // the hint was ignored
    await strict.close();
  });
});

describe('payment states', () => {
  it('records declined and failed payments without counting them', async () => {
    for (const outcome of ['declined', 'failed']) {
      const res = await pay(campaignId, { simulateOutcome: outcome });
      expect(res.body.contribution.status).toBe(outcome);
    }
    expect(await funding()).toMatchObject({ raisedAmountCents: 0, backerCount: 0 });
  });

  it('counts a pending payment only after it is confirmed with the right token', async () => {
    const res = await pay(campaignId, { simulateOutcome: 'pending' });
    const { id } = res.body.contribution;
    expect((await funding()).raisedAmountCents).toBe(0);

    const wrong = await api().post(`/contributions/${id}/confirm`).send({ accessToken: 'wrong-token-value' });
    expect(wrong.status).toBe(404);

    const ok = await api().post(`/contributions/${id}/confirm`).send({ accessToken: res.body.accessToken });
    expect(ok.body.contribution.status).toBe('succeeded');
    expect(await funding()).toMatchObject({ raisedAmountCents: 2500, backerCount: 1 });

    const again = await api().post(`/contributions/${id}/confirm`).send({ accessToken: res.body.accessToken });
    expect(again.status).toBe(409);
    expect((await funding()).raisedAmountCents).toBe(2500); // never counted twice
  });

  it('lets the payer cancel a pending payment, after which it cannot be confirmed', async () => {
    const res = await pay(campaignId, { simulateOutcome: 'pending' });
    const { id } = res.body.contribution;
    const cancelled = await api().post(`/contributions/${id}/cancel`).send({ accessToken: res.body.accessToken });
    expect(cancelled.body.contribution.status).toBe('cancelled');
    expect((await api().post(`/contributions/${id}/confirm`).send({ accessToken: res.body.accessToken })).status).toBe(409);
    expect((await funding()).raisedAmountCents).toBe(0);
  });

  it('fails a pending payment if the campaign closed first, without charging', async () => {
    const res = await pay(campaignId, { simulateOutcome: 'pending' });
    await ctx.db.update(schema.campaigns).set({ status: 'goal_reached' }).where(eq(schema.campaigns.id, campaignId));
    const confirmed = await api().post(`/contributions/${res.body.contribution.id}/confirm`).send({ accessToken: res.body.accessToken });
    expect(confirmed.body.contribution.status).toBe('failed');
    expect(confirmed.body.message).toMatch(/not charged/);
    expect((await funding()).raisedAmountCents).toBe(0);
  });
});

describe('retries and idempotency', () => {
  const key = { 'Idempotency-Key': 'order-attempt-0001' };

  it('returns the original payment instead of charging twice', async () => {
    const first = await pay(campaignId, {}, key);
    const second = await pay(campaignId, {}, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.contribution.id).toBe(first.body.contribution.id);
    expect(second.body).not.toHaveProperty('accessToken'); // the token is shown once
    expect(await funding()).toMatchObject({ raisedAmountCents: 2500, backerCount: 1 });
  });

  it('refuses to reuse a key for a different request', async () => {
    await pay(campaignId, {}, key);
    const res = await pay(campaignId, { amountCents: 9000 }, key);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('idempotency_key_conflict');
  });

  it('rejects a malformed key', async () => {
    expect((await pay(campaignId, {}, { 'Idempotency-Key': 'short' })).status).toBe(400);
  });

  it('creates exactly one payment when identical requests arrive at the same time', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => pay(campaignId, {}, key)));
    expect(new Set(results.map(r => r.body.contribution.id)).size).toBe(1);
    expect(await ctx.db.select().from(schema.contributions)).toHaveLength(1);
    expect(await funding()).toMatchObject({ raisedAmountCents: 2500, backerCount: 1 });
  });
});

describe('reaching the goal', () => {
  let small: string;
  beforeEach(async () => {
    small = await publish(ctx, owner.token, admin.token, { title: 'Small goal', goalAmountCents: 10_000 });
  });

  it('closes funding at the goal but does not launch ads', async () => {
    await pay(small, { amountCents: 6000 });
    const reached = await pay(small, { amountCents: 6000 });
    expect(reached.body.contribution.status).toBe('succeeded');

    const detail = await api().get(`/campaigns/${small}`);
    expect(detail.body.status).toBe('goal_reached'); // not promoting
    expect(detail.body.funding).toMatchObject({ raisedAmountCents: 12_000, percentFunded: 100 });

    const trail = await api().get(`/campaigns/${small}/audit`).set(auth(owner.token));
    const last = trail.body.items.at(-1);
    expect(last).toMatchObject({ fromStatus: 'funding', toStatus: 'goal_reached', actorRole: 'system', actorId: null });
    expect(await notesFor(owner.id)).toContain('Funding goal reached');
  });

  it('lets exactly the right number of payments through when many arrive at once', async () => {
    // Goal is $100. Ten $30 payments race: $30, $60, $90, then the fourth reaches $120 and closes funding.
    const results = await Promise.all(Array.from({ length: 10 }, () => pay(small, { amountCents: 3000 })));
    const accepted = results.filter(r => r.status === 201);
    const refused = results.filter(r => r.status === 409);
    expect(accepted).toHaveLength(4);
    expect(refused).toHaveLength(6);
    const detail = await api().get(`/campaigns/${small}`);
    expect(detail.body.funding).toMatchObject({ raisedAmountCents: 12_000, backerCount: 4 });
    expect(detail.body.status).toBe('goal_reached');
    const rows = await ctx.db.select().from(schema.contributions).where(eq(schema.contributions.campaignId, small));
    expect(rows).toHaveLength(4); // refused requests leave nothing behind
  });

  it('stops accepting contributions once the goal is reached', async () => {
    await pay(small, { amountCents: 12_000 });
    const res = await pay(small, { amountCents: 500 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_open_for_backing');
  });

  it('tells the creator about each milestone crossed, once', async () => {
    await pay(small, { amountCents: 6000 }); // 0% to 60%: crosses 25% and 50%
    await pay(small, { amountCents: 500 }); // 65%: no new milestone
    const titles = await notesFor(owner.id);
    expect(titles.filter(t => t === 'Funding milestone: 25%')).toHaveLength(1);
    expect(titles.filter(t => t === 'Funding milestone: 50%')).toHaveLength(1);
    expect(titles).not.toContain('Funding milestone: 75%');
  });
});

describe('receipts and history', () => {
  it('shows a receipt to the payer, or to a guest who holds the token, and to nobody else', async () => {
    const guest = await pay(campaignId);
    const id = guest.body.contribution.id;
    const byToken = await api().get(`/contributions/${id}`).set('X-Access-Token', guest.body.accessToken);
    expect(byToken.status).toBe(200);
    expect(byToken.body.campaignTitle).toBeTruthy();
    expect((await api().get(`/contributions/${id}`)).status).toBe(404);
    expect((await api().get(`/contributions/${id}`).set(auth(backer.token))).status).toBe(404);

    const mine = await pay(campaignId, {}, auth(backer.token));
    expect((await api().get(`/contributions/${mine.body.contribution.id}`).set(auth(backer.token))).status).toBe(200);
  });

  it('lists my payment attempts, including ones that did not succeed, and nobody else’s', async () => {
    await pay(campaignId, {}, auth(backer.token));
    await pay(campaignId, { simulateOutcome: 'declined' }, auth(backer.token));
    await pay(campaignId, {}, auth(owner.token));
    const res = await api().get('/me/contributions').set(auth(backer.token));
    expect(res.body.items.map((c: { status: string }) => c.status).sort()).toEqual(['declined', 'succeeded']);
    expect(res.body.items[0].campaignTitle).toBeTruthy();
    expect((await api().get('/me/contributions')).status).toBe(401);
  });

  it('notifies a signed-in payer of every outcome', async () => {
    await pay(campaignId, {}, auth(backer.token));
    await pay(campaignId, { simulateOutcome: 'declined' }, auth(backer.token));
    expect(await notesFor(backer.id)).toEqual(expect.arrayContaining(['Payment succeeded', 'Payment declined']));
  });
});

describe('refunds', () => {
  it('returns every confirmed payment, cancels the campaign and tells the backers', async () => {
    await pay(campaignId, { amountCents: 2500 }, auth(backer.token));
    await pay(campaignId, { amountCents: 5000 });
    await pay(campaignId, { simulateOutcome: 'declined' }); // never charged, so never refunded

    const toRefund = await api().post(`/admin/campaigns/${campaignId}/transition`).set(auth(admin.token)).send({ to: 'refund_pending' });
    expect(toRefund.body.status).toBe('refund_pending');
    expect((await pay(campaignId)).status).toBe(409); // no new backing while refunds are pending

    expect((await api().post(`/admin/campaigns/${campaignId}/refunds`).set(auth(owner.token))).status).toBe(403);
    const res = await api().post(`/admin/campaigns/${campaignId}/refunds`).set(auth(admin.token));
    expect(res.body).toEqual({ refundedCount: 2, refundedCents: 7500 });

    const detail = await api().get(`/campaigns/${campaignId}`).set(auth(admin.token));
    expect(detail.body.status).toBe('cancelled');
    expect(detail.body.funding).toMatchObject({ raisedAmountCents: 0, backerCount: 0 });
    const history = await api().get('/me/contributions').set(auth(backer.token));
    expect(history.body.items[0].status).toBe('refunded');
    expect(await notesFor(backer.id)).toContain('Contribution refunded');
  });

  it('refuses to refund a campaign that is not waiting for refunds', async () => {
    await pay(campaignId);
    const res = await api().post(`/admin/campaigns/${campaignId}/refunds`).set(auth(admin.token));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('not_refund_pending');
  });
});
