import { z } from 'zod';

export const deliveryInput = z.object({
  impressions: z.number().int().min(0).max(2_000_000_000),
  clicks: z.number().int().min(0),
  spendCents: z.number().int().min(0),
  reach: z.number().int().min(0).optional()
}).superRefine((v, ctx) => {
  if (v.clicks > v.impressions) ctx.addIssue({ code: 'custom', path: ['clicks'], message: 'Clicks cannot exceed impressions' });
});
