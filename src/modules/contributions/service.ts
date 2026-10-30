import { timingSafeEqual } from 'node:crypto';
import { and, count, desc, eq } from 'drizzle-orm';
import type { Config } from '../../config';
import { schema, type Db } from '../../db/client';
import { randomToken, sha256 } from '../../lib/crypto';
import { isUniqueViolation } from '../../lib/db-errors';
import { AppError, notFound } from '../../lib/errors';
import { estimateReach, feeBreakdown, percentFunded } from '../../lib/pricing';
import { parseId, createCampaignService } from '../campaigns/service';
import type { Actor } from '../campaigns/lifecycle';
import type { PaymentProvider } from '../payments/provider';
import type { CreateContribution } from './schemas';

const { campaigns, contributions, notifications } = schema;
type CampaignRow = typeof campaigns.$inferSelect;
type ContributionRow = typeof contributions.$inferSelect;

const SYSTEM: Actor = { id: null, role: 'system' };
const MILESTONES = [25, 50, 75];

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// What a payer sees. Internal fields (payer id, token hash) never leave the server.
export function contributionView(c: ContributionRow, extra: Record<string, unknown> = {}) {
  return {
    id: c.id,
    campaignId: c.campaignId,
    amountCents: c.amountCents,
    feeCents: c.feeCents,
    netAdCents: c.netAdCents,
    paymentMethod: c.paymentMethod,
    status: c.status,
    anonymous: c.anonymous,
    receiptId: c.receiptId,
    estimatedReach: estimateReach(c.netAdCents), // an estimate range, never a promise
    createdAt: c.createdAt,
    ...extra
  };
}

export type Payer = { id: string; name: string; role: 'user' | 'admin' } | undefined;

export function createContributionService(db: Db, config: Config, provider: PaymentProvider) {
  const campaignService = createCampaignService(db);

  async function lockCampaign(tx: Db, id: string) {
    const [row] = await tx.select().from(campaigns).where(eq(campaigns.id, id)).for('update');
    return row;
  }

  async function tell(tx: Db, userId: string | null | undefined, campaignId: string, title: string, message: string, type: 'contribution' | 'milestone' = 'contribution') {
    if (!userId) return;
    await tx.insert(notifications).values({ userId, campaignId, type, title, message });
  }

  // Counts a confirmed payment toward funding. Reaching the goal closes funding but does NOT start ads.
  async function applySuccess(tx: Db, campaign: CampaignRow, contribution: ContributionRow) {
    const before = percentFunded(campaign.raisedAmountCents, campaign.goalAmountCents);
    const [updated] = await tx.update(campaigns).set({
      raisedAmountCents: campaign.raisedAmountCents + contribution.amountCents,
      backerCount: campaign.backerCount + 1,
      updatedAt: new Date()
    }).where(eq(campaigns.id, campaign.id)).returning();
    const after = percentFunded(updated.raisedAmountCents, updated.goalAmountCents);

    await tell(tx, campaign.ownerId, campaign.id, 'New contribution', `A backer contributed $${(contribution.amountCents / 100).toFixed(2)} toward promoting "${campaign.title}".`);
    if (updated.raisedAmountCents >= updated.goalAmountCents) {
      await campaignService.moveCampaign(tx, updated, 'goal_reached', SYSTEM, 'Funding goal reached');
    } else {
      for (const m of MILESTONES) {
        if (before < m && after >= m) {
          await tell(tx, campaign.ownerId, campaign.id, `Funding milestone: ${m}%`, `"${campaign.title}" is ${m}% funded.`, 'milestone');
        }
      }
    }
  }

  const sameRequest = (existing: ContributionRow, campaignId: string, body: CreateContribution, payer: Payer) =>
    existing.campaignId === campaignId && existing.amountCents === body.amountCents &&
    existing.paymentMethod === body.paymentMethod && (existing.backerId ?? null) === (payer?.id ?? null);

  async function replay(key: string, campaignId: string, body: CreateContribution, payer: Payer) {
    const [existing] = await db.select().from(contributions).where(eq(contributions.idempotencyKey, key)).limit(1);
    if (!existing) return undefined;
    if (!sameRequest(existing, campaignId, body, payer)) {
      throw new AppError(422, 'idempotency_key_conflict', 'This Idempotency-Key was already used for a different request.');
    }
    return existing;
  }

  return {
    // Creates a contribution. Sending the same Idempotency-Key again returns the original instead of charging twice.
    async create(campaignIdRaw: string, body: CreateContribution, payer: Payer, key?: string) {
      const campaignId = parseId(campaignIdRaw);
      if (key) {
        const existing = await replay(key, campaignId, body, payer);
        if (existing) return { replayed: true as const, contribution: existing, accessToken: undefined };
      }

      const accessToken = randomToken(24);
      try {
        const result = await db.transaction(async tx => {
          const campaign = await lockCampaign(tx, campaignId); // serialises concurrent contributions to one campaign
          if (!campaign) throw notFound('Campaign');
          if (campaign.status !== 'funding') {
            throw new AppError(409, 'not_open_for_backing', 'This campaign is not open for backing.');
          }
          const { feeCents, netAdCents } = feeBreakdown(body.amountCents);
          const charge = await provider.charge({
            amountCents: body.amountCents,
            method: body.paymentMethod,
            outcomeHint: config.ALLOW_SIMULATED_OUTCOMES === 'true' ? body.simulateOutcome : undefined
          });
          const [row] = await tx.insert(contributions).values({
            campaignId,
            backerId: payer?.id ?? null,
            amountCents: body.amountCents,
            feeCents,
            netAdCents,
            paymentMethod: body.paymentMethod,
            status: charge.status,
            anonymous: body.anonymous,
            backerName: body.anonymous ? null : (body.backerName ?? payer?.name ?? 'Community supporter'),
            receiptId: `RCPT-${Math.floor(100000 + Math.random() * 900000)}`,
            settleTokenHash: sha256(accessToken),
            idempotencyKey: key ?? null
          }).returning();

          if (row.status === 'succeeded') await applySuccess(tx, campaign, row);
          const messages = {
            succeeded: 'Your contribution was received and counts toward funding.',
            pending: 'Your payment is pending and is not counted toward funding yet.',
            declined: 'Your payment was declined. You were not charged.',
            failed: 'Your payment failed. You were not charged.'
          } as const;
          await tell(tx, payer?.id, campaignId, `Payment ${row.status}`, messages[charge.status]);
          return row;
        });
        return { replayed: false as const, contribution: result, accessToken };
      } catch (err) {
        // Two identical requests raced: the loser finds the winner's row.
        if (key && isUniqueViolation(err)) {
          const existing = await replay(key, campaignId, body, payer);
          if (existing) return { replayed: true as const, contribution: existing, accessToken: undefined };
        }
        throw err;
      }
    },

    // A pending payment counts toward funding only once it is confirmed (a real provider would call a webhook).
    async confirm(id: string, accessToken: string) {
      return db.transaction(async tx => {
        const found = await this.findWithToken(tx, id, accessToken);
        const campaign = await lockCampaign(tx, found.campaignId);
        const [c] = await tx.select().from(contributions).where(eq(contributions.id, found.id)).for('update');
        if (c.status !== 'pending') throw new AppError(409, 'not_pending', 'This payment is not pending.');

        // Funding closed while the payment was pending: it is not applied and the payer is not charged.
        if (!campaign || campaign.status !== 'funding') {
          const [failed] = await tx.update(contributions).set({ status: 'failed' }).where(eq(contributions.id, c.id)).returning();
          await tell(tx, c.backerId, c.campaignId, 'Payment failed', 'The campaign closed before this payment was confirmed. You were not charged.');
          return { contribution: failed, message: 'The campaign closed before this payment was confirmed. You were not charged.' };
        }
        const result = await provider.confirm({ amountCents: c.amountCents });
        const [updated] = await tx.update(contributions).set({ status: result.status }).where(eq(contributions.id, c.id)).returning();
        if (updated.status === 'succeeded') await applySuccess(tx, campaign, updated);
        await tell(tx, c.backerId, c.campaignId, `Payment ${updated.status}`, updated.status === 'succeeded' ? 'Your payment is confirmed and now counts toward funding.' : 'Your payment failed. You were not charged.');
        return { contribution: updated, message: undefined };
      });
    },

    async cancel(id: string, accessToken: string) {
      return db.transaction(async tx => {
        const found = await this.findWithToken(tx, id, accessToken);
        const [c] = await tx.select().from(contributions).where(eq(contributions.id, found.id)).for('update');
        if (c.status !== 'pending') throw new AppError(409, 'not_pending', 'Only a pending payment can be cancelled.');
        const [updated] = await tx.update(contributions).set({ status: 'cancelled' }).where(eq(contributions.id, c.id)).returning();
        await tell(tx, c.backerId, c.campaignId, 'Payment cancelled', 'You cancelled this payment. You were not charged.');
        return updated;
      });
    },

    // Anyone holding the access token may act on a payment. A wrong token looks the same as a missing payment.
    async findWithToken(ex: Db, idRaw: string, accessToken: string) {
      const id = parseId(idRaw);
      const [c] = await ex.select().from(contributions).where(eq(contributions.id, id)).limit(1);
      if (!c || !safeEqual(c.settleTokenHash, sha256(accessToken))) throw notFound('Contribution');
      return c;
    },

    async receipt(idRaw: string, payer: Payer, accessToken?: string) {
      const id = parseId(idRaw);
      const [row] = await db.select({ c: contributions, title: campaigns.title }).from(contributions)
        .innerJoin(campaigns, eq(campaigns.id, contributions.campaignId)).where(eq(contributions.id, id)).limit(1);
      if (!row) throw notFound('Contribution');
      const byOwner = !!payer && (payer.role === 'admin' || payer.id === row.c.backerId);
      const byToken = !!accessToken && safeEqual(row.c.settleTokenHash, sha256(accessToken));
      if (!byOwner && !byToken) throw notFound('Contribution');
      return contributionView(row.c, { campaignTitle: row.title });
    },

    async listMine(userId: string) {
      const rows = await db.select({ c: contributions, title: campaigns.title }).from(contributions)
        .innerJoin(campaigns, eq(campaigns.id, contributions.campaignId))
        .where(eq(contributions.backerId, userId)).orderBy(desc(contributions.createdAt));
      return { items: rows.map(r => contributionView(r.c, { campaignTitle: r.title })) };
    },

    // Public backer information: names appear only for people who chose to be public. No amounts.
    async backers(campaignIdRaw: string) {
      const campaignId = parseId(campaignIdRaw);
      const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
      if (!campaign || !['funding', 'goal_reached', 'distribution_prep', 'promoting', 'completed'].includes(campaign.status)) {
        throw notFound('Campaign');
      }
      const paid = and(eq(contributions.campaignId, campaignId), eq(contributions.status, 'succeeded'));
      const [{ total }] = await db.select({ total: count() }).from(contributions).where(paid);
      const [{ anonymousCount }] = await db.select({ anonymousCount: count() }).from(contributions).where(and(paid, eq(contributions.anonymous, true)));
      const named = await db.select({ name: contributions.backerName }).from(contributions)
        .where(and(paid, eq(contributions.anonymous, false))).orderBy(desc(contributions.createdAt));
      return { totalBackers: total, anonymousBackers: anonymousCount, publicBackers: named.map(n => n.name).filter(Boolean) };
    },

    // Reviewer action once a campaign is in refund_pending: every confirmed payment is returned and the campaign is cancelled.
    async refundCampaign(adminId: string, campaignIdRaw: string) {
      return db.transaction(async tx => {
        const campaign = await lockCampaign(tx, parseId(campaignIdRaw));
        if (!campaign) throw notFound('Campaign');
        if (campaign.status !== 'refund_pending') {
          throw new AppError(409, 'not_refund_pending', 'Contributions can be refunded only while the campaign is in refund_pending.');
        }
        const refunded = await tx.update(contributions).set({ status: 'refunded' })
          .where(and(eq(contributions.campaignId, campaign.id), eq(contributions.status, 'succeeded'))).returning();
        const refundedCents = refunded.reduce((sum, c) => sum + c.amountCents, 0);
        await tx.update(campaigns).set({ raisedAmountCents: 0, backerCount: 0 }).where(eq(campaigns.id, campaign.id));
        for (const c of refunded) {
          await tell(tx, c.backerId, campaign.id, 'Contribution refunded', `Your $${(c.amountCents / 100).toFixed(2)} contribution to "${campaign.title}" was refunded.`);
        }
        await campaignService.moveCampaign(tx, { ...campaign, raisedAmountCents: 0 }, 'cancelled', { id: adminId, role: 'admin' }, 'All contributions refunded');
        return { refundedCount: refunded.length, refundedCents };
      });
    }
  };
}
