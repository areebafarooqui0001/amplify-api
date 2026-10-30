import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { loadConfig } from '../config';
import { createPool } from './client';

async function main() {
  const pool = createPool(loadConfig());
  await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
  console.log('Migrations applied.');
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
