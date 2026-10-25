import 'dotenv/config';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './infrastructure/logger.js';
import { prisma } from './infrastructure/prisma.js';
import { initRealtime } from './realtime/gateway.js';

async function main(): Promise<void> {
  const app = createApp();
  const server = createServer(app);
  // Bound slow clients and header abuse. Keep the keep-alive window compatible
  // with common reverse proxies; application requests are still short-lived.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 1_000;
  initRealtime(server);

  server.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV },
      `PickleQueue API listening on http://localhost:${env.PORT}`,
    );
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    shutdown('uncaughtException');
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Failed to start API');
  process.exit(1);
});
