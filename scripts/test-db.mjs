import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

const IMAGE = 'mongo:7.0';
const CONTAINER_PREFIX = 'pq-test';
const REPL_SET = 'rs0';

let activeContainer = null;

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    stdio: options.quiet ? 'pipe' : 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `docker ${args.join(' ')} failed with exit ${result.status}\n${result.stderr ?? ''}`,
    );
  }
  return result;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(() => (port ? resolve(port) : reject(new Error('Could not allocate a port'))));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMongo(container, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = docker(
      ['exec', container, 'mongosh', '--quiet', '--eval', 'db.adminCommand({ ping: 1 }).ok'],
      { quiet: true, allowFailure: true },
    );
    if (result.status === 0 && result.stdout.includes('1')) return;
    await sleep(500);
  }
  throw new Error('MongoDB container did not become ready in time');
}

async function initiateReplicaSet(container) {
  docker([
    'exec',
    container,
    'mongosh',
    '--quiet',
    '--eval',
    `rs.initiate({ _id: "${REPL_SET}", members: [{ _id: 0, host: "127.0.0.1:27017" }] })`,
  ]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = docker(
      ['exec', container, 'mongosh', '--quiet', '--eval', 'db.hello().isWritablePrimary'],
      { quiet: true, allowFailure: true },
    );
    if (result.status === 0 && result.stdout.includes('true')) return;
    await sleep(400);
  }
  throw new Error('MongoDB replica set did not elect a primary');
}

export async function startDisposableMongo({ label = 'integration' } = {}) {
  docker(['info'], { quiet: true });
  const port = await freePort();
  const suffix = randomBytes(5).toString('hex');
  const container = `${CONTAINER_PREFIX}-${label}-${process.pid}-${suffix}`.toLowerCase();
  activeContainer = container;

  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    container,
    '--publish',
    `127.0.0.1:${port}:27017`,
    IMAGE,
    'mongod',
    '--replSet',
    REPL_SET,
    '--bind_ip_all',
    '--port',
    '27017',
  ]);

  await waitForMongo(container);
  await initiateReplicaSet(container);

  const database = `picklequeue_test_${suffix}`;
  const url = `mongodb://127.0.0.1:${port}/${database}?replicaSet=${REPL_SET}&directConnection=true`;
  return {
    container,
    port,
    database,
    url,
    async stop() {
      if (activeContainer === container) activeContainer = null;
      docker(['rm', '--force', container], { quiet: true, allowFailure: true });
    },
  };
}

function cleanupSync() {
  if (!activeContainer) return;
  const name = activeContainer;
  activeContainer = null;
  try {
    spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
  } catch {
    // Best effort only for a container this process created.
  }
}

process.once('SIGINT', () => {
  cleanupSync();
  process.exit(130);
});
process.once('SIGTERM', () => {
  cleanupSync();
  process.exit(143);
});

export function runCommand(command, env) {
  const result = spawnSync(command, {
    stdio: 'inherit',
    shell: true,
    env,
    cwd: process.cwd(),
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
