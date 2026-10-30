// Demo assumptions. All money is integer cents. Reach is always an estimated range, never a promise.
export const PLATFORM_FEE_BPS = 500; // 5.00% of each contribution (basis points)
export const IMPRESSIONS_PER_DOLLAR = 22;
export const MIN_GOAL_CENTS = 10_000; // $100
export const MAX_GOAL_CENTS = 100_000_000; // $1,000,000

export function feeBreakdown(amountCents: number) {
  const feeCents = Math.round((amountCents * PLATFORM_FEE_BPS) / 10_000);
  return { feeCents, netAdCents: amountCents - feeCents };
}

export function estimateReach(netAdCents: number) {
  const mid = Math.round((netAdCents / 100) * IMPRESSIONS_PER_DOLLAR);
  return { low: Math.round(mid * 0.6), high: Math.round(mid * 1.4) };
}

export const percentFunded = (raisedCents: number, goalCents: number) =>
  goalCents > 0 ? Math.min(100, Math.floor((raisedCents * 100) / goalCents)) : 0;
