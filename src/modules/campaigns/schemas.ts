import { z } from 'zod';
import { MAX_GOAL_CENTS, MIN_GOAL_CENTS } from '../../lib/pricing';

export const CATEGORIES = [
  'Environment', 'Health', 'Science', 'Education', 'Public Policy',
  'Economic Policy', 'Community', 'Arts & Culture', 'Business', 'Other'
] as const;

// Only the channels the platform actually supports.
export const CHANNELS = ['Meta Ads (FB/IG)', 'Instagram Reels'] as const;

const httpUrl = z.string().max(2000).refine(v => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}, 'Enter a valid link starting with https://');

const storyBlock = z.object({
  type: z.enum(['heading', 'paragraph', 'quote', 'stat', 'image']),
  content: z.string().max(5000).default(''),
  caption: z.string().max(300).optional(),
  credit: z.string().max(120).optional(),
  statValue: z.string().max(40).optional(),
  statLabel: z.string().max(160).optional(),
  imageUrl: httpUrl.optional()
});

const source = z.object({
  title: z.string().trim().min(1, 'Add a source title').max(200),
  publication: z.string().max(200).default(''),
  url: httpUrl
});

// A draft may be incomplete, but whatever is sent must be valid.
export const campaignInput = z.object({
  title: z.string().trim().max(60, 'Title must be 60 characters or fewer').optional(),
  category: z.enum(CATEGORIES).optional(),
  creatorName: z.string().trim().max(80).optional(),
  creatorOrg: z.string().trim().max(80).optional(),
  summary: z.string().max(600).optional(),
  coverImage: httpUrl.or(z.literal('')).optional(),
  audienceActionAdvice: z.string().max(400).optional(),
  adCreative: z.object({
    headline: z.string().max(60),
    description: z.string().max(200),
    ctaText: z.string().max(30),
    imageUrl: httpUrl.or(z.literal(''))
  }).optional(),
  targeting: z.object({
    regions: z.array(z.string().trim().min(1).max(60)).max(20),
    demographics: z.string().max(200),
    channels: z.array(z.enum(CHANNELS)).max(CHANNELS.length),
    durationDays: z.number().int().min(7).max(90)
  }).optional(),
  // The creator sets this. It is never generated or defaulted.
  goalAmountCents: z.number().int().min(MIN_GOAL_CENTS, 'The minimum goal is $100').max(MAX_GOAL_CENTS).optional(),
  story: z.array(storyBlock).max(60).optional(),
  sources: z.array(source).max(30).optional()
});
export type CampaignInput = z.infer<typeof campaignInput>;

export const submitInput = z.object({
  agreedToTruthfulness: z.literal(true, { error: 'Confirm that your statements and sources are truthful' }),
  agreedToTerms: z.literal(true, { error: 'Confirm you understand that contributions pay for advertising' })
});

export const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.enum(CATEGORIES).optional(),
  status: z.enum(['funding', 'goal_reached', 'distribution_prep', 'promoting', 'completed']).optional(),
  sort: z.enum(['trending', 'newest', 'mostFunded', 'closestToGoal']).default('trending'),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0)
});

export const decisionInput = z.object({
  action: z.enum(['approve', 'request_changes', 'reject']),
  note: z.string().trim().max(1000).optional(),
  openForBacking: z.boolean().default(true)
});

export const transitionInput = z.object({
  to: z.enum(['funding', 'distribution_prep', 'promoting', 'completed', 'failed', 'refund_pending', 'cancelled']),
  note: z.string().trim().max(1000).optional(),
  adSetupConfirmed: z.boolean().optional()
});

export const statusFilter = z.object({
  status: z.enum([
    'draft', 'under_review', 'changes_requested', 'approved', 'funding', 'goal_reached',
    'distribution_prep', 'promoting', 'completed', 'rejected', 'cancelled', 'refund_pending', 'failed'
  ]).optional()
});
