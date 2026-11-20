# Connector registrations

`registry.json` lists every OAuth app and MCP client approval Spade needs from a maker: the ace
cloud apps (whose secrets live in the Worker), Spade's public GitHub app, and the makers that must
approve Spade's client ID metadata document. Each entry records where to register, the exact
values to enter, and how far along it is. Change it when a registration moves on, then render.

## Commands

- `bun run docs:connectors` renders `spade/docs/connector-registrations.md` (committed) and, in
  `out/` (git-ignored), `runbook.html`, one outreach message per approval maker and Slack's app
  manifest.
- `bun run docs:connectors --check` fails, one line per problem, when the registry disagrees with
  `apps/cloud/src/broker/apps.ts` or `spade/config/connector-apps.json`, when
  `https://acehq.dev/privacy` or `/terms` would not reach the legal pages, or when the generated
  checklist is stale. `bun run check` runs it.
- `bun run docs:connectors slack --yes` creates Spade's Slack app from the manifest, with an app
  configuration token in `SLACK_CONFIG_TOKEN`, and prints the client ID, the `wrangler secret put`
  commands and the client secret once. It only runs in a terminal and writes nothing to disk.

## What is automated

Only Slack's app can be created by a command, through its `apps.manifest.create` API. No other
maker here offers an API for creating an OAuth app, and the approvals are requests to people, so
the browser part of every other registration is done by a person. The tool makes that part
mechanical: every value is generated from the code's own facts and is one copy away, and the
check catches a registration that drifts from what the code asks for.
