import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import { Pool } from 'pg';
import type { Config } from '../config';
import * as schema from './schema';

// Both the real Postgres driver and the in-memory test driver satisfy this type.
export type Db = PgDatabase<any, typeof schema>;
export { schema };

export function createPool(config: Config): Pool {
  if (!config.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and start the database.');
  }
  return new Pool({
    connectionString: config.DATABASE_URL,
    ssl: config.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    max: 10
  });
}

export const createDb = (pool: Pool): Db => drizzle(pool, { schema });
