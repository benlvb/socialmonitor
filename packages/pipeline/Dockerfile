# socialmonitor worker — deployed on Railway (D21). Build context = repo root:
#   railway config sets dockerfilePath = packages/pipeline/Dockerfile
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/pipeline/package.json packages/pipeline/package.json
RUN pnpm install --frozen-lockfile --filter @socialmonitor/pipeline...

COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/pipeline packages/pipeline

WORKDIR /app/packages/pipeline
CMD ["pnpm", "start"]
