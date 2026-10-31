import { and, desc, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from '../../db/client';
import { notFound } from '../../lib/errors';
import { PUBLIC_STATUSES } from '../campaigns/lifecycle';
import { parseId, toCard } from '../campaigns/service';

const { campaigns, follows, bookmarks } = schema;

// Following sends updates. Saving (bookmarking) is a private reading list. Both are idempotent.
export function createEngagementService(db: Db) {
  // Only published campaigns can be followed or saved. Anything else looks like it does not exist.
  async function publishedCampaign(idRaw: string) {
    const [c] = await db.select().from(campaigns)
      .where(and(eq(campaigns.id, parseId(idRaw)), inArray(campaigns.status, PUBLIC_STATUSES))).limit(1);
    if (!c) throw notFound('Campaign');
    return c;
  }

  const list = async (table: typeof follows | typeof bookmarks, userId: string) => {
    const rows = await db.select({ c: campaigns }).from(table)
      .innerJoin(campaigns, eq(campaigns.id, table.campaignId))
      .where(and(eq(table.userId, userId), inArray(campaigns.status, PUBLIC_STATUSES)))
      .orderBy(desc(table.createdAt));
    return { items: rows.map(r => toCard(r.c)) };
  };

  return {
    async follow(userId: string, id: string) {
      const c = await publishedCampaign(id);
      await db.insert(follows).values({ userId, campaignId: c.id }).onConflictDoNothing();
      return { following: true };
    },
    async unfollow(userId: string, id: string) {
      await db.delete(follows).where(and(eq(follows.userId, userId), eq(follows.campaignId, parseId(id))));
      return { following: false };
    },
    async bookmark(userId: string, id: string) {
      const c = await publishedCampaign(id);
      await db.insert(bookmarks).values({ userId, campaignId: c.id }).onConflictDoNothing();
      return { bookmarked: true };
    },
    async unbookmark(userId: string, id: string) {
      await db.delete(bookmarks).where(and(eq(bookmarks.userId, userId), eq(bookmarks.campaignId, parseId(id))));
      return { bookmarked: false };
    },
    listFollowed: (userId: string) => list(follows, userId),
    listBookmarked: (userId: string) => list(bookmarks, userId),

    async viewerState(userId: string, campaignId: string) {
      const [f] = await db.select().from(follows).where(and(eq(follows.userId, userId), eq(follows.campaignId, campaignId))).limit(1);
      const [b] = await db.select().from(bookmarks).where(and(eq(bookmarks.userId, userId), eq(bookmarks.campaignId, campaignId))).limit(1);
      return { following: !!f, bookmarked: !!b };
    }
  };
}
