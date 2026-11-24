# 0197: Apps that need the person's own client ID show how to make one

Status: accepted. Date: 2026-11-19. Decided by: the owner (2026-11-19: "we need all of the apps
people use to be integrated"). Builds on [ADR 0131](0131-spade-connectors.md) (connectors),
[ADR 0140](0140-spade-cloud.md) (Spade Cloud) and
[ADR 0193](0193-spade-catalogue-says-what-connects.md) (the catalogue says what connects).

## Context

Spade lists only makers' own remote MCP servers (ADR 0193) and runs no integration of its own for
any app. Some of those servers take only a client ID, and usually a secret, that someone registered
with the maker. Asana, Box, Canva and HubSpot are such apps: they sign in through Spade Cloud once
the owner registers Spade with each maker, and until then the only way in is the person's own
client. A server added by address can need the same. The connect dialog's "Use a client ID" showed
two empty fields and nothing about where the values come from, what redirect the maker wants, or
which scopes to tick, so in practice nobody could use it.

## Decision

1. **Setup steps, not a new way in.** An app that takes the person's own client ID can ship setup
   steps, shown on the dialog's "Use a client ID" path above the two fields. No new connect path,
   no new sign-in code: the person still types a client ID and secret, and Spade signs in exactly
   as before.
2. **A file of their own.** The steps live in `spade/config/connector-setups.json`, one entry per
   catalogue id: `where` and `where_label` (the maker's console), `steps` in order, `values` (which
   of `client_id` and `client_secret` the maker gives), `scopes` (what to tick; empty when the
   maker decides), `source` (the maker's page they were read from) and `notes`. It is separate
   from `connectors.json` so the catalogue and the steps change independently.
3. **The redirect is filled in by Spade.** Exactly one step is marked `redirect: true`: the one
   where the person pastes their callback. That address depends on Spade's port, so the file never
   holds it. `GET /v1/connectors` gives each catalogue entry with steps a `setup` object holding
   the file's fields and `redirect`, the connector's own loopback callback
   (`http://127.0.0.1:<port>/v1/connectors/callback/<id>`) as Spade is listening now. It is never
   the Spade Cloud callback: the person's app comes back to their own machine.
4. **Checked like the apps list.** The file is read with unknown fields refused. A setup for an id
   the catalogue doesn't list fails the build's tests, as an entry in `connector-apps.json` does;
   the shipped file is part of the build, so a bad one can't reach a person.
5. **Only what was read.** A setup is written from the maker's own documentation, with `source`
   naming the page. A console address the docs don't state is not guessed; the link then goes to
   the maker's page that says where it is.

## Consequences

- Asana, Box, Canva and HubSpot ship steps today. Microsoft 365, Salesforce and the other apps that
  take only a client ID get steps once their makers' setup pages are read end to end: an entry in
  the file, no code.
- Spade's port can change between starts, so the steps tell the person to allow any loopback port
  where the maker lets them; where it doesn't, they register the address again after a restart.
- A maker that moves its console breaks a link without breaking a sign-in; `checked` dates the file.

## Tests

- Rust: the shipped file reads; an unknown field is refused; a setup naming an app not in the
  catalogue is refused; a setup with no redirect step or two is refused; `GET /v1/connectors`
  answers `setup.redirect` with the daemon's own port, and an app without steps has no `setup`.
- App: choosing "Use a client ID" for an app with steps shows them, the console link, the redirect
  with its copy button and the scopes; an app without steps shows the two fields as before.
