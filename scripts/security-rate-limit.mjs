/*
 * Lightweight rate-limit verification. This intentionally starts the built API
 * without a database and exercises only validation failures, so no data is read
 * or written. It is a security smoke check, not a substitute for a load test.
 */
import { createServer } from 'node:http';

Object.assign(process.env, {
  NODE_ENV: 'test',
  PORT: '4000',
  DATABASE_URL: 'mongodb://127.0.0.1:27017/picklequeue-rate-limit?directConnection=true',
  API_PUBLIC_URL: 'http://localhost:4000',
  FRONTEND_ORIGIN: 'http://localhost:3000',
  COOKIE_SECURE: 'false',
  EXPOSE_DEV_TOKENS: 'false',
  RATE_LIMIT_DISABLED: 'false',
  TRUST_PROXY: 'false',
  LOG_LEVEL: 'silent',
});

const { createApp } = await import('../dist/app.js');
const app = createApp();
const server = createServer(app);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await response.arrayBuffer();
  return response.status;
}

try {
  const authStatuses = [];
  for (let attempt = 1; attempt <= 21; attempt += 1) {
    authStatuses.push(await post('/api/v1/auth/register', {}));
  }
  if (authStatuses.slice(0, 20).some((status) => status !== 422)) {
    throw new Error(
      `Expected validation responses before the auth limit: ${authStatuses.join(',')}`,
    );
  }
  if (authStatuses[20] !== 429) {
    throw new Error(`Expected auth rate limit 429, received ${authStatuses[20]}`);
  }

  const generalStatuses = [];
  for (let attempt = 1; attempt <= 301; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/v1`);
    await response.arrayBuffer();
    generalStatuses.push(response.status);
  }
  if (!generalStatuses.includes(429)) {
    throw new Error('Expected the general API rate limit to return 429');
  }

  console.log(
    JSON.stringify({
      authRateLimit: {
        first: authStatuses[0],
        twentieth: authStatuses[19],
        twentyFirst: authStatuses[20],
      },
      generalRateLimit: {
        saw429: generalStatuses.includes(429),
        lastStatus: generalStatuses[generalStatuses.length - 1],
      },
    }),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}
