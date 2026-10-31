import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

// One JSON line per request: easy to search in a hosting dashboard. Never logs headers, bodies or query strings.
export function requestLog(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  const id = incoming && /^[A-Za-z0-9_.-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('X-Request-Id', id);
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      id,
      method: req.method,
      path: req.originalUrl.split('?')[0], // no query string: it could carry search terms
      status: res.statusCode,
      ms: Math.round(ms * 10) / 10
    }));
  });
  next();
}
