export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, fields?: Record<string, string>) => new AppError(400, 'bad_request', msg, fields);
export const unauthorized = (msg = 'Please sign in to do this.') => new AppError(401, 'unauthenticated', msg);
export const forbidden = (msg = 'You are not allowed to do this.') => new AppError(403, 'forbidden', msg);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, msg: string) => new AppError(409, code, msg);
