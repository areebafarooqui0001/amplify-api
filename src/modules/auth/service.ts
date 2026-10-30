import bcrypt from 'bcryptjs';
import { and, eq, isNull } from 'drizzle-orm';
import type { Config } from '../../config';
import { schema, type Db } from '../../db/client';
import { randomToken, sha256 } from '../../lib/crypto';
import { AppError, conflict, unauthorized } from '../../lib/errors';
import { signAccessToken, type AuthUser } from '../../middleware/auth';

const { users, refreshTokens } = schema;

// Compared against when the email does not exist, so response time does not reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 4);

const toAuthUser = (u: typeof users.$inferSelect): AuthUser => ({ id: u.id, email: u.email, name: u.name, role: u.role });

export function createAuthService(db: Db, config: Config) {
  async function issueSession(user: AuthUser) {
    const refreshToken = randomToken();
    await db.insert(refreshTokens).values({
      userId: user.id,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000)
    });
    return {
      user,
      accessToken: signAccessToken(user, config),
      refreshToken,
      expiresIn: config.ACCESS_TOKEN_TTL_SECONDS
    };
  }

  return {
    async register(input: { email: string; name: string; password: string }) {
      const email = input.email.toLowerCase();
      const passwordHash = await bcrypt.hash(input.password, config.BCRYPT_COST);
      try {
        const [row] = await db.insert(users).values({ email, name: input.name, passwordHash }).returning();
        return issueSession(toAuthUser(row));
      } catch (err) {
        if ((err as { code?: string; cause?: { code?: string } }).code === '23505' ||
            (err as { cause?: { code?: string } }).cause?.code === '23505') {
          throw conflict('email_taken', 'An account with this email already exists.');
        }
        throw err;
      }
    },

    async login(input: { email: string; password: string }) {
      const [row] = await db.select().from(users).where(eq(users.email, input.email.toLowerCase())).limit(1);
      const ok = await bcrypt.compare(input.password, row?.passwordHash ?? DUMMY_HASH);
      if (!row || !ok) throw unauthorized('Incorrect email or password.');
      return issueSession(toAuthUser(row));
    },

    // Rotation: every refresh token works once. Presenting a used one means it may have been stolen,
    // so every session for that user is revoked.
    async refresh(token: string) {
      const hash = sha256(token);
      const [stored] = await db.select().from(refreshTokens).where(eq(refreshTokens.tokenHash, hash)).limit(1);
      if (!stored) throw unauthorized('Invalid refresh token.');
      if (stored.revokedAt) {
        await db.update(refreshTokens).set({ revokedAt: new Date() })
          .where(and(eq(refreshTokens.userId, stored.userId), isNull(refreshTokens.revokedAt)));
        throw new AppError(401, 'token_reuse', 'This refresh token was already used. Please sign in again.');
      }
      if (stored.expiresAt < new Date()) throw unauthorized('Refresh token expired. Please sign in again.');
      await db.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, stored.id));
      const [user] = await db.select().from(users).where(eq(users.id, stored.userId)).limit(1);
      if (!user) throw unauthorized();
      return issueSession(toAuthUser(user));
    },

    async logout(token: string) {
      await db.update(refreshTokens).set({ revokedAt: new Date() })
        .where(and(eq(refreshTokens.tokenHash, sha256(token)), isNull(refreshTokens.revokedAt)));
    }
  };
}
