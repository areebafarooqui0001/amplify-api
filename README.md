# Amplify API

Backend for **Amplify**, a community-funded message amplification platform. Creators write campaigns, reviewers approve them, and backers pay for the ads that spread the message. A contribution pays for distribution. It is not a donation to the creator or the cause.

**Stack:** Node.js, Express 4, TypeScript, PostgreSQL, Drizzle ORM (SQL migrations), Zod, JWT, Vitest + Supertest.

## Status

| Stage | Scope | State |
|---|---|---|
| 1 | Project setup, schema and migrations, auth, error handling, tests | done |
| 2 | Campaigns, drafts, lifecycle rules, audit trail | next |
| 3 | Contributions and payments (cents, idempotency, settlement) | planned |
| 4 | Notifications, follows, reports, reviewer endpoints | planned |
| 5 | OpenAPI docs, Docker image, CI, deployment | planned |
| 6 | Connect the mobile app | planned |

## Run locally

```bash
cp .env.example .env          # then set JWT_SECRET
docker compose up -d          # PostgreSQL 16
npm install
npm run db:migrate
npm run db:seed               # creates the reviewer account from SEED_ADMIN_* variables
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

## Endpoints (stage 1)

| Method | Path | Purpose |
|---|---|---|
| GET | /health | liveness plus database check |
| POST | /auth/register | create an account, returns tokens |
| POST | /auth/login | sign in |
| POST | /auth/refresh | rotate the refresh token |
| POST | /auth/logout | revoke a refresh token |
| GET | /auth/me | current user (requires a token) |

## Data model

users, refresh_tokens, campaigns, story_blocks, sources, contributions, audit_log, notifications, follows. See `src/db/schema.ts`. Campaign statuses follow the lifecycle: draft, under_review, changes_requested, approved, funding, goal_reached, distribution_prep, promoting, completed, plus rejected, cancelled, refund_pending and failed.
