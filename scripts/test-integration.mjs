import { startDisposableMongo, runCommand } from './test-db.mjs';

const DB_LABEL = process.env.PQ_TEST_LABEL ?? 'integration';
let mongo;

try {
  console.log(`[tests] Starting disposable MongoDB container (${DB_LABEL})...`);
  mongo = await startDisposableMongo({ label: DB_LABEL });
  console.log(`[tests] Container ${mongo.container} on port ${mongo.port}, db ${mongo.database}`);

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: mongo.url,
    SESSION_TTL_DAYS: '1',
    COOKIE_SECURE: 'false',
    EXPOSE_DEV_TOKENS: 'true',
    RATE_LIMIT_DISABLED: 'true',
    LOG_LEVEL: 'silent',
    TRUST_PROXY: 'false',
    FRONTEND_ORIGIN: 'http://localhost:3000',
    SOCKET_SESSION_CHECK_INTERVAL_MS: '1000',
    SOCKET_MAX_CONNECTIONS_PER_IP: '100',
  };

  const pushExit = runCommand('pnpm exec prisma db push --skip-generate', env);
  if (pushExit !== 0) process.exitCode = pushExit;
  else {
    process.exitCode = runCommand(
      'pnpm exec vitest run --config vitest.integration.config.ts',
      env,
    );
  }
} catch (error) {
  console.error('[tests] Harness failed:', error);
  process.exitCode = 1;
} finally {
  if (mongo) {
    console.log(`[tests] Removing container ${mongo.container}`);
    await mongo.stop();
    console.log('[tests] Container removed');
  }
}
