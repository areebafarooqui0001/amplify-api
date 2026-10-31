import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().optional(),
  DATABASE_SSL: z.enum(['true', 'false']).default('false'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(15 * 60),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
  CORS_ORIGIN: z.string().default('*'),
  RATE_LIMIT_ENABLED: z.enum(['true', 'false']).default('true'),
  // The payment provider is simulated. When true, a request may choose the outcome so every state can be demonstrated.
  ALLOW_SIMULATED_OUTCOMES: z.enum(['true', 'false']).default('true'),
  // Hosting helpers: apply migrations and create the reviewer plus demo campaigns when the server starts.
  RUN_MIGRATIONS: z.enum(['true', 'false']).default('false'),
  SEED_DEMO_ON_BOOT: z.enum(['true', 'false']).default('false'),
  SEED_ADMIN_EMAIL: z.string().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(10, 'SEED_ADMIN_PASSWORD must be at least 10 characters').optional()
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${problems}`);
  }
  return parsed.data;
}
