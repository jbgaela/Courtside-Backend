import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Express 5 forwards rejected promises, but this keeps intent explicit for reviewers. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}
