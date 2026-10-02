FROM oven/bun:1.4.0 AS dependencies
WORKDIR /ace
COPY package.json bun.lock ./
COPY packages ./packages
COPY apps ./apps
COPY tools ./tools
RUN bun install --frozen-lockfile --production
FROM node:24-alpine
WORKDIR /ace
COPY --from=dependencies /ace /ace
USER node
EXPOSE 8787
CMD ["node", "apps/relay/src/cli.ts"]
