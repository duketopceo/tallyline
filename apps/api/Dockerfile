# syntax=docker/dockerfile:1
# tallyline API — Hono + Drizzle + Postgres. Migrations run on boot, so
# `docker compose up` on a fresh volume lands at a ready database.

FROM node:22-alpine@sha256:ea11b74b986d520137cdef9a5346e447a00f275ecc4abc0055b7151226231e09 AS build
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/types/package.json packages/types/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/mcp-server/package.json apps/mcp-server/package.json
RUN pnpm install --frozen-lockfile --filter @tallyline/api...

# the API serves the remote MCP endpoint (/mcp) from the shared tool surface
COPY packages/types packages/types
COPY apps/mcp-server apps/mcp-server
COPY apps/api apps/api
RUN pnpm --filter @tallyline/types build && pnpm --filter @tallyline/mcp-server build && pnpm --filter @tallyline/api build
RUN pnpm deploy --legacy --filter @tallyline/api --prod /out

FROM node:22-alpine@sha256:ea11b74b986d520137cdef9a5346e447a00f275ecc4abc0055b7151226231e09 AS run
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
CMD ["node", "dist/index.js"]
