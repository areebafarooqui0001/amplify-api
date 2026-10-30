import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db/client';
import {
  auth, completeInput, confirmations, createTestContext, draftAndSubmit, publish, signUp, signUpAdmin
} from './helpers';

let ctx: Awaited<ReturnType<typeof createTestContext>>;
let owner: { token: string; id: string };
let stranger: { token: string; id: string };
let admin: { token: string; id: string };

beforeAll(async () => {
  ctx = await createTestContext();
});
beforeEach(async () => {
  await ctx.reset();
  owner = await signUp(ctx, 'owner@example.com', 'Owner');
  stranger = await signUp(ctx, 'stranger@example.com', 'Stranger');
  admin = await signUpAdmin(ctx);
});
afterAll(async () => {
  await ctx.close();
});

const api = () => request(ctx.app);

describe('drafts', () => {
  it('requires sign-in to create a draft', async () => {
    expect((await api().post('/campaigns').send({ title: 'x' })).status).toBe(401);
  });

  it('saves an incomplete draft, with no funding goal chosen for the creator', async () => {
    const res = await api().post('/campaigns').set(auth(owner.token)).send({ title: 'Early idea' });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('draft');
    expect(res.body.funding.goalAmountCents).toBe(0);
    expect(res.body.creatorName).toBe('Owner');
    expect(res.body.ownerId).toBe(owner.id);
  });

  it('rejects a title over 60 characters and says which field', async () => {
    const res = await api().post('/campaigns').set(auth(owner.token)).send({ title: 'T'.repeat(61) });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.title).toBeTruthy();
  });

  it('rejects a goal under $100 and an unsupported channel', async () => {
    const goal = await api().post('/campaigns').set(auth(owner.token)).send({ goalAmountCents: 500 });
    expect(goal.status).toBe(400);
    expect(goal.body.error.fields.goalAmountCents).toBeTruthy();
    const channel = await api().post('/campaigns').set(auth(owner.token))
      .send({ targeting: { regions: ['India'], demographics: '', channels: ['TikTok'], durationDays: 14 } });
    expect(channel.status).toBe(400);
  });

  it('replaces the story and sources on update, keeping the order', async () => {
    const created = await api().post('/campaigns').set(auth(owner.token)).send(completeInput());
    const res = await api().patch(`/campaigns/${created.body.id}`).set(auth(owner.token)).send({
      story: [
        { type: 'paragraph', content: 'Second' },
        { type: 'heading', content: 'First' }
      ],
      sources: []
    });
    expect(res.status).toBe(200);
    expect(res.body.story.map((b: { content: string }) => b.content)).toEqual(['Second', 'First']);
    expect(res.body.sources).toEqual([]);
    expect(res.body.title).toBe(completeInput().title); // fields that were not sent are untouched
  });

  it('only lets the owner edit, and treats a bad id as not found', async () => {
    const created = await api().post('/campaigns').set(auth(owner.token)).send(completeInput());
    const other = await api().patch(`/campaigns/${created.body.id}`).set(auth(stranger.token)).send({ title: 'Mine now' });
    expect(other.status).toBe(404);
    expect((await api().get('/campaigns/not-a-uuid')).status).toBe(404);
  });
});

describe('submitting for review', () => {
  it('lists every missing field instead of failing on the first', async () => {
    const created = await api().post('/campaigns').set(auth(owner.token)).send({ title: 'Just a title' });
    const res = await api().post(`/campaigns/${created.body.id}/submit`).set(auth(owner.token)).send(confirmations);
    expect(res.status).toBe(400);
    const fields = res.body.error.fields;
    expect(fields.summary).toBeTruthy();
    expect(fields.story).toBeTruthy();
    expect(fields.goalAmountCents).toBeTruthy();
    expect(fields['targeting.regions']).toBeTruthy();
    expect(fields['targeting.channels']).toBeTruthy();
  });

  it('needs both confirmations', async () => {
    const created = await api().post('/campaigns').set(auth(owner.token)).send(completeInput());
    const res = await api().post(`/campaigns/${created.body.id}/submit`).set(auth(owner.token)).send({ agreedToTruthfulness: true });
    expect(res.status).toBe(400);
    expect(res.body.error.fields.agreedToTerms).toBeTruthy();
  });

  it('moves a complete draft to under_review, with an audit entry and a notification', async () => {
    const { id, submitted } = await draftAndSubmit(ctx, owner.token);
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('under_review');
    expect(submitted.body.adCreative.headline).toBe(completeInput().title.slice(0, 45)); // title doubles as ad headline
    const audit = await api().get(`/campaigns/${id}/audit`).set(auth(owner.token));
    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.items[0]).toMatchObject({ fromStatus: 'draft', toStatus: 'under_review', actorRole: 'user' });
    const notes = await ctx.db.select().from(schema.notifications).where(eq(schema.notifications.userId, owner.id));
    expect(notes.map(n => n.title)).toContain('Submission received');
  });

  it('locks the campaign while it is in review and cannot be submitted twice', async () => {
    const { id } = await draftAndSubmit(ctx, owner.token);
    const edit = await api().patch(`/campaigns/${id}`).set(auth(owner.token)).send({ title: 'Changed' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe('not_editable');
    const again = await api().post(`/campaigns/${id}/submit`).set(auth(owner.token)).send(confirmations);
    expect(again.status).toBe(409);
  });
});

describe('who can see what', () => {
  it('keeps drafts and campaigns in review out of the public list and detail', async () => {
    const draft = await api().post('/campaigns').set(auth(owner.token)).send(completeInput());
    const { id: reviewId } = await draftAndSubmit(ctx, owner.token, { title: 'In review' });
    const list = await api().get('/campaigns');
    expect(list.body.total).toBe(0);
    for (const id of [draft.body.id, reviewId]) {
      expect((await api().get(`/campaigns/${id}`)).status).toBe(404);
      expect((await api().get(`/campaigns/${id}`).set(auth(stranger.token))).status).toBe(404);
    }
  });

  it('shows the owner and reviewers the private fields, but not the public', async () => {
    const id = await publish(ctx, owner.token, admin.token);
    const asOwner = await api().get(`/campaigns/${id}`).set(auth(owner.token));
    const asAdmin = await api().get(`/campaigns/${id}`).set(auth(admin.token));
    const asGuest = await api().get(`/campaigns/${id}`);
    expect(asOwner.body.ownerId).toBe(owner.id);
    expect(asAdmin.body.adSetupConfirmed).toBe(false);
    expect(asGuest.status).toBe(200);
    for (const key of ['ownerId', 'reviewFeedback', 'adSetupConfirmed', 'submittedAt']) {
      expect(asGuest.body).not.toHaveProperty(key);
    }
  });

  it('shows the history only to the owner and reviewers', async () => {
    const { id } = await draftAndSubmit(ctx, owner.token);
    expect((await api().get(`/campaigns/${id}/audit`).set(auth(owner.token))).status).toBe(200);
    expect((await api().get(`/campaigns/${id}/audit`).set(auth(admin.token))).status).toBe(200);
    expect((await api().get(`/campaigns/${id}/audit`).set(auth(stranger.token))).status).toBe(403);
    expect((await api().get(`/campaigns/${id}/audit`)).status).toBe(401);
  });
});

describe('review decisions', () => {
  it('keeps the reviewer routes for reviewers', async () => {
    const { id } = await draftAndSubmit(ctx, owner.token);
    expect((await api().post(`/admin/campaigns/${id}/decision`).send({ action: 'approve' })).status).toBe(401);
    expect((await api().post(`/admin/campaigns/${id}/decision`).set(auth(owner.token)).send({ action: 'approve' })).status).toBe(403);
    expect((await api().get('/admin/campaigns').set(auth(stranger.token))).status).toBe(403);
  });

  it('approving opens the campaign for backing with a full audit trail', async () => {
    const id = await publish(ctx, owner.token, admin.token);
    const detail = await api().get(`/campaigns/${id}`);
    expect(detail.body.status).toBe('funding');
    const audit = await api().get(`/campaigns/${id}/audit`).set(auth(admin.token));
    expect(audit.body.items.map((a: { toStatus: string }) => a.toStatus)).toEqual(['under_review', 'approved', 'funding']);
    expect((await api().get('/campaigns')).body.total).toBe(1);
    const notes = await ctx.db.select().from(schema.notifications).where(eq(schema.notifications.userId, owner.id));
    expect(notes.map(n => n.title)).toEqual(expect.arrayContaining(['Campaign approved', 'Open for backing']));
  });

  it('needs a note to request changes, then lets the owner fix and resubmit', async () => {
    const { id } = await draftAndSubmit(ctx, owner.token);
    const noNote = await api().post(`/admin/campaigns/${id}/decision`).set(auth(admin.token)).send({ action: 'request_changes' });
    expect(noNote.status).toBe(400);

    const asked = await api().post(`/admin/campaigns/${id}/decision`).set(auth(admin.token))
      .send({ action: 'request_changes', note: 'Please add a second source.' });
    expect(asked.body.status).toBe('changes_requested');

    const mine = await api().get(`/campaigns/${id}`).set(auth(owner.token));
    expect(mine.body.reviewFeedback).toBe('Please add a second source.');

    const fixed = await api().patch(`/campaigns/${id}`).set(auth(owner.token)).send({
      sources: [
        { title: 'One', url: 'https://example.org/1' },
        { title: 'Two', url: 'https://example.org/2' }
      ]
    });
    expect(fixed.status).toBe(200);
    const resubmitted = await api().post(`/campaigns/${id}/submit`).set(auth(owner.token)).send(confirmations);
    expect(resubmitted.body.status).toBe('under_review');
  });

  it('treats rejection as final', async () => {
    const { id } = await draftAndSubmit(ctx, owner.token);
    const rejected = await api().post(`/admin/campaigns/${id}/decision`).set(auth(admin.token))
      .send({ action: 'reject', note: 'Outside the community guidelines.' });
    expect(rejected.body.status).toBe('rejected');
    expect((await api().patch(`/campaigns/${id}`).set(auth(owner.token)).send({ title: 'Again' })).status).toBe(409);
    expect((await api().post(`/campaigns/${id}/submit`).set(auth(owner.token)).send(confirmations)).status).toBe(409);
  });

  it('cannot approve a campaign that was never submitted', async () => {
    const created = await api().post('/campaigns').set(auth(owner.token)).send(completeInput());
    const res = await api().post(`/admin/campaigns/${created.body.id}/decision`).set(auth(admin.token)).send({ action: 'approve' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('illegal_transition');
  });

  it('lets an owner cancel a draft', async () => {
    const created = await api().post('/campaigns').set(auth(owner.token)).send(completeInput());
    const res = await api().post(`/campaigns/${created.body.id}/cancel`).set(auth(owner.token));
    expect(res.body.status).toBe('cancelled');
    expect((await api().post(`/campaigns/${created.body.id}/cancel`).set(auth(stranger.token))).status).toBe(404);
  });
});

describe('the funding-to-promotion rules', () => {
  const setState = (id: string, values: Partial<typeof schema.campaigns.$inferInsert>) =>
    ctx.db.update(schema.campaigns).set(values).where(eq(schema.campaigns.id, id));
  const move = (id: string, body: Record<string, unknown>) =>
    api().post(`/admin/campaigns/${id}/transition`).set(auth(admin.token)).send(body);

  it('cannot go from funding straight to promoting', async () => {
    const id = await publish(ctx, owner.token, admin.token);
    const res = await move(id, { to: 'promoting' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('illegal_transition');
  });

  it('does not let a reviewer mark the goal as reached by hand', async () => {
    const id = await publish(ctx, owner.token, admin.token);
    expect((await move(id, { to: 'goal_reached' })).status).toBe(400);
  });

  it('funding complete does not launch ads: it needs preparation, payments and ad setup first', async () => {
    const id = await publish(ctx, owner.token, admin.token);
    await setState(id, { status: 'goal_reached', raisedAmountCents: 250_000 }); // what the payment system records

    expect((await move(id, { to: 'promoting' })).body.error.code).toBe('illegal_transition');
    expect((await move(id, { to: 'distribution_prep' })).body.status).toBe('distribution_prep');

    const noSetup = await move(id, { to: 'promoting' });
    expect(noSetup.status).toBe(409);
    expect(noSetup.body.error.code).toBe('conditions_not_met');

    expect((await move(id, { to: 'promoting', adSetupConfirmed: true })).body.status).toBe('promoting');
    expect((await move(id, { to: 'completed' })).body.status).toBe('completed');
    expect((await move(id, { to: 'failed' })).status).toBe(409); // completed is final
  });

  it('will not prepare distribution with no confirmed payments', async () => {
    const id = await publish(ctx, owner.token, admin.token);
    const res = await move(id, { to: 'distribution_prep' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conditions_not_met');
  });
});

describe('discovery', () => {
  beforeEach(async () => {
    const a = await publish(ctx, owner.token, admin.token, { title: 'Pollinators in public parks', category: 'Environment' });
    const b = await publish(ctx, owner.token, admin.token, { title: 'Teen sleep and screens', category: 'Health' });
    await publish(ctx, owner.token, admin.token, { title: 'Open data on river quality', category: 'Science' });
    await ctx.db.update(schema.campaigns).set({ raisedAmountCents: 90_000, backerCount: 12 }).where(eq(schema.campaigns.id, b));
    await ctx.db.update(schema.campaigns).set({ raisedAmountCents: 20_000, backerCount: 30 }).where(eq(schema.campaigns.id, a));
  });

  it('searches by text and filters by category', async () => {
    const found = await api().get('/campaigns').query({ q: 'pollinators' });
    expect(found.body.items.map((c: { title: string }) => c.title)).toEqual(['Pollinators in public parks']);
    const health = await api().get('/campaigns').query({ category: 'Health' });
    expect(health.body.total).toBe(1);
  });

  it('treats search characters literally', async () => {
    expect((await api().get('/campaigns').query({ q: '%' })).body.total).toBe(0);
  });

  it('sorts by funding and by backers', async () => {
    const funded = await api().get('/campaigns').query({ sort: 'mostFunded' });
    expect(funded.body.items[0].title).toBe('Teen sleep and screens');
    const trending = await api().get('/campaigns').query({ sort: 'trending' });
    expect(trending.body.items[0].title).toBe('Pollinators in public parks');
  });

  it('paginates and rejects an unknown sort', async () => {
    const page = await api().get('/campaigns').query({ limit: 2, offset: 2 });
    expect(page.body.total).toBe(3);
    expect(page.body.items).toHaveLength(1);
    expect((await api().get('/campaigns').query({ sort: 'cheapest' })).status).toBe(400);
  });

  it('returns cards with an estimated reach range, money in cents and no private fields', async () => {
    const res = await api().get('/campaigns');
    const card = res.body.items[0];
    expect(card.estimatedReachAtGoal.low).toBeLessThan(card.estimatedReachAtGoal.high);
    expect(Number.isInteger(card.funding.goalAmountCents)).toBe(true);
    expect(card).not.toHaveProperty('ownerId');
  });
});

describe('my campaigns', () => {
  it('lists only my campaigns, and drafts separately', async () => {
    await api().post('/campaigns').set(auth(owner.token)).send({ title: 'Mine' });
    await draftAndSubmit(ctx, owner.token, { title: 'Submitted' });
    await api().post('/campaigns').set(auth(stranger.token)).send({ title: 'Theirs' });
    const mine = await api().get('/me/campaigns').set(auth(owner.token));
    expect(mine.body.items).toHaveLength(2);
    const drafts = await api().get('/me/drafts').set(auth(owner.token));
    expect(drafts.body.items.map((c: { title: string }) => c.title)).toEqual(['Mine']);
    expect((await api().get('/me/campaigns')).status).toBe(401);
  });
});
