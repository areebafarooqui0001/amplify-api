# Amplify API

Backend for **Amplify**, a community-funded message amplification platform. Creators write campaigns, reviewers approve them, and backers pay for the ads that spread the message. A contribution pays for distribution. It is not a donation to the creator or the cause.

**Stack:** Node.js, Express 4, TypeScript, PostgreSQL, Drizzle ORM (SQL migrations), Zod, JWT, Vitest + Supertest.

## Status

| Stage | Scope | State |
|---|---|---|
| 1 | Project setup, schema and migrations, auth, error handling, tests | done |
| 2 | Campaigns, drafts, lifecycle rules, audit trail, reviewer decisions | done |
| 3 | Contributions and payments: cents, idempotency, pending and confirm, refunds | done |
| 4 | Notifications API, follows, campaign reports | next |
| 5 | OpenAPI docs, Docker image, CI, deployment | planned |
| 6 | Connect the mobile app | planned |

## Run locally

```bash
cp .env.example .env          # then set JWT_SECRET
docker compose up -d          # PostgreSQL 16
npm install
npm run db:migrate
npm run db:seed               # reviewer account (from SEED_ADMIN_* variables) plus 5 demo campaigns
npm run dev
```

## Test

```bash
npm test          # runs against an in-memory PostgreSQL, no Docker needed
npm run typecheck
```

## Design decisions

- **Money is integer cents** in the database. Floats are never used for amounts.
- **Passwords** are hashed with bcrypt. Login takes about the same time whether or not the email exists, and the error message is identical, so emails cannot be enumerated.
- **Sessions:** short-lived access token (15 min) plus a single-use refresh token. Refresh tokens are stored only as SHA-256 hashes. Reusing an old refresh token is treated as theft and revokes all of that user's sessions.
- **Roles are read from the database on every request**, never trusted from the token, so a demotion takes effect immediately.
- **No secrets in code.** Configuration is validated at startup (the server refuses to start with a weak or missing `JWT_SECRET`). The reviewer account is created by a seed script from environment variables.
- **One error shape** everywhere: `{ "error": { "code", "message", "fields?" } }`.
- **The app is built from its dependencies** (`createApp(db, config)`), so tests run the real HTTP stack against a real PostgreSQL engine using the production migration files.

## Campaign lifecycle

```
draft -> under_review -> approved -> funding -> goal_reached -> distribution_prep -> promoting -> completed
              |                                      |
              +-> changes_requested -> under_review  +-> refund_pending / failed
              +-> rejected
draft / changes_requested -> cancelled
```

Rules enforced on the server (see `src/modules/campaigns/lifecycle.ts`):

- Only the transitions above are legal. Anything else returns `409 illegal_transition`.
- **Funding completion does not launch ads.** `goal_reached` must go through `distribution_prep`, and `promoting` needs confirmed payments and ad setup.
- `goal_reached` is recorded by the payment system, never set by hand.
- Owners can submit and cancel their own campaigns. Approvals, rejections and everything after funding need a reviewer.
- Drafts and campaigns in review are visible only to their owner and reviewers. Editing is locked outside `draft` and `changes_requested`, so material changes go back through review.
- The creator sets the funding goal. It has no default and is never generated.
- Every status change is written to an append-only audit log in the same database transaction, and the owner is notified.

## Payments

Contributions go through a `PaymentProvider` interface. The one included is a simulation (nothing is charged), so a real provider such as Stripe can replace it without touching the rules below. With `ALLOW_SIMULATED_OUTCOMES=true` a request can choose the outcome (`succeeded`, `pending`, `declined`, `failed`) so every state can be demonstrated.

- **Money is integer cents.** The 5% platform fee is computed in cents, and amounts must be whole cents between $5 and $5,000.
- **Retries are safe.** Send an `Idempotency-Key` header. The same key with the same request returns the original payment (`200`, `Idempotent-Replay: true`) instead of charging twice. The same key with a different request returns `422`. A unique database index backs this up when identical requests arrive at the same moment.
- **No double counting.** Each contribution to a campaign runs in a transaction that locks the campaign row. A pending payment counts toward funding only after `/confirm`, and never twice.
- **Guests can contribute.** On creation the payer receives an access token once. Only its SHA-256 hash is stored. The token confirms, cancels or shows the receipt of that payment. A wrong token looks the same as a payment that does not exist.
- **Goal reached closes funding, it does not launch ads.** The final payment moves the campaign to `goal_reached` (recorded as the system in the audit log). Further backing returns `409`.
- **Pending payments fail safely.** If the campaign closed before a pending payment was confirmed, it fails and the payer is not charged.
- **Refunds.** A reviewer moves a campaign to `refund_pending`, then calls the refunds endpoint. Every confirmed payment becomes `refunded`, funding resets to zero, backers are notified and the campaign is cancelled.
- **Privacy.** Names are anonymous by default. The backer list shows names only for people who chose to be public, and never amounts. Responses never include the payer id or token hash.

## Endpoints

| Method | Path | Who | Purpose |
|---|---|---|---|
| GET | /health | public | liveness plus database check |
| POST | /auth/register, /auth/login | public | create an account or sign in |
| POST | /auth/refresh, /auth/logout | public | rotate or revoke a refresh token |
| GET | /auth/me | signed in | current user |
| GET | /campaigns | public | published campaigns. Query: `q`, `category`, `status`, `sort`, `limit`, `offset` |
| GET | /campaigns/:id | public / owner / reviewer | full campaign. Unpublished ones are visible only to owner and reviewers |
| POST | /campaigns | signed in | create a draft |
| PATCH | /campaigns/:id | owner | edit while draft or changes_requested |
| POST | /campaigns/:id/submit | owner | validate every required field, then move to under_review |
| POST | /campaigns/:id/cancel | owner | cancel a draft |
| GET | /campaigns/:id/audit | owner / reviewer | status history |
| POST | /campaigns/:id/contributions | guest or signed in | contribute. Optional `Idempotency-Key` header |
| GET | /campaigns/:id/backers | public | backer count and public names |
| GET | /contributions/:id | payer (or `X-Access-Token`) | receipt |
| POST | /contributions/:id/confirm, /cancel | holder of the access token | settle or cancel a pending payment |
| GET | /me/campaigns, /me/drafts, /me/contributions | signed in | my campaigns and payment history |
| GET | /admin/campaigns | reviewer | all campaigns, optional `status` filter |
| POST | /admin/campaigns/:id/decision | reviewer | approve, request_changes or reject |
| POST | /admin/campaigns/:id/transition | reviewer | later lifecycle steps, with rule checks |
| POST | /admin/campaigns/:id/refunds | reviewer | refund all payments of a campaign in refund_pending |

Money is always integer cents. Reach is returned as an estimated `{ low, high }` range, never a single promise.

## Data model

users, refresh_tokens, campaigns, story_blocks, sources, contributions, audit_log, notifications, follows. See `src/db/schema.ts`. Campaign statuses follow the lifecycle: draft, under_review, changes_requested, approved, funding, goal_reached, distribution_prep, promoting, completed, plus rejected, cancelled, refund_pending and failed.
