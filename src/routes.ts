import { Router, type Router as ExpressRouter } from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { authRouter } from './auth/routes.js';
import { clubsRouter } from './clubs/routes.js';
import { usersRouter } from './users/routes.js';
import { checkinsRouter, clubSessionsRouter, sessionsRouter } from './sessions/routes.js';
import { matchesRouter } from './matches/routes.js';
import { publicRouter } from './public/routes.js';
import { adminRouter } from './admin/routes.js';

export const apiRouter: ExpressRouter = Router();

apiRouter.get('/', (_req, res) => {
  res.json({
    data: {
      name: 'PickleQueue API',
      version: 'v1',
      docs: '/api/v1/openapi.yaml',
    },
  });
});

apiRouter.get('/openapi.yaml', (_req, res) => {
  try {
    const spec = readFileSync(resolve(process.cwd(), 'openapi.yaml'), 'utf8');
    res.type('application/yaml').set('Cache-Control', 'public, max-age=300').send(spec);
  } catch {
    res.status(404).json({
      error: {
        code: 'NOT_FOUND',
        message: 'OpenAPI document is not available in this deployment',
      },
    });
  }
});

apiRouter.use('/auth', authRouter);
apiRouter.use('/clubs', clubsRouter);
apiRouter.use('/clubs', clubSessionsRouter);
apiRouter.use('/sessions', sessionsRouter);
apiRouter.use('/matches', matchesRouter);
apiRouter.use('/checkins', checkinsRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/public', publicRouter);
apiRouter.use('/admin', adminRouter);
