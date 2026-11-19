FROM oven/bun:1.4.0 AS dependencies
WORKDIR /ace
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
# The gateway needs no install-time native build; skip daemon-only lifecycle hooks.
RUN bun install --frozen-lockfile --production --ignore-scripts
FROM node:24-alpine
WORKDIR /ace
COPY --from=dependencies /ace /ace
USER node
EXPOSE 8788
# Secrets come from the environment or a mounted key file only (ADR 0106 deploy checklist).
CMD ["node", "apps/push-gateway/src/cli.ts"]
