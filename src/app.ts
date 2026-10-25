import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { env, frontendOrigins, isTest } from './config/env.js';
import { logger } from './infrastructure/logger.js';
import { prisma } from './infrastructure/prisma.js';
import { requestId } from './http/middleware/request-id.js';
import {
  withAuth,
  withRegistrationAuth,
  withMfaAuth,
  csrfGuard,
} from './http/middleware/auth.js';
import {
  generalRateLimit,
  readinessRateLimit,
  writeRateLimit,
} from './http/middleware/rate-limit.js';
import { errorHandler, notFoundHandler } from './http/error-handler.js';
import { sendData } from './http/respond.js';
import { AppError } from './http/errors.js';
import { apiRouter } from './routes.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId ?? randomUUID(),
      autoLogging: {
        ignore: (req) => req.url === '/health' || req.url === '/ready',
      },
      customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return isTest ? 'silent' : 'info';
      },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || frontendOrigins.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(AppError.forbidden('Origin is not allowed'));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy'],
      maxAge: 600,
    }),
  );
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb', strict: true }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  app.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    sendData(res, {
      status: 'ok',
      service: 'picklequeue-api',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/ready', readinessRateLimit, async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await prisma.$runCommandRaw({ ping: 1 });
      const hello = (await prisma.$runCommandRaw({ hello: 1 })) as Record<string, unknown>;
      const replicaSet = typeof hello.setName === 'string' && hello.setName.length > 0;
      if (!replicaSet) throw new Error('MongoDB is not running as a replica set');
      sendData(res, {
        status: 'ready',
        checks: { database: 'up', replicaSet: true },
      });
    } catch (error) {
      logger.error({ err: error }, 'Readiness check failed');
      res.status(503).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Service is not ready',
          requestId: _req.requestId,
        },
      });
    }
  });

  app.use(generalRateLimit);
  app.use('/api/v1', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/v1', (req, res, next) => {
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (!unsafe) {
      next();
      return;
    }
    writeRateLimit(req, res, next);
  });
  app.use(withAuth);
  app.use(withRegistrationAuth);
  app.use(withMfaAuth);
  app.use(csrfGuard);
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
