# 0193: Spade's app catalogue says what connects today, and shows each app's mark

Status: accepted. Date: 2026-11-19. Decided by: the owner (2026-11-19: "why don't we have app icons
in the app connector and why do we have so few apps"). Builds on [ADR 0131](0131-spade-connectors.md)
(connectors), [ADR 0137](0137-spade-public-connector-apps.md) (Spade's own apps),
[ADR 0140](0140-spade-cloud.md) and [ADR 0141](0141-ace-cloud.md) (the sign-in broker) and
[ADR 0171](0171-spade-decides-on-effects.md) (effects per tool).

## Context

The catalogue held 18 apps, none with a mark, and none of the apps people use every day (mail,
chat, calendars, files). Some entries offered Sign in that could only fail on a real build: the
four apps through Spade Cloud sign in only once the owner registers Spade with the maker and sets
the Worker's secrets, which hadn't happened, and nothing told the person.

## Decision

1. **More apps, each checked.** Every entry is a maker's own remote MCP server, checked against
   the maker's own documentation and the server's live sign-in metadata on its `checked` date
   (`spade/config/connectors.json`). No community, self-hosted or third-party proxy servers. The
   list grows from 18 to 85 apps; the method and the apps left out are in
   [connector-apps.md](../../spade/docs/connector-apps.md).
2. **A category per entry** (`mail_chat`, `meetings`, `work`, `files`, `sales_support`, `code`,
   `data`, `money`, `design`), so the list can be browsed by what an app is for.
3. **Whether it connects now, decided by Spade.** `GET /v1/connectors` gives each entry `ready`:
   `sign_in` (one click works on this build), `key` (only a token the person makes, with
   `key_url` where to make one), or `later` (it waits for the owner). An entry waits when it is
   marked `waits_for: "maker_approval"` (the maker lets in only apps it approved), or signs in
   through Spade Cloud and the cloud doesn't hold its client. The app never offers a Sign in that
   would fail: a `later` app says "Coming soon.", and someone with their own app at the maker can
   still use its client ID.
4. **The cloud says which apps it can sign in to.** `GET /v1/oauth/apps` on ace cloud is open
   (it names apps, never a client) and lists the apps whose client ID and secret are set. Spade
   asks at most every ten minutes (every minute while the cloud doesn't answer), waits at most
   three seconds, and treats no answer as "none". Setting an app's secrets with `wrangler` turns
   it on for every Spade without a release.
5. **Marks are bundled, never fetched.** Simple Icons (CC0) where it has the brand, else the
   maker's own mark from its site, turned into path data by `scripts/app-icons.ts` through the
   same pipeline as provider marks, one lazily loaded chunk per app, with each mark's source,
   licence and brand guidelines in `packages/ui-core/src/app-art/LICENCES.md`. A brand whose
   colour is black or near it draws in the text colour, so it reads in light, dark and under
   Suits. An app with no mark we may ship, and any server added by address, shows a neutral
   monogram on the same tile. Fetching a mark from the maker's host would tell it who looked.
6. **Effects for the new apps.** Sending mail or messages is `send_as_person` (Slack's message
   tools, Front, Google Calendar invitations, Resend, Klaviyo, Google Chat, ClickUp chat); banking
   and spend apps are `pay` for every tool (Mercury, Ramp), as payments apps already were;
   automation apps whose actions reach other apps (Zapier, Make) are at least `network`.

## Consequences

- 62 of the 85 apps sign in with one click today, 5 take a key, and 18 wait for the owner: the
  registrations and approvals listed in [connector-apps.md](../../spade/docs/connector-apps.md).
- 18 apps show a monogram until the owner adds their marks from each maker's brand kit.
- An entry's `ready` is checked from metadata and documentation, not a live sign-in per app; the
  first real sign-in to each remains the final check.

## Tests

- Catalogue (Rust): every entry has an https address and source, a checked day, and a category;
  only known fields; a token-only entry says where to make a key; `ready` for each combination of
  ways in, `waits_for` and the cloud's answer; the cloud is asked once across reads, and an
  unanswering cloud leaves its apps not ready.
- Worker: the apps endpoint lists only apps with both secrets and is rate limited; an app's own
  authorization parameters reach its sign-in address.
- Icons: every catalogue app has a licence row; every bundled mark belongs to an app and draws.
- App: Coming soon offers no Sign in; a key app shows its steps and opens its key page; search
  and categories; added and recent apps lead; marks draw from the bundle.
