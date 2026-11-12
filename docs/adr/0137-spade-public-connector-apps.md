# 0137: Spade may ship public client IDs for connectors, never secrets

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12: "let's not ship client key
[secret], let's make those apps support"). Amends [ADR 0131](0131-spade-connectors.md), decisions 1
and 2 (which client Spade signs in as), and [ADR 0136](0136-spade-client-id-metadata-document.md),
decision 2 (the order of clients).

## Context

Asana, Box, Canva, GitHub and HubSpot offer neither dynamic client registration nor client ID
metadata documents, so under ADR 0131 and ADR 0136 each needs the person's own client ID before
Spade can sign in. Spade could register its own app with each maker and ship its client ID. A
client secret can't ship: every copy of Spade would carry it, so it would be public.

What each maker allows was read from its own documentation and its live authorization-server
metadata on 2026-11-12 ([spade/docs/connector-apps.md](../../spade/docs/connector-apps.md)).

## Options considered

- **Ship a client ID and secret per app.** One click everywhere, but the secret is published with
  every download, and anyone could act as Spade. Refused by the owner.
- **A hosted service that holds the secrets and does the token exchange.** Against ADR 0002 and
  ADR 0123: ace is never hosted and holds no provider credentials.
- **Chosen:** ship public client IDs only, used where the maker lets a public client sign in: the
  authorization code grant with PKCE and no secret, or the device authorization grant (RFC 8628).
  Every other app keeps the person's own client ID.

## Decision

1. **Public client IDs may ship; secrets never.** `spade/config/connector-apps.json` lists Spade's
   own registered apps: the catalogue entry, the issuer the ID was registered with, the client ID
   (empty until the owner registers it), the grant (`device` or `browser`), optional scopes, and
   the maker's page that says the grant needs no secret. The file is refused whole if anything in
   it is, or is named like, a secret. A connect request offering a client secret for Spade's own
   app is refused. A sign-in with a shipped ID sends no secret and keeps none.

2. **Where it is used.** An app is tied to its catalogue entry and issuer: it is used only when the
   person connects that catalogue entry, at the entry's own address, and the authorization server
   that MCP server names gives the app's issuer in its metadata. A server added by URL never signs
   in as Spade, even one naming the same issuer: otherwise any server could name GitHub's issuer,
   have the person approve Spade on GitHub, and then receive the GitHub token as its bearer. Each
   connector's tokens are kept under its own id and sent only to its own address, with no
   redirects followed, so they are never reused by another connector. The order becomes: a client
   ID the person gives now; one the person gave earlier for this issuer; Spade's own app for the
   catalogue entry; Spade's client ID metadata document
   (ADR 0136); a client Spade registered; dynamic registration; else the person is asked for a
   client ID. A catalogue entry whose app has a client ID leads with Sign in; the person's own
   client ID is still offered.

3. **Browser apps.** The authorization code grant with PKCE S256, `state`, `resource` and the RFC
   9207 issuer check, back to `http://127.0.0.1:<Spade's port>/v1/connectors/callback/<catalogue
entry>`, which the owner registers without a port (RFC 8252 section 7.3). No maker in the
   catalogue needs exact ports today, so Spade binds no fixed ones.

4. **Device apps.** Spade asks the server's `device_authorization_endpoint` for a code (with
   `client_id`, `scope` and `resource`), shows the code and the maker's page in the connector's
   row in one sentence with Copy code and Open, and polls the token endpoint at the server's
   interval, five seconds slower after each `slow_down`. `authorization_pending` waits;
   `expired_token`, `access_denied`, any other error, or the code's lifetime passing ends it and
   the row says why, with Try again. The page shown is held to the same address rules as every
   sign-in address. The device code is never shown or stored. A device sign-in needs no PKCE: no
   code passes through the browser. The tokens are kept as any sign-in's (keychain only), so the
   per-bot allow lists, deferred and gated tools, and untrusted output of ADR 0131 apply
   unchanged. Disconnecting stops the polling.

5. **Per app, on 2026-11-12:**

   | App     | Outcome                                       | Deciding source                                                                                                                       |
   | ------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
   | GitHub  | Device flow with Spade's own OAuth app        | "The `client_secret` is not needed for the device flow" (docs.github.com, authorizing OAuth apps); metadata lists the device endpoint |
   | Asana   | Person's own client ID and secret (unchanged) | `client_secret` "(required)" (developers.asana.com/docs/oauth); metadata: secret methods only                                         |
   | Box     | Person's own client ID and secret (unchanged) | MCP credentials are a client ID and secret from the Admin Console; metadata: secret methods only                                      |
   | Canva   | Person's own client ID and secret (unchanged) | Token requests "must be authenticated" from a backend (canva.dev, Connect authentication)                                             |
   | HubSpot | Person's own client ID and secret (unchanged) | Metadata: `client_secret_post` only; MCP connectors use a client ID and secret                                                        |

## Consequences

- Once the owner registers Spade's GitHub OAuth app and commits its client ID, GitHub signs in
  with a code instead of a token or the person's own app. Until then nothing changes.
- GitHub limits code entries to 50 an hour per app; every Spade shares that limit. Organisations
  that restrict OAuth apps must approve Spade's.
- Asana, Box, Canva and HubSpot still need the person's own client ID and secret, and their
  catalogue notes say it is because the maker requires a secret.
- `resource` is sent with GitHub's device and token requests, as the MCP spec asks; GitHub's docs
  don't list it, so the first real sign-in confirms GitHub accepts it.

## Tests

- A fake authorization server with a hand-registered public client: Spade signs in with the
  shipped ID, PKCE and the exact loopback callback on its own port, renews, and never sends a
  secret.
- A device-flow fake: the code shows, `authorization_pending` waits, `slow_down` adds five seconds,
  approval connects; `expired_token` and `access_denied` end it without connecting and Try again
  starts anew; a code past its lifetime stops polling; disconnecting stops it.
- A server added by URL whose sign-in names the shipped app's issuer gets no device request and is
  asked for the person's own client ID.
- An apps file with a secret anywhere is refused; a connect request with a secret for the shipped
  app is refused before any request.
- A device-signed-in connector's tools reach only the bots allowed it.
- The catalogue leads with Sign in once a client ID ships.
- The app: the device row's sentence, Copy code and Open while waiting, and the expired and
  declined sentences with Try again.
