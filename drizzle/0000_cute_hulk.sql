CREATE TYPE "public"."campaign_status" AS ENUM('draft', 'under_review', 'changes_requested', 'approved', 'funding', 'goal_reached', 'distribution_prep', 'promoting', 'completed', 'rejected', 'cancelled', 'refund_pending', 'failed');--> statement-breakpoint
CREATE TYPE "public"."category" AS ENUM('Environment', 'Health', 'Science', 'Education', 'Public Policy', 'Economic Policy', 'Community', 'Arts & Culture', 'Business', 'Other');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('milestone', 'submission', 'contribution', 'promotion', 'system');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('Apple Pay', 'Google Pay', 'Credit Card');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'declined', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."story_block_type" AS ENUM('heading', 'paragraph', 'quote', 'stat', 'image');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_role" varchar(10) NOT NULL,
	"from_status" "campaign_status" NOT NULL,
	"to_status" "campaign_status" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" varchar(60) DEFAULT '' NOT NULL,
	"category" "category" DEFAULT 'Other' NOT NULL,
	"creator_name" varchar(80) DEFAULT '' NOT NULL,
	"creator_org" varchar(80),
	"summary" varchar(600) DEFAULT '' NOT NULL,
	"cover_image" text DEFAULT '' NOT NULL,
	"audience_action_advice" varchar(400) DEFAULT '' NOT NULL,
	"ad_headline" varchar(60) DEFAULT '' NOT NULL,
	"ad_description" varchar(200) DEFAULT '' NOT NULL,
	"ad_cta_text" varchar(30) DEFAULT 'Learn More' NOT NULL,
	"ad_image" text DEFAULT '' NOT NULL,
	"regions" text[] DEFAULT '{}'::text[] NOT NULL,
	"demographics" varchar(200) DEFAULT '' NOT NULL,
	"channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"duration_days" integer DEFAULT 14 NOT NULL,
	"goal_amount_cents" integer DEFAULT 0 NOT NULL,
	"raised_amount_cents" integer DEFAULT 0 NOT NULL,
	"backer_count" integer DEFAULT 0 NOT NULL,
	"status" "campaign_status" DEFAULT 'draft' NOT NULL,
	"review_feedback" text,
	"ad_setup_confirmed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"backer_id" uuid,
	"amount_cents" integer NOT NULL,
	"fee_cents" integer NOT NULL,
	"net_ad_cents" integer NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"anonymous" boolean DEFAULT true NOT NULL,
	"backer_name" varchar(60),
	"receipt_id" varchar(20) NOT NULL,
	"settle_token_hash" varchar(64) NOT NULL,
	"idempotency_key" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"user_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follows_user_id_campaign_id_pk" PRIMARY KEY("user_id","campaign_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "notification_type" NOT NULL,
	"title" varchar(120) NOT NULL,
	"message" text NOT NULL,
	"campaign_id" uuid,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" varchar(200) NOT NULL,
	"publication" varchar(200) DEFAULT '' NOT NULL,
	"url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "story_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" "story_block_type" NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"caption" varchar(300),
	"credit" varchar(120),
	"stat_value" varchar(40),
	"stat_label" varchar(160),
	"image_url" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"name" varchar(80) NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_backer_id_users_id_fk" FOREIGN KEY ("backer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follows" ADD CONSTRAINT "follows_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_blocks" ADD CONSTRAINT "story_blocks_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_campaign_idx" ON "audit_log" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "campaigns_owner_idx" ON "campaigns" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaigns_category_idx" ON "campaigns" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "contributions_receipt_unique" ON "contributions" USING btree ("receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contributions_idempotency_unique" ON "contributions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "contributions_campaign_idx" ON "contributions" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "contributions_backer_idx" ON "contributions" USING btree ("backer_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_unique" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sources_campaign_idx" ON "sources" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "story_blocks_position_unique" ON "story_blocks" USING btree ("campaign_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");