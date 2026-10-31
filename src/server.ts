import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from './config';
import { createApp } from './app';
import { createDb, createPool } from './db/client';
import { seedDemo } from './db/seed-data';

async function main() {
  const config = loadConfig();
  const pool = createPool(config);

  // Free hosting tiers have no separate release step, so migrations can run when the server starts.
  if (config.RUN_MIGRATIONS === 'true') {
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
    console.log('Migrations applied.');
  }
  const db = createDb(pool);
  if (config.SEED_DEMO_ON_BOOT === 'true') {
    if (!config.SEED_ADMIN_EMAIL || !config.SEED_ADMIN_PASSWORD) {
      throw new Error('SEED_DEMO_ON_BOOT needs SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD.');
    }
    console.log('Seed:', await seedDemo(db, { adminEmail: config.SEED_ADMIN_EMAIL, adminPassword: config.SEED_ADMIN_PASSWORD, bcryptCost: config.BCRYPT_COST }));
  }

  const app = createApp(db, config);
  const server = app.listen(config.PORT, () => {
    console.log(`Amplify API listening on port ${config.PORT} (${config.NODE_ENV})`);
  });

  // Finish in-flight requests and close the database pool on shutdown.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(async () => {
        await pool.end();
        process.exit(0);
      });
    });
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
