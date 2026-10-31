import { and, count, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { schema } from '../../db/client';
import { notFound } from '../../lib/errors';
import type { Status } from '../campaigns/lifecycle';

type NotificationType = (typeof schema.notificationType.enumValues)[number];
const { notifications, notificationPreferences, follows, campaigns } = schema;

export type Category = 'milestone' | 'promotion' | 'contribution' | 'status';
export const PREFERENCE_KEYS: Category[] = ['milestone', 'promotion', 'contribution', 'status'];

// Which notification types belong to which switch on the preferences screen.
const TYPES_BY_CATEGORY: Record<Category, NotificationType[]> = {
  milestone: ['milestone'],
  promotion: ['promotion'],
  contribution: ['contribution'],
  status: ['submission', 'system']
};

// Followers hear about key moments only, to avoid repetitive low-value notifications.
const FOLLOWER_STATUS: Partial<Record<Status, { type: NotificationType; title: string; body: (t: string) => string }>> = {
  goal_reached: { type: 'milestone', title: 'A campaign you follow reached its goal', body: t => `"${t}" is fully funded. Ads start after distribution setup.` },
  promoting: { type: 'promotion', title: 'A campaign you follow is now promoting', body: t => `"${t}" is now being shown to new audiences.` },
  completed: { type: 'promotion', title: 'A campaign you follow has finished', body: t => `"${t}" is complete and its final report is available.` }
};

const BY_STATUS: Partial<Record<Status, { type: NotificationType; title: string; body: (note?: string | null) => string }>> = {
  under_review: { type: 'submission', title: 'Submission received', body: () => 'Your campaign is in the review queue.' },
  approved: { type: 'submission', title: 'Campaign approved', body: () => 'A reviewer approved your campaign.' },
  changes_requested: { type: 'submission', title: 'Changes requested', body: n => n || 'A reviewer asked for changes.' },
  rejected: { type: 'submission', title: 'Campaign not approved', body: n => n || 'A reviewer could not approve this campaign.' },
  funding: { type: 'milestone', title: 'Open for backing', body: () => 'People can now contribute toward promoting your message.' },
  goal_reached: { type: 'milestone', title: 'Funding goal reached', body: () => 'Ads start only after distribution setup is complete.' },
  distribution_prep: { type: 'promotion', title: 'Preparing distribution', body: () => 'Ad setup is in progress.' },
  promoting: { type: 'promotion', title: 'Promotion has begun', body: () => 'Your message is now being shown to new audiences.' },
  completed: { type: 'promotion', title: 'Campaign completed', body: () => 'The final report is available.' }
};

// Tells a campaign's owner about a status change. Takes a transaction so it commits or rolls back with it.
export async function notifyStatusChange(ex: Db, userId: string, campaignId: string, to: Status, note?: string | null) {
  const entry = BY_STATUS[to];
  if (!entry) return;
  await ex.insert(notifications).values({
    userId,
    campaignId,
    type: entry.type,
    title: entry.title,
    message: entry.body(note)
  });

  const forFollowers = FOLLOWER_STATUS[to];
  if (forFollowers) {
    const [c] = await ex.select({ title: campaigns.title }).from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (c) await notifyFollowers(ex, campaignId, userId, forFollowers.type, forFollowers.title, forFollowers.body(c.title));
  }
}

// Sends one notification to everyone following a campaign, except its owner (who already gets their own).
export async function notifyFollowers(ex: Db, campaignId: string, ownerId: string, type: NotificationType, title: string, message: string) {
  const rows = await ex.select({ userId: follows.userId }).from(follows)
    .where(and(eq(follows.campaignId, campaignId), ne(follows.userId, ownerId)));
  if (rows.length === 0) return;
  await ex.insert(notifications).values(rows.map(r => ({ userId: r.userId, campaignId, type, title, message })));
}

export function createNotificationService(db: Db) {
  async function getPreferences(userId: string): Promise<Record<Category, boolean>> {
    const [row] = await db.select().from(notificationPreferences).where(eq(notificationPreferences.userId, userId)).limit(1);
    return { milestone: row?.milestone ?? true, promotion: row?.promotion ?? true, contribution: row?.contribution ?? true, status: row?.status ?? true };
  }

  const enabledTypes = (prefs: Record<Category, boolean>) =>
    PREFERENCE_KEYS.filter(k => prefs[k]).flatMap(k => TYPES_BY_CATEGORY[k]);

  return {
    getPreferences,

    async setPreferences(userId: string, patch: Partial<Record<Category, boolean>>) {
      const next = { ...(await getPreferences(userId)), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
      await db.insert(notificationPreferences).values({ userId, ...next })
        .onConflictDoUpdate({ target: notificationPreferences.userId, set: { ...next, updatedAt: new Date() } });
      return next as Record<Category, boolean>;
    },

    // A category that is switched off is hidden here and from the unread count. Switching it back on shows it again.
    async list(userId: string, q: { unread?: 'true' | 'false'; type?: NotificationType; limit: number; offset: number }) {
      const types = enabledTypes(await getPreferences(userId));
      if (types.length === 0) return { total: 0, unreadCount: 0, items: [] };
      const visible = and(eq(notifications.userId, userId), inArray(notifications.type, types))!;
      const conds = [visible];
      if (q.unread === 'true') conds.push(eq(notifications.read, false));
      if (q.type) conds.push(eq(notifications.type, q.type));
      const where = and(...conds);
      const [{ total }] = await db.select({ total: count() }).from(notifications).where(where);
      const [{ unread }] = await db.select({ unread: count() }).from(notifications).where(and(visible, eq(notifications.read, false)));
      const items = await db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(q.limit).offset(q.offset);
      return { total, unreadCount: unread, items };
    },

    async unreadCount(userId: string) {
      const types = enabledTypes(await getPreferences(userId));
      if (types.length === 0) return { unreadCount: 0 };
      const [{ unread }] = await db.select({ unread: count() }).from(notifications)
        .where(and(eq(notifications.userId, userId), inArray(notifications.type, types), eq(notifications.read, false)));
      return { unreadCount: unread };
    },

    async markRead(userId: string, id: string) {
      const uuidOk = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      if (!uuidOk) throw notFound('Notification');
      const [row] = await db.update(notifications).set({ read: true })
        .where(and(eq(notifications.id, id), eq(notifications.userId, userId))).returning();
      if (!row) throw notFound('Notification');
      return row;
    },

    async markAllRead(userId: string) {
      const rows = await db.update(notifications).set({ read: true })
        .where(and(eq(notifications.userId, userId), eq(notifications.read, false))).returning({ id: notifications.id });
      return { updated: rows.length };
    }
  };
}
