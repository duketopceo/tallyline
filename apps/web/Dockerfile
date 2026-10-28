# syntax=docker/dockerfile:1
# tallyline web — Next.js App Router. The browser only ever talks to this
# service; it proxies the API server-side via API_INTERNAL_URL (service
# name inside the compose network) so the API port never needs exposing.

FROM node:22-alpine@sha256:ea11b74b986d520137cdef9a5346e447a00f275ecc4abc0055b7151226231e09 AS build
RUN corepack enable
WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/types/package.json packages/types/package.json
COPY packages/silver-lining/package.json packages/silver-lining/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @tallyline/web...

# NEXT_PUBLIC_* is inlined at build time — it is only a fallback for the
# server-side API_INTERNAL_URL, so the public API origin is correct here.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL

COPY packages/types packages/types
COPY packages/silver-lining packages/silver-lining
COPY apps/web apps/web
RUN pnpm --filter @tallyline/types build && pnpm --filter @tallyline/silver-lining build && pnpm --filter @tallyline/web build
RUN pnpm deploy --legacy --filter @tallyline/web --prod /out

FROM node:22-alpine@sha256:ea11b74b986d520137cdef9a5346e447a00f275ecc4abc0055b7151226231e09 AS run
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3100
CMD ["node_modules/.bin/next", "start", "-p", "3100"]
