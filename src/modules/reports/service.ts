import { desc, eq, and, isNotNull, count, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { schema, type Db } from '../../db/client';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { estimateReach } from '../../lib/pricing';
import { parseId } from '../campaigns/service';

const { campaigns, contributions, deliveryReports, notifications } = schema;
type PaymentStatus = (typeof schema.paymentStatus.enumValues)[number];

const STATUSES: PaymentStatus[] = ['succeeded', 'pending', 'declined', 'failed', 'cancelled', 'refunded'];

export function createReportService(db: Db) {
  const sumOf = (col: AnyPgColumn) => sql<number>`coalesce(sum(${col}), 0)::int`;

  async function allocatedCents(campaignId: string) {
    const [row] = await db.select({ net: sumOf(contributions.netAdCents) }).from(contributions)
      .where(and(eq(contributions.campaignId, campaignId), eq(contributions.status, 'succeeded')));
    return row.net;
  }

  return {
    // Funds, estimates and measured delivery are reported separately and never blended.
    async report(idRaw: string, viewer: { id: string; role: 'user' | 'admin' }) {
      const [c] = await db.select().from(campaigns).where(eq(campaigns.id, parseId(idRaw))).limit(1);
      if (!c || (viewer.role !== 'admin' && viewer.id !== c.ownerId)) throw notFound('Campaign');

      const byStatus = await db.select({
        status: contributions.status,
        n: count(),
        amount: sumOf(contributions.amountCents),
        fee: sumOf(contributions.feeCents),
        net: sumOf(contributions.netAdCents)
      }).from(contributions).where(eq(contributions.campaignId, c.id)).groupBy(contributions.status);

      const counts = Object.fromEntries(STATUSES.map(s => [s, byStatus.find(r => r.status === s)?.n ?? 0]));
      const paid = byStatus.find(r => r.status === 'succeeded');
      const allocated = paid?.net ?? 0;

      const [d] = await db.select({
        reports: count(),
        impressions: sql<number>`coalesce(sum(${deliveryReports.impressions}), 0)::int`,
        clicks: sql<number>`coalesce(sum(${deliveryReports.clicks}), 0)::int`,
        spend: sql<number>`coalesce(sum(${deliveryReports.spendCents}), 0)::int`
      }).from(deliveryReports).where(eq(deliveryReports.campaignId, c.id));
      const [latestReach] = await db.select({ reach: deliveryReports.reach }).from(deliveryReports)
        .where(and(eq(deliveryReports.campaignId, c.id), isNotNull(deliveryReports.reach)))
        .orderBy(desc(deliveryReports.createdAt)).limit(1);

      const delivered = d.reports > 0;
      return {
        campaignId: c.id,
        title: c.title,
        status: c.status,
        funds: {
          goalAmountCents: c.goalAmountCents,
          raisedAmountCents: c.raisedAmountCents,
          platformFeesCents: paid?.fee ?? 0,
          adBudgetAllocatedCents: allocated,
          contributions: counts
        },
        // An estimate from demo assumptions. Not a guarantee, and not measured.
        estimated: {
          reachWithFundsRaised: estimateReach(allocated),
          reachAtGoal: estimateReach(Math.round(c.goalAmountCents * 0.95)),
          basis: 'Assumed ad prices and frequency. Actual reach depends on inventory, targeting, delivery and performance.'
        },
        // Measured by the ad platform and recorded by a reviewer. Absent until ads have run.
        delivery: delivered
          ? {
              available: true,
              source: 'reviewer-recorded',
              reports: d.reports,
              impressions: d.impressions,
              clicks: d.clicks,
              clickThroughRate: d.impressions > 0 ? Math.round((d.clicks / d.impressions) * 10_000) / 10_000 : 0,
              adSpendCents: d.spend,
              adBudgetRemainingCents: allocated - d.spend,
              reachMeasured: latestReach?.reach ?? null
            }
          : { available: false, note: 'Delivery figures appear once ads have run and a reviewer records them.' },
        definitions: {
          impressions: 'Times the ad was shown. One person can see it more than once.',
          reach: 'Different people who saw the ad.',
          adSpend: 'Money actually spent on advertising, which is never more than the ad budget.',
          estimated: 'A forecast. It is never combined with measured figures.'
        }
      };
    },

    // Reviewer records measured delivery. Spend can never exceed the money raised for ads.
    async recordDelivery(adminId: string, idRaw: string, input: { impressions: number; clicks: number; spendCents: number; reach?: number }) {
      return db.transaction(async tx => {
        const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, parseId(idRaw))).for('update');
        if (!c) throw notFound('Campaign');
        if (c.status !== 'promoting' && c.status !== 'completed') {
          throw new AppError(409, 'not_delivering', 'Delivery can be recorded only while a campaign is promoting or completed.');
        }
        const [paid] = await tx.select({ net: sumOf(contributions.netAdCents) }).from(contributions)
          .where(and(eq(contributions.campaignId, c.id), eq(contributions.status, 'succeeded')));
        const [spent] = await tx.select({
          spend: sql<number>`coalesce(sum(${deliveryReports.spendCents}), 0)::int`,
          impressions: sql<number>`coalesce(sum(${deliveryReports.impressions}), 0)::int`,
          n: count()
        })
          .from(deliveryReports).where(eq(deliveryReports.campaignId, c.id));
        if (spent.spend + input.spendCents > paid.net) {
          throw new AppError(409, 'exceeds_budget', 'Recorded spend would exceed the advertising budget raised for this campaign.', {
            spendCents: `At most ${paid.net - spent.spend} cents remain`
          });
        }
        // Reach is a running total of different people, so it is checked against all impressions so far.
        if (input.reach !== undefined && input.reach > spent.impressions + input.impressions) {
          throw badRequest('Reach cannot exceed the total impressions recorded.', { reach: 'Reach cannot exceed total impressions' });
        }
        const [row] = await tx.insert(deliveryReports).values({ campaignId: c.id, recordedBy: adminId, ...input }).returning();
        if (spent.n === 0) {
          await tx.insert(notifications).values({
            userId: c.ownerId, campaignId: c.id, type: 'promotion',
            title: 'Delivery figures available', message: `The first delivery figures for "${c.title}" are now in your report.`
          });
        }
        return row;
      });
    }
  };
}
