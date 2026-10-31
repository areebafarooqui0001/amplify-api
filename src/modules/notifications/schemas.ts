import { z } from 'zod';

export const listNotifications = z.object({
  unread: z.enum(['true', 'false']).optional(),
  type: z.enum(['milestone', 'submission', 'contribution', 'promotion', 'system']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0)
});

export const preferencesInput = z.object({
  milestone: z.boolean().optional(),
  promotion: z.boolean().optional(),
  contribution: z.boolean().optional(),
  status: z.boolean().optional()
}).refine(v => Object.values(v).some(x => x !== undefined), { error: 'Send at least one preference to change' });
