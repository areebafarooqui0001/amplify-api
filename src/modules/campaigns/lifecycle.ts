import { AppError, forbidden } from '../../lib/errors';
import type { schema } from '../../db/client';

export type Status = (typeof schema.campaignStatus.enumValues)[number];
export type Actor = { id: string | null; role: 'user' | 'admin' | 'system' };

// Legal transitions only. Funding completion does NOT launch ads:
// goal_reached must pass through distribution_prep before promoting.
export const TRANSITIONS: Record<Status, Status[]> = {
  draft: ['under_review', 'cancelled'],
  under_review: ['approved', 'changes_requested', 'rejected'],
  changes_requested: ['under_review', 'cancelled'],
  approved: ['funding'],
  funding: ['goal_reached', 'distribution_prep', 'refund_pending', 'cancelled'],
  goal_reached: ['distribution_prep', 'refund_pending'],
  distribution_prep: ['promoting', 'failed', 'refund_pending'],
  promoting: ['completed', 'failed'],
  completed: [],
  rejected: [],
  cancelled: [],
  refund_pending: ['cancelled', 'failed'],
  failed: ['refund_pending']
};

export const PUBLIC_STATUSES: Status[] = ['funding', 'goal_reached', 'distribution_prep', 'promoting', 'completed'];
export const EDITABLE_STATUSES: Status[] = ['draft', 'changes_requested'];

// What a campaign's owner may do themselves. Everything else needs a reviewer or the system.
const OWNER_ALLOWED: Array<[Status, Status]> = [
  ['draft', 'under_review'],
  ['changes_requested', 'under_review'],
  ['draft', 'cancelled'],
  ['changes_requested', 'cancelled']
];

type Subject = { status: Status; ownerId: string; raisedAmountCents: number; adSetupConfirmed: boolean };

export function checkTransition(c: Subject, to: Status, actor: Actor): void {
  if (!TRANSITIONS[c.status].includes(to)) {
    throw new AppError(409, 'illegal_transition', `A campaign cannot move from "${c.status}" to "${to}".`);
  }
  if (actor.role === 'user') {
    const allowed = OWNER_ALLOWED.some(([from, target]) => from === c.status && target === to);
    if (actor.id !== c.ownerId || !allowed) throw forbidden('You are not allowed to make this status change.');
  }
  // Reaching the goal is recorded by the payment system when funding completes, never by hand.
  if (to === 'goal_reached' && actor.role !== 'system') {
    throw forbidden('The funding goal is recorded automatically when it is reached.');
  }
  // Distribution may begin only when approval, payment and ad setup conditions are all met.
  if ((to === 'distribution_prep' || to === 'promoting') && c.raisedAmountCents <= 0) {
    throw new AppError(409, 'conditions_not_met', 'There are no confirmed payments to run ads with.');
  }
  if (to === 'promoting' && !c.adSetupConfirmed) {
    throw new AppError(409, 'conditions_not_met', 'Promotion cannot start until ad setup is confirmed.');
  }
}
