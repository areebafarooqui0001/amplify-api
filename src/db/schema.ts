import { sql } from 'drizzle-orm';
import {
  boolean, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar
} from 'drizzle-orm/pg-core';

// ---------- Enums ----------
export const userRole = pgEnum('user_role', ['user', 'admin']);

export const campaignStatus = pgEnum('campaign_status', [
  'draft', 'under_review', 'changes_requested', 'approved', 'funding', 'goal_reached',
  'distribution_prep', 'promoting', 'completed', 'rejected', 'cancelled', 'refund_pending', 'failed'
]);

export const category = pgEnum('category', [
  'Environment', 'Health', 'Science', 'Education', 'Public Policy',
  'Economic Policy', 'Community', 'Arts & Culture', 'Business', 'Other'
]);

export const storyBlockType = pgEnum('story_block_type', ['heading', 'paragraph', 'quote', 'stat', 'image']);
export const paymentMethod = pgEnum('payment_method', ['Apple Pay', 'Google Pay', 'Credit Card']);
export const paymentStatus = pgEnum('payment_status', ['pending', 'succeeded', 'declined', 'failed', 'cancelled', 'refunded']);
export const notificationType = pgEnum('notification_type', [
  'milestone', 'submission', 'contribution', 'promotion', 'system'
]);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// ---------- Users and sessions ----------
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 254 }).notNull(),
  name: varchar('name', { length: 80 }).notNull(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull().default('user'),
  createdAt: createdAt()
}, t => [uniqueIndex('users_email_unique').on(t.email)]);

// Refresh tokens are stored only as a SHA-256 hash. Each one is single use (rotation).
export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt()
}, t => [uniqueIndex('refresh_tokens_hash_unique').on(t.tokenHash), index('refresh_tokens_user_idx').on(t.userId)]);

// ---------- Campaigns ----------
// Money is stored as integer cents everywhere, never floats.
export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  title: varchar('title', { length: 60 }).notNull().default(''),
  category: category('category').notNull().default('Other'),
  creatorName: varchar('creator_name', { length: 80 }).notNull().default(''),
  creatorOrg: varchar('creator_org', { length: 80 }),
  summary: varchar('summary', { length: 600 }).notNull().default(''),
  coverImage: text('cover_image').notNull().default(''),
  audienceActionAdvice: varchar('audience_action_advice', { length: 400 }).notNull().default(''),
  adHeadline: varchar('ad_headline', { length: 60 }).notNull().default(''),
  adDescription: varchar('ad_description', { length: 200 }).notNull().default(''),
  adCtaText: varchar('ad_cta_text', { length: 30 }).notNull().default('Learn More'),
  adImage: text('ad_image').notNull().default(''),
  regions: text('regions').array().notNull().default(sql`'{}'::text[]`),
  demographics: varchar('demographics', { length: 200 }).notNull().default(''),
  channels: text('channels').array().notNull().default(sql`'{}'::text[]`),
  durationDays: integer('duration_days').notNull().default(14),
  goalAmountCents: integer('goal_amount_cents').notNull().default(0), // the creator sets this
  raisedAmountCents: integer('raised_amount_cents').notNull().default(0),
  backerCount: integer('backer_count').notNull().default(0),
  status: campaignStatus('status').notNull().default('draft'),
  reviewFeedback: text('review_feedback'),
  adSetupConfirmed: boolean('ad_setup_confirmed').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true })
}, t => [
  index('campaigns_owner_idx').on(t.ownerId),
  index('campaigns_status_idx').on(t.status),
  index('campaigns_category_idx').on(t.category)
]);

export const storyBlocks = pgTable('story_blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  type: storyBlockType('type').notNull(),
  content: text('content').notNull().default(''),
  caption: varchar('caption', { length: 300 }),
  credit: varchar('credit', { length: 120 }),
  statValue: varchar('stat_value', { length: 40 }),
  statLabel: varchar('stat_label', { length: 160 }),
  imageUrl: text('image_url')
}, t => [uniqueIndex('story_blocks_position_unique').on(t.campaignId, t.position)]);

export const sources = pgTable('sources', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  position: integer('position').notNull(),
  title: varchar('title', { length: 200 }).notNull(),
  publication: varchar('publication', { length: 200 }).notNull().default(''),
  url: text('url').notNull()
}, t => [index('sources_campaign_idx').on(t.campaignId)]);

// ---------- Money ----------
export const contributions = pgTable('contributions', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
  backerId: uuid('backer_id').references(() => users.id), // null for guest contributions
  amountCents: integer('amount_cents').notNull(),
  feeCents: integer('fee_cents').notNull(),
  netAdCents: integer('net_ad_cents').notNull(),
  paymentMethod: paymentMethod('payment_method').notNull(),
  status: paymentStatus('status').notNull().default('pending'),
  anonymous: boolean('anonymous').notNull().default(true), // private by default
  backerName: varchar('backer_name', { length: 60 }),
  receiptId: varchar('receipt_id', { length: 20 }).notNull(),
  // SHA-256 of the access token given to the payer once, used to confirm, cancel or view the receipt as a guest
  settleTokenHash: varchar('settle_token_hash', { length: 64 }).notNull(),
  idempotencyKey: varchar('idempotency_key', { length: 80 }),
  createdAt: createdAt()
}, t => [
  uniqueIndex('contributions_receipt_unique').on(t.receiptId),
  uniqueIndex('contributions_idempotency_unique').on(t.idempotencyKey),
  index('contributions_campaign_idx').on(t.campaignId),
  index('contributions_backer_idx').on(t.backerId)
]);

// ---------- Governance ----------
// Append-only history of every campaign status change.
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  actorId: uuid('actor_id').references(() => users.id), // null when the system acts
  actorRole: varchar('actor_role', { length: 10 }).notNull(),
  fromStatus: campaignStatus('from_status').notNull(),
  toStatus: campaignStatus('to_status').notNull(),
  note: text('note'),
  createdAt: createdAt()
}, t => [index('audit_campaign_idx').on(t.campaignId)]);

// ---------- Engagement ----------
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: notificationType('type').notNull(),
  title: varchar('title', { length: 120 }).notNull(),
  message: text('message').notNull(),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'cascade' }),
  read: boolean('read').notNull().default(false),
  createdAt: createdAt()
}, t => [index('notifications_user_idx').on(t.userId, t.read)]);

export const follows = pgTable('follows', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  createdAt: createdAt()
}, t => [primaryKey({ columns: [t.userId, t.campaignId] })]);

// ---------- Stage 4 ----------
// A person's choice of which notification categories to see. Missing row means everything is on.
export const notificationPreferences = pgTable('notification_preferences', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  milestone: boolean('milestone').notNull().default(true),
  promotion: boolean('promotion').notNull().default(true),
  contribution: boolean('contribution').notNull().default(true),
  status: boolean('status').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
});

// Saved campaigns (bookmarks). Following is separate: it sends updates.
export const bookmarks = pgTable('bookmarks', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  createdAt: createdAt()
}, t => [primaryKey({ columns: [t.userId, t.campaignId] })]);

// Measured advertising delivery, entered by a reviewer (in production this would come from the ad platform).
// Estimates are never stored here, so measured and estimated figures cannot be mixed.
export const deliveryReports = pgTable('delivery_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  impressions: integer('impressions').notNull(),
  clicks: integer('clicks').notNull(),
  spendCents: integer('spend_cents').notNull(),
  reach: integer('reach'), // cumulative unique people, when the platform provides it
  recordedBy: uuid('recorded_by').references(() => users.id),
  createdAt: createdAt()
}, t => [index('delivery_campaign_idx').on(t.campaignId)]);
