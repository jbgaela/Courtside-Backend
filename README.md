# PickleQueue API

Express 5 + TypeScript + Prisma 6.19 + MongoDB 7 API for PickleQueue.

This repository is **self-contained**. Domain packages that only the API needs
(`contracts`, `matchmaking`, `scoring`) are included under `packages/` and built
from this checkout. It does not require the Frontend repository or an umbrella
workspace to install, test, build or deploy.

## Requirements

- Node.js 22 LTS (minimum 20.9)
- pnpm 10.17 (`corepack enable`)
- Docker (for the development database and the disposable integration database)

## Quick start

```bash
git clone https://github.com/jbgaela/Courtside-Backend.git
cd Courtside-Backend
pnpm install
cp .env.example .env
pnpm db:up        # MongoDB 7 single-node replica set (compose.yaml)
pnpm db:push
pnpm db:seed
pnpm dev          # http://localhost:4000
```

The API reads `.env`. `pnpm db:up` starts `picklequeue-mongo` on
`127.0.0.1:27017` and initializes replica set `rs0`; transactions require it.

OpenAPI: `http://localhost:4000/api/v1/openapi.yaml` (source: `openapi.yaml`)

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test              # shared packages + API unit tests
pnpm test:integration  # disposable MongoDB container
pnpm build
pnpm format:check
```

Integration tests start a uniquely named disposable MongoDB replica-set
container, run against it, then remove that exact container. They never use the
development database.

## Layout

```text
src/                    Express app, services, routes, realtime gateway
prisma/                 Schema and deterministic demo seed
packages/contracts/     Validated wire types, enums, config schemas
packages/matchmaking/   Deterministic pure matchmaking engine + simulator
packages/scoring/       Pure rally-scoring state machine
test/unit/              Unit tests
test/integration/       Real app + disposable MongoDB
scripts/                Operational and test harness scripts
openapi.yaml            OpenAPI 3.1 contract
```

Shared packages are pnpm workspace members (see `pnpm-workspace.yaml`). Run
`pnpm build:packages` after editing them; `dev`, `build`, `typecheck`, `lint`
and `test` already do that automatically.

## Demo accounts

Password: `PickleQueue123!`

- `owner@picklequeue.dev` — owner / Queue Master
- `alex@picklequeue.dev` — player
- `zoe@picklequeue.dev` — player
- `jordan@picklequeue.dev` — Queue Master

Seed data is development/test only. See `.env.example` and the security
runbooks before any production deployment.

## Deployment

Install with dev dependencies, build, then run the compiled server:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`pnpm install` builds the vendored packages through `postinstall`; `pnpm build`
rebuilds them before `tsc`. Set the variables from `.env.example` in the hosting
environment and use a MongoDB replica set. Production must use
`EXPOSE_DEV_TOKENS=false`, `COOKIE_SECURE=true`, HTTPS origins and the
deployment-specific secrets required by the security runbook.

