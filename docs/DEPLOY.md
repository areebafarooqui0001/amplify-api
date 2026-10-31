# Deploying Amplify API (free tier)

This guide uses **Neon** for PostgreSQL and **Render** for the API. Both have free plans. Free plans change, so check their current terms before relying on them.

What to expect from the free plans (checked when this guide was written):

- A free Render web service **spins down after 15 minutes without traffic** and can take up to a minute to wake on the next request.
- A free **Render Postgres database expires after 30 days**, which is why this guide uses Neon for the database instead.
- A free **Neon database pauses after 5 minutes idle** and wakes on the next connection. Neon requires SSL.

## 1. Create the database (Neon)

1. Sign up at neon.com and create a project.
2. Copy the **direct** connection string (the hostname without `-pooler`). It looks like
   `postgresql://user:password@ep-something.region.aws.neon.tech/dbname?sslmode=require`
3. If the connection fails later with a `channel_binding` error, delete `&channel_binding=require` from the end of the string.

## 2. Create the web service (Render)

1. Push this repository to GitHub.
2. In Render: **New, Web Service**, connect the `amplify-api` repository.
3. **Language: Docker.** Render finds the `Dockerfile` by itself.
4. Instance type: **Free**.
5. **Health Check Path:** `/health`
6. Add these environment variables:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the Neon connection string from step 1 |
| `DATABASE_SSL` | `true` |
| `JWT_SECRET` | a long random string. Generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `RUN_MIGRATIONS` | `true` |
| `SEED_DEMO_ON_BOOT` | `true` (first deploy only, see step 4) |
| `SEED_ADMIN_EMAIL` | the reviewer email you want, for example `reviewer@yourname.dev` |
| `SEED_ADMIN_PASSWORD` | a strong password, at least 10 characters |
| `CORS_ORIGIN` | `*` for now. Later, the address of your app or website |
| `ALLOW_SIMULATED_OUTCOMES` | `true` (the payment provider is simulated, nothing is charged) |

Do not set `PORT`. Render provides it.

7. Click **Create Web Service** and wait for the deploy. In the logs you should see `Migrations applied.`, `Seed: { adminCreated: true, campaignsCreated: 5 }` and `Amplify API listening`.

## 3. Check it works

Replace the address with your own and run, from the project folder:

```bash
node scripts/smoke.mjs https://your-service.onrender.com
```

To include the reviewer sign-in check, set the same email and password first:

```powershell
$env:SEED_ADMIN_EMAIL="reviewer@yourname.dev"; $env:SEED_ADMIN_PASSWORD="your-password"
node scripts/smoke.mjs https://your-service.onrender.com
```

Then open `https://your-service.onrender.com/docs` for the interactive API documentation.

## 4. After the first deploy

Set `SEED_DEMO_ON_BOOT` to `false`. Seeding is safe to repeat (it creates nothing twice), but there is no reason to run it on every start. Keep `RUN_MIGRATIONS=true`: it only applies migrations that have not run yet.

## Why migrations run on boot

The server applies pending migrations when it starts. I could not confirm that Render's free plan supports a separate pre-deploy command, and boot-time migration works on every plan. On a paid plan you can move it to a pre-deploy step with `RUN_MIGRATIONS=false` and `npm run db:migrate`.

## Run the same image on your own machine

```bash
docker build -t amplify-api .
docker run --env-file .env -p 3000:3000 amplify-api
```

## Security checklist before showing it to anyone

- `JWT_SECRET` is long, random and set only in Render, never in the repository.
- The reviewer password is strong and is not written anywhere in the code.
- `ALLOW_SIMULATED_OUTCOMES` is only for the demo. A real payment integration should set it to `false`.
- `CORS_ORIGIN` lists your real app address once you have one.
