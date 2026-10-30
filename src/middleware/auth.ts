import { eq } from 'drizzle-orm';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Config } from '../config';
import { schema, type Db } from '../db/client';
import { forbidden, unauthorized } from '../lib/errors';

export type AuthUser = { id: string; email: string; name: string; role: 'user' | 'admin' };

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signAccessToken(user: AuthUser, config: Config): string {
  return jwt.sign({ sub: user.id }, config.JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS
  });
}

// The role is re-read from the database on every request, never trusted from the token.
async function userFromRequest(req: Request, db: Db, config: Config): Promise<AuthUser | undefined> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  try {
    const payload = jwt.verify(header.slice(7), config.JWT_SECRET, { algorithms: ['HS256'] }) as { sub: string };
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, payload.sub)).limit(1);
    return row ? { id: row.id, email: row.email, name: row.name, role: row.role } : undefined;
  } catch {
    return undefined;
  }
}

export const optionalAuth = (db: Db, config: Config) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    req.user = await userFromRequest(req, db, config);
    next();
  } catch (err) {
    next(err);
  }
};

export const requireAuth = (db: Db, config: Config) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const user = await userFromRequest(req, db, config);
    if (!user) return next(unauthorized());
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
};

export const requireRole = (role: 'admin') => (req: Request, _res: Response, next: NextFunction) => {
  if (req.user?.role !== role) return next(forbidden('This action is restricted.'));
  next();
};
