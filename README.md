# PickleQueue API

Express 5 + TypeScript + Prisma 6.19 + MongoDB 7 API for PickleQueue.

This repository is the **backend application** of the PickleQueue workspace. The
workspace root also contains shared packages (`contracts`, `matchmaking`,
`scoring`), end-to-end tests and documentation. Those shared packages are not
inside this repository; use the workspace root as the unit of checkout.

## Quick start

From the PickleQueue workspace root:

```bash
pnpm install
pnpm build:packages
pnpm db:up
pnpm db:push
pnpm db:seed
pnpm dev:api
```

API: `http://localhost:4000`  
OpenAPI: `http://localhost:4000/api/v1/openapi.yaml`

## Verification

```bash
pnpm --filter @picklequeue/api typecheck
pnpm --filter @picklequeue/api lint
pnpm --filter @picklequeue/api test
pnpm --filter @picklequeue/api test:integration
```

Integration tests start a uniquely named disposable MongoDB replica-set
container, run against it, then remove that exact container. They never use the
development database.

## Demo accounts

Password: `PickleQueue123!`

- `owner@picklequeue.dev` — owner / Queue Master
- `alex@picklequeue.dev` — player
- `zoe@picklequeue.dev` — player
- `jordan@picklequeue.dev` — Queue Master

## Documentation

The full architecture, ADRs, API contract, testing evidence, operations and
deployment runbooks live in the workspace root under `docs/`.
