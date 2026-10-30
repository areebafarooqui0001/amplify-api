import { z } from 'zod';

export const PAYMENT_METHODS = ['Apple Pay', 'Google Pay', 'Credit Card'] as const;
export const MIN_CONTRIBUTION_CENTS = 500; // $5
export const MAX_CONTRIBUTION_CENTS = 500_000; // $5,000

export const createContribution = z.object({
  amountCents: z.number({ error: 'Amount must be a number' }).int('Amount must be a whole number of cents')
    .min(MIN_CONTRIBUTION_CENTS, 'The minimum contribution is $5')
    .max(MAX_CONTRIBUTION_CENTS, 'The maximum contribution is $5,000'),
  paymentMethod: z.enum(PAYMENT_METHODS),
  anonymous: z.boolean().default(true), // names are private by default
  backerName: z.string().trim().min(1).max(60).optional(),
  simulateOutcome: z.enum(['succeeded', 'pending', 'declined', 'failed']).optional()
});
export type CreateContribution = z.infer<typeof createContribution>;

export const accessTokenBody = z.object({ accessToken: z.string().min(10).max(100) });

export const idempotencyKey = z.string()
  .min(8, 'The Idempotency-Key must be at least 8 characters')
  .max(80)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'The Idempotency-Key may only use letters, numbers and _ . : -');
