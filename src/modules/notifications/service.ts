import type { Db } from '../../db/client';
import { schema } from '../../db/client';
import type { Status } from '../campaigns/lifecycle';

type NotificationType = (typeof schema.notificationType.enumValues)[number];

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
  await ex.insert(schema.notifications).values({
    userId,
    campaignId,
    type: entry.type,
    title: entry.title,
    message: entry.body(note)
  });
}
