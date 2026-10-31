import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import { auth, createTestContext, draftAndSubmit, publish, signUp, signUpAdmin } from './helpers';

let ctx: Awaited<ReturnType<typeof createTestContext>>;
let owner: { token: string; id: string };
let fan: { token: string; id: string };
let admin: { token: string; id: string };
let campaignId: string;

beforeAll(async () => {
  ctx = await createTestContext();
});
beforeEach(async () => {
  await ctx.reset();
  owner = await signUp(ctx, 'owner@example.com', 'Owner');
  fan = await signUp(ctx, 'fan@example.com', 'Fan');
  admin = await signUpAdmin(ctx);
  campaignId = await publish(ctx, owner.token, admin.token, { goalAmountCents: 10_000 });
});
afterAll(async () => {
  await ctx.close();
});

const api = () => request(ctx.app);
const pay = (id: string, amountCents = 2500) =>
  api().post(`/campaigns/${id}/contributions`).send({ amountCents, paymentMethod: 'Google Pay' });
const titles = async (token: string) => (await api().get('/me/notifications').set(auth(token))).body.items.map((n: { title: string }) => n.title);

describe('notifications', () => {
  it('requires sign-in and returns only my own, newest first, with an unread count', async () => {
    expect((await api().get('/me/notifications')).status).toBe(401);
    await pay(campaignId);
    const mine = await api().get('/me/notifications').set(auth(owner.token));
    expect(mine.body.total).toBeGreaterThan(0);
    expect(mine.body.unreadCount).toBe(mine.body.total);
    const times = mine.body.items.map((n: { createdAt: string }) => new Date(n.createdAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect((await api().get('/me/notifications').set(auth(fan.token))).body.total).toBe(0);
  });

  it('marks one as read, and refuses to touch someone else’s', async () => {
    await pay(campaignId);
    const list = await api().get('/me/notifications').set(auth(owner.token));
    const id = list.body.items[0].id;
    expect((await api().post(`/me/notifications/${id}/read`).set(auth(fan.token))).status).toBe(404);
    expect((await api().post(`/me/notifications/${id}/read`).set(auth(owner.token))).body.read).toBe(true);
    const after = await api().get('/me/notifications/unread-count').set(auth(owner.token));
    expect(after.body.unreadCount).toBe(list.body.unreadCount - 1);
    expect((await api().post('/me/notifications/nonsense/read').set(auth(owner.token))).status).toBe(404);
  });

  it('marks everything as read', async () => {
    await pay(campaignId);
    const res = await api().post('/me/notifications/read-all').set(auth(owner.token));
    expect(res.body.updated).toBeGreaterThan(0);
    expect((await api().get('/me/notifications/unread-count').set(auth(owner.token))).body.unreadCount).toBe(0);
    expect((await api().get('/me/notifications').query({ unread: 'true' }).set(auth(owner.token))).body.items).toEqual([]);
  });

  it('filters by type and paginates', async () => {
    await pay(campaignId, 6000);
    const milestones = await api().get('/me/notifications').query({ type: 'milestone' }).set(auth(owner.token));
    expect(milestones.body.items.every((n: { type: string }) => n.type === 'milestone')).toBe(true);
    const page = await api().get('/me/notifications').query({ limit: 1, offset: 0 }).set(auth(owner.token));
    expect(page.body.items).toHaveLength(1);
    expect(page.body.total).toBeGreaterThan(1);
  });
});

describe('notification preferences', () => {
  it('defaults to everything on, and saves changes', async () => {
    const start = await api().get('/me/notification-preferences').set(auth(owner.token));
    expect(start.body).toEqual({ milestone: true, promotion: true, contribution: true, status: true });
    const changed = await api().put('/me/notification-preferences').set(auth(owner.token)).send({ milestone: false });
    expect(changed.body).toEqual({ milestone: false, promotion: true, contribution: true, status: true });
    expect((await api().get('/me/notification-preferences').set(auth(owner.token))).body.milestone).toBe(false);
    expect((await api().put('/me/notification-preferences').set(auth(owner.token)).send({})).status).toBe(400);
  });

  it('hides a switched-off category from the feed and the unread count, and brings it back when switched on', async () => {
    await pay(campaignId, 6000); // creates milestone and contribution notifications for the owner
    const before = await api().get('/me/notifications').set(auth(owner.token));
    expect(before.body.items.some((n: { type: string }) => n.type === 'milestone')).toBe(true);

    await api().put('/me/notification-preferences').set(auth(owner.token)).send({ milestone: false });
    const hidden = await api().get('/me/notifications').set(auth(owner.token));
    expect(hidden.body.items.some((n: { type: string }) => n.type === 'milestone')).toBe(false);
    expect(hidden.body.unreadCount).toBeLessThan(before.body.unreadCount);

    await api().put('/me/notification-preferences').set(auth(owner.token)).send({ milestone: true });
    const shown = await api().get('/me/notifications').set(auth(owner.token));
    expect(shown.body.items.some((n: { type: string }) => n.type === 'milestone')).toBe(true);
  });

  it('shows nothing when every category is off', async () => {
    await pay(campaignId);
    await api().put('/me/notification-preferences').set(auth(owner.token))
      .send({ milestone: false, promotion: false, contribution: false, status: false });
    const res = await api().get('/me/notifications').set(auth(owner.token));
    expect(res.body).toEqual({ total: 0, unreadCount: 0, items: [] });
  });
});

describe('following', () => {
  it('follows and unfollows, safely repeated, and tells a signed-in viewer their state', async () => {
    expect((await api().post(`/campaigns/${campaignId}/follow`)).status).toBe(401);
    await api().post(`/campaigns/${campaignId}/follow`).set(auth(fan.token));
    await api().post(`/campaigns/${campaignId}/follow`).set(auth(fan.token)); // repeat is harmless
    expect(await ctx.db.select().from(schema.follows)).toHaveLength(1);

    const detail = await api().get(`/campaigns/${campaignId}`).set(auth(fan.token));
    expect(detail.body.viewer).toEqual({ following: true, bookmarked: false });
    expect((await api().get(`/campaigns/${campaignId}`)).body).not.toHaveProperty('viewer');

    const list = await api().get('/me/follows').set(auth(fan.token));
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([campaignId]);

    await api().delete(`/campaigns/${campaignId}/follow`).set(auth(fan.token));
    await api().delete(`/campaigns/${campaignId}/follow`).set(auth(fan.token));
    expect((await api().get('/me/follows').set(auth(fan.token))).body.items).toEqual([]);
  });

  it('cannot follow a campaign that is not published', async () => {
    const { id } = await draftAndSubmit(ctx, owner.token, { title: 'Still in review' });
    expect((await api().post(`/campaigns/${id}/follow`).set(auth(fan.token))).status).toBe(404);
    expect((await api().post('/campaigns/not-a-uuid/follow').set(auth(fan.token))).status).toBe(404);
  });

  it('tells followers about key moments only, and never the owner twice', async () => {
    await api().post(`/campaigns/${campaignId}/follow`).set(auth(fan.token));
    await api().post(`/campaigns/${campaignId}/follow`).set(auth(owner.token)); // the owner following their own campaign

    await pay(campaignId, 1200); // 12%: no milestone for followers
    expect(await titles(fan.token)).toEqual([]);

    await pay(campaignId, 4000); // 52%: crosses 25% and 50%
    expect(await titles(fan.token)).toEqual(['A campaign you follow is halfway funded']);

    await pay(campaignId, 6000); // goal reached
    expect(await titles(fan.token)).toContain('A campaign you follow reached its goal');
    const ownerTitles = await titles(owner.token);
    expect(ownerTitles.filter((t: string) => t === 'Funding goal reached')).toHaveLength(1);
    expect(ownerTitles).not.toContain('A campaign you follow reached its goal');
  });
});

describe('saved campaigns', () => {
  it('saves privately and lists them without affecting following', async () => {
    await api().post(`/campaigns/${campaignId}/bookmark`).set(auth(fan.token));
    const detail = await api().get(`/campaigns/${campaignId}`).set(auth(fan.token));
    expect(detail.body.viewer).toEqual({ following: false, bookmarked: true });
    expect((await api().get('/me/bookmarks').set(auth(fan.token))).body.items).toHaveLength(1);
    expect((await api().get('/me/bookmarks').set(auth(owner.token))).body.items).toHaveLength(0);
    await api().delete(`/campaigns/${campaignId}/bookmark`).set(auth(fan.token));
    expect((await api().get('/me/bookmarks').set(auth(fan.token))).body.items).toEqual([]);
  });

  it('drops a saved campaign from the list if it stops being public', async () => {
    await api().post(`/campaigns/${campaignId}/bookmark`).set(auth(fan.token));
    await ctx.db.update(schema.campaigns).set({ status: 'cancelled' }).where(eq(schema.campaigns.id, campaignId));
    expect((await api().get('/me/bookmarks').set(auth(fan.token))).body.items).toEqual([]);
  });
});
