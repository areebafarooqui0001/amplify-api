import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '../../db/client';
import { AppError, badRequest, forbidden, notFound } from '../../lib/errors';
import { estimateReach, percentFunded } from '../../lib/pricing';
import { notifyStatusChange } from '../notifications/service';
import { checkTransition, EDITABLE_STATUSES, PUBLIC_STATUSES, type Actor, type Status } from './lifecycle';
import type { CampaignInput } from './schemas';
import { z } from 'zod';

const { campaigns, storyBlocks, sources, auditLog } = schema;
type CampaignRow = typeof campaigns.$inferSelect;

export type Viewer = { id: string; role: 'user' | 'admin' } | undefined;

const uuid = z.uuid();
// A malformed id is simply "not found", never a database error.
export function parseId(id: string): string {
  if (!uuid.safeParse(id).success) throw notFound('Campaign');
  return id;
}

const compact = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;

// ---------- Views ----------
function toView(c: CampaignRow, blocks: (typeof storyBlocks.$inferSelect)[], srcs: (typeof sources.$inferSelect)[], privileged: boolean) {
  const netAdCents = Math.round(c.goalAmountCents * 0.95);
  return {
    id: c.id,
    title: c.title,
    category: c.category,
    creatorName: c.creatorName,
    creatorOrg: c.creatorOrg,
    summary: c.summary,
    coverImage: c.coverImage,
    audienceActionAdvice: c.audienceActionAdvice,
    adCreative: { headline: c.adHeadline, description: c.adDescription, ctaText: c.adCtaText, imageUrl: c.adImage },
    targeting: { regions: c.regions, demographics: c.demographics, channels: c.channels, durationDays: c.durationDays },
    funding: {
      currency: 'USD',
      goalAmountCents: c.goalAmountCents,
      raisedAmountCents: c.raisedAmountCents,
      backerCount: c.backerCount,
      percentFunded: percentFunded(c.raisedAmountCents, c.goalAmountCents)
    },
    estimatedReachAtGoal: estimateReach(netAdCents), // an estimate range, never a promise
    status: c.status,
    story: blocks.map(b => compact({ id: b.id, type: b.type, content: b.content, caption: b.caption, credit: b.credit, statValue: b.statValue, statLabel: b.statLabel, imageUrl: b.imageUrl })),
    sources: srcs.map(s => ({ id: s.id, title: s.title, publication: s.publication, url: s.url })),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    // Private fields are shown only to the owner and reviewers.
    ...(privileged ? { ownerId: c.ownerId, reviewFeedback: c.reviewFeedback, adSetupConfirmed: c.adSetupConfirmed, submittedAt: c.submittedAt } : {})
  };
}

function toCard(c: CampaignRow) {
  return {
    id: c.id,
    title: c.title,
    category: c.category,
    creatorName: c.creatorName,
    summary: c.summary,
    coverImage: c.coverImage,
    status: c.status,
    funding: {
      goalAmountCents: c.goalAmountCents,
      raisedAmountCents: c.raisedAmountCents,
      backerCount: c.backerCount,
      percentFunded: percentFunded(c.raisedAmountCents, c.goalAmountCents)
    },
    estimatedReachAtGoal: estimateReach(Math.round(c.goalAmountCents * 0.95)),
    createdAt: c.createdAt
  };
}

// Maps API input to table columns. Only fields that were sent are included.
function toColumns(input: CampaignInput) {
  const cols: Partial<typeof campaigns.$inferInsert> = {};
  if (input.title !== undefined) cols.title = input.title;
  if (input.category !== undefined) cols.category = input.category;
  if (input.creatorName !== undefined) cols.creatorName = input.creatorName;
  if (input.creatorOrg !== undefined) cols.creatorOrg = input.creatorOrg;
  if (input.summary !== undefined) cols.summary = input.summary;
  if (input.coverImage !== undefined) cols.coverImage = input.coverImage;
  if (input.audienceActionAdvice !== undefined) cols.audienceActionAdvice = input.audienceActionAdvice;
  if (input.goalAmountCents !== undefined) cols.goalAmountCents = input.goalAmountCents;
  if (input.adCreative) {
    cols.adHeadline = input.adCreative.headline;
    cols.adDescription = input.adCreative.description;
    cols.adCtaText = input.adCreative.ctaText;
    cols.adImage = input.adCreative.imageUrl;
  }
  if (input.targeting) {
    cols.regions = input.targeting.regions;
    cols.demographics = input.targeting.demographics;
    cols.channels = input.targeting.channels;
    cols.durationDays = input.targeting.durationDays;
  }
  return cols;
}

async function replaceChildren(tx: Db, campaignId: string, input: CampaignInput) {
  if (input.story) {
    await tx.delete(storyBlocks).where(eq(storyBlocks.campaignId, campaignId));
    if (input.story.length) {
      await tx.insert(storyBlocks).values(input.story.map((b, position) => ({ campaignId, position, ...b })));
    }
  }
  if (input.sources) {
    await tx.delete(sources).where(eq(sources.campaignId, campaignId));
    if (input.sources.length) {
      await tx.insert(sources).values(input.sources.map((s, position) => ({ campaignId, position, ...s })));
    }
  }
}

export function createCampaignService(db: Db) {
  async function detail(ex: Db, c: CampaignRow, privileged: boolean) {
    const blocks = await ex.select().from(storyBlocks).where(eq(storyBlocks.campaignId, c.id)).orderBy(asc(storyBlocks.position));
    const srcs = await ex.select().from(sources).where(eq(sources.campaignId, c.id)).orderBy(asc(sources.position));
    return toView(c, blocks, srcs, privileged);
  }

  // The single place where status changes happen: validated, audited, and the owner is told.
  async function moveCampaign(tx: Db, c: CampaignRow, to: Status, actor: Actor, note?: string | null, adSetupConfirmed?: boolean) {
    const effective = { ...c, adSetupConfirmed: adSetupConfirmed ?? c.adSetupConfirmed };
    checkTransition(effective, to, actor);
    const [updated] = await tx.update(campaigns).set({
      status: to,
      updatedAt: new Date(),
      adSetupConfirmed: effective.adSetupConfirmed,
      ...(to === 'under_review' ? { submittedAt: new Date() } : {}),
      ...(to === 'changes_requested' || to === 'rejected' ? { reviewFeedback: note ?? null } : {})
    }).where(eq(campaigns.id, c.id)).returning();
    await tx.insert(auditLog).values({
      campaignId: c.id,
      actorId: actor.id,
      actorRole: actor.role,
      fromStatus: c.status,
      toStatus: to,
      note: note ?? null
    });
    await notifyStatusChange(tx, c.ownerId, c.id, to, note);
    return updated;
  }

  const lock = async (tx: Db, id: string) => {
    const [row] = await tx.select().from(campaigns).where(eq(campaigns.id, parseId(id))).for('update');
    return row;
  };

  return {
    moveCampaign,

    async createDraft(owner: { id: string; name: string }, input: CampaignInput) {
      return db.transaction(async tx => {
        const [row] = await tx.insert(campaigns).values({
          ownerId: owner.id,
          creatorName: owner.name,
          ...toColumns(input)
        }).returning();
        await replaceChildren(tx, row.id, input);
        return detail(tx, row, true);
      });
    },

    async updateDraft(userId: string, id: string, input: CampaignInput) {
      return db.transaction(async tx => {
        const c = await lock(tx, id);
        if (!c || c.ownerId !== userId) throw notFound('Campaign');
        if (!EDITABLE_STATUSES.includes(c.status)) {
          throw new AppError(409, 'not_editable', 'This campaign is in review or published. Material changes must go back through review.');
        }
        const [row] = await tx.update(campaigns).set({ ...toColumns(input), updatedAt: new Date() }).where(eq(campaigns.id, c.id)).returning();
        await replaceChildren(tx, c.id, input);
        return detail(tx, row, true);
      });
    },

    async submit(userId: string, id: string) {
      return db.transaction(async tx => {
        const c = await lock(tx, id);
        if (!c || c.ownerId !== userId) throw notFound('Campaign');
        if (!EDITABLE_STATUSES.includes(c.status)) {
          throw new AppError(409, 'illegal_transition', `A campaign cannot move from "${c.status}" to "under_review".`);
        }
        const [{ blockCount }] = await tx.select({ blockCount: count() }).from(storyBlocks).where(eq(storyBlocks.campaignId, c.id));
        const fields: Record<string, string> = {};
        if (!c.title.trim()) fields.title = 'Add a campaign title';
        if (!c.creatorName.trim()) fields.creatorName = 'Add a creator or organization name';
        if (c.summary.trim().length < 10) fields.summary = 'Add a short summary (at least 10 characters)';
        if (blockCount === 0) fields.story = 'Add at least one story section';
        if (c.goalAmountCents <= 0) fields.goalAmountCents = 'Set your funding goal (minimum $100)';
        if (c.regions.length === 0) fields['targeting.regions'] = 'Choose at least one region';
        if (c.channels.length === 0) fields['targeting.channels'] = 'Choose at least one channel';
        if (Object.keys(fields).length) throw badRequest('Complete the required fields before submitting.', fields);

        // The title doubles as the ad headline when no custom headline is set.
        if (!c.adHeadline) await tx.update(campaigns).set({ adHeadline: c.title.slice(0, 45) }).where(eq(campaigns.id, c.id));
        const moved = await moveCampaign(tx, c, 'under_review', { id: userId, role: 'user' }, 'Submitted for review');
        return detail(tx, moved, true);
      });
    },

    async cancel(userId: string, id: string) {
      return db.transaction(async tx => {
        const c = await lock(tx, id);
        if (!c || c.ownerId !== userId) throw notFound('Campaign');
        const moved = await moveCampaign(tx, c, 'cancelled', { id: userId, role: 'user' }, 'Cancelled by the creator');
        return detail(tx, moved, true);
      });
    },

    async listPublic(q: { q?: string; category?: string; status?: string; sort: string; limit: number; offset: number }) {
      const conds: SQL[] = [inArray(campaigns.status, q.status ? [q.status as Status] : PUBLIC_STATUSES)];
      if (q.category) conds.push(eq(campaigns.category, q.category as CampaignRow['category']));
      if (q.q) {
        const like = `%${q.q.replace(/[%_]/g, m => `\\${m}`)}%`;
        conds.push(or(ilike(campaigns.title, like), ilike(campaigns.summary, like), ilike(campaigns.creatorName, like))!);
      }
      const where = and(...conds);
      const order =
        q.sort === 'newest' ? desc(campaigns.createdAt)
        : q.sort === 'mostFunded' ? desc(campaigns.raisedAmountCents)
        : q.sort === 'closestToGoal' ? desc(sql`${campaigns.raisedAmountCents}::float / greatest(${campaigns.goalAmountCents}, 1)`)
        : desc(campaigns.backerCount);
      const [{ total }] = await db.select({ total: count() }).from(campaigns).where(where);
      const rows = await db.select().from(campaigns).where(where).orderBy(order, desc(campaigns.createdAt)).limit(q.limit).offset(q.offset);
      return { total, limit: q.limit, offset: q.offset, items: rows.map(toCard) };
    },

    // Drafts and campaigns in review are visible only to their owner and reviewers.
    async getDetail(id: string, viewer: Viewer) {
      const [c] = await db.select().from(campaigns).where(eq(campaigns.id, parseId(id))).limit(1);
      if (!c) throw notFound('Campaign');
      const privileged = !!viewer && (viewer.role === 'admin' || viewer.id === c.ownerId);
      if (!PUBLIC_STATUSES.includes(c.status) && !privileged) throw notFound('Campaign');
      return detail(db, c, privileged);
    },

    async listMine(userId: string, statuses?: Status[]) {
      const where = statuses ? and(eq(campaigns.ownerId, userId), inArray(campaigns.status, statuses)) : eq(campaigns.ownerId, userId);
      const rows = await db.select().from(campaigns).where(where).orderBy(desc(campaigns.updatedAt));
      return { items: rows.map(r => ({ ...toCard(r), reviewFeedback: r.reviewFeedback, updatedAt: r.updatedAt })) };
    },

    async listAll(status?: Status) {
      const rows = await db.select().from(campaigns).where(status ? eq(campaigns.status, status) : undefined).orderBy(desc(campaigns.updatedAt));
      return { items: rows.map(r => ({ ...toCard(r), ownerId: r.ownerId, reviewFeedback: r.reviewFeedback, updatedAt: r.updatedAt, submittedAt: r.submittedAt })) };
    },

    async audit(id: string, viewer: NonNullable<Viewer>) {
      const [c] = await db.select().from(campaigns).where(eq(campaigns.id, parseId(id))).limit(1);
      if (!c) throw notFound('Campaign');
      if (viewer.role !== 'admin' && viewer.id !== c.ownerId) throw forbidden('Only the creator or a reviewer can view the history.');
      const items = await db.select().from(auditLog).where(eq(auditLog.campaignId, c.id)).orderBy(asc(auditLog.createdAt));
      return { items };
    },

    // Reviewer decision. Approving can also open the campaign for backing (two audited steps).
    async decide(adminId: string, id: string, d: { action: 'approve' | 'request_changes' | 'reject'; note?: string; openForBacking: boolean }) {
      if (d.action !== 'approve' && (!d.note || d.note.length < 3)) {
        throw badRequest('Add a note so the creator knows what to change or why it was declined.', { note: 'A note is required' });
      }
      return db.transaction(async tx => {
        const c = await lock(tx, id);
        if (!c) throw notFound('Campaign');
        const actor: Actor = { id: adminId, role: 'admin' };
        let row: CampaignRow;
        if (d.action === 'approve') {
          row = await moveCampaign(tx, c, 'approved', actor, d.note);
          if (d.openForBacking) row = await moveCampaign(tx, row, 'funding', actor, 'Opened for backing');
        } else {
          row = await moveCampaign(tx, c, d.action === 'reject' ? 'rejected' : 'changes_requested', actor, d.note);
        }
        return detail(tx, row, true);
      });
    },

    async adminTransition(adminId: string, id: string, t: { to: Status; note?: string; adSetupConfirmed?: boolean }) {
      return db.transaction(async tx => {
        const c = await lock(tx, id);
        if (!c) throw notFound('Campaign');
        const moved = await moveCampaign(tx, c, t.to, { id: adminId, role: 'admin' }, t.note, t.adSetupConfirmed);
        return detail(tx, moved, true);
      });
    }
  };
}
