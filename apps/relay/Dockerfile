FROM oven/bun:1.4.0 AS dependencies
WORKDIR /ace
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
# Relay requires no install-time native build. Skip daemon-only lifecycle hooks
# in this dependency stage; the relay does not import the workspace bridge.
RUN bun install --frozen-lockfile --production --ignore-scripts
FROM node:24-alpine
WORKDIR /ace
COPY --from=dependencies /ace /ace
USER node
EXPOSE 8787
CMD ["node", "apps/relay/src/cli.ts"]
