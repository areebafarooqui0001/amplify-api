import { loadConfig } from '../config';
import { createDb, createPool } from './client';
import { seedDemo } from './seed-data';

// Reads the reviewer login from environment variables. No passwords live in the code.
async function main() {
  const config = loadConfig();
  const adminEmail = process.env.SEED_ADMIN_EMAIL;
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD first.');

  const pool = createPool(config);
  const result = await seedDemo(createDb(pool), { adminEmail, adminPassword, bcryptCost: config.BCRYPT_COST });
  console.log(result);
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
