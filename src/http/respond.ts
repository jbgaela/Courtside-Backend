import type { Response } from 'express';

export function sendData<T>(
  res: Response,
  data: T,
  status = 200,
  meta?: Record<string, unknown>,
): void {
  res.status(status).json(meta ? { data, meta } : { data });
}

export function sendNoContent(res: Response): void {
  res.status(204).end();
}
