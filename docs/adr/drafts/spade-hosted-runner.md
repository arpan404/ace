# Draft: a hosted always-on runner for Spade

Date: 2026-11-20. Status: **placeholder**. The founder said yes on 2026-11-20 to a hosted
always-on runner that ace operates, and asked for it to be planned later. Nothing here is
designed or decided yet. When it is designed it becomes a numbered ADR and an explicit new
exception to [ADR 0002](../0002-local-cli-providers.md), beside the push gateway
([ADR 0106](../0106-ios-remote-push-gateway.md)), the relay
([ADR 0110](../0110-cloudflare-relay.md)) and Spade Cloud's sign-in broker
([ADR 0140](../0140-spade-cloud.md)).

## Why

A bot on a laptop stops when the laptop sleeps. Routines catch up once on wake (ADR 0129), but a
job that should run overnight doesn't. Spade's main buyers want always-on bots without owning a
server. See [the product plan](../../product/spade-plan.md), M3.

## What it conflicts with, stated plainly

ADR 0002 says ace has no hosted mode, and never stores or proxies provider credentials. A runner
ace hosts would hold, on ace's machines, at least: the person's bots, their history and
workspaces, their connected apps' tokens and the keys of their endpoints. Coding-CLI
subscriptions can't run there: vendors' terms already forbid hosted use of their logins, so
hosted bots think only with endpoint keys or models ace provides.

## What the ADR must answer

- Where history, workspaces and tokens live; how they are encrypted and who can read them.
- Which brains run there (endpoint keys the person brings, models ace resells, never CLI logins).
- How the person's consent and grants carry (ADR 0187 says consent never crosses machines).
- Isolation between people's bots; the sandbox on shared hardware.
- How a bot moves between the person's machines and the runner, and back.
- What ace operates: regions, uptime, incident response, deletion, data export.
- The price, and how the runner fits the plan's paid tiers.
- Which clauses of ADR 0002 it amends, and which stay.
