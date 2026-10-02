import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new HttpError(403, 'forbidden', message);
export const notFound = (entity = 'Resource') => new HttpError(404, 'not_found', `${entity} not found`);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'validation_error',
        message: 'Some fields are invalid',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  // Body-parser failures (oversized uploads, malformed JSON) are client errors.
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'too_large', message: 'That file is too large' } });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'bad_request', message: 'Malformed request body' } });
    return;
  }
  // Postgres unique violation
  if (err?.code === '23505') {
    res.status(409).json({ error: { code: 'conflict', message: uniqueMessage(err.constraint) } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
};

function uniqueMessage(constraint?: string) {
  if (constraint?.includes('email')) return 'That email is already in use';
  if (constraint?.includes('phone')) return 'That phone number is already in use';
  return 'A record with these details already exists';
}
