import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config';
import { createDb, createPool, schema } from './client';

// Creates the reviewer account from environment variables. No passwords live in the code.
async function main() {
  const config = loadConfig();
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD first.');

  const pool = createPool(config);
  const db = createDb(pool);
  const [existing] = await db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase())).limit(1);
  if (existing) {
    console.log('Reviewer account already exists.');
  } else {
    await db.insert(schema.users).values({
      email: email.toLowerCase(),
      name: 'Reviewer',
      passwordHash: await bcrypt.hash(password, config.BCRYPT_COST),
      role: 'admin'
    });
    console.log(`Created reviewer account ${email}`);
  }
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
