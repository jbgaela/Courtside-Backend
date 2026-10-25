import type { Request, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const id = incoming && incoming.length <= 100 ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
};

export function requestMetadata(req: Request): { ip?: string; userAgent?: string } {
  return {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  };
}
