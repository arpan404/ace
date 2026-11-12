# 0140: Spade Cloud, a hosted backend for Spade, starting with app sign-in

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12). Amends
[ADR 0002](0002-local-cli-providers.md) with a third narrow hosted exception, beside
[ADR 0106](0106-ios-remote-push-gateway.md) and [ADR 0110](0110-cloudflare-relay.md), and
[ADR 0137](0137-spade-public-connector-apps.md), which refused a hosted service holding client
secrets. Builds on [ADR 0111](0111-account-machine-access.md) (account grants),
[ADR 0123](0123-spade-runs-as-its-own-service.md) (Spade's grant in the daemon) and
[ADR 0131](0131-spade-connectors.md) (connectors).

## Context

Asana, Box, Canva and HubSpot sign in only with a client secret (ADR 0137,
[connector-apps.md](../../spade/docs/connector-apps.md)). A secret can't ship inside Spade, so
today each person registers their own app with each maker before they can connect it. The only
way to give them one click is a server that keeps Spade's secrets and does the token exchange.

The owner, 2026-11-12:

- "we build another backend for spade itself. So later on we could have spade handle many things
  and later move spade to managed cloud too"
- domain: `cloud.acehq.dev`
- hosting: "maybe Railway or other"
- accounts: "ace login and spade login will be same"
- secrets: Spade never ships client secrets; tokens are stored locally (OS keychain), never in the
  cloud.

## Options considered

- **Keep "use your own client ID" only (ADR 0137).** No hosted service, but four common apps stay
  out of reach for most people.
- **Put the broker in the account Worker (ADR 0110).** One deployment, but it mixes Spade's
  growing needs into ace's account backend, and the Worker's runtime is a poor fit for a Rust
  service that should later run Spade itself.
- **Chosen:** a separate service, Spade Cloud, in Rust in Spade's workspace, behind ace's existing
  account sign-in, whose first job is the OAuth broker.

## Decision

1. **A separate service.** `spade/crates/spade-cloud`, binary `spade-cloud` (axum, rustls for
   outbound TLS), at `https://cloud.acehq.dev`. It ships as a provider-neutral container image
   (multi-stage, non-root, configured only through the environment, `/health`, structured logs,
   graceful shutdown); Railway is the first host. Its wire types and the token sealing live in
   `spade-cloud-wire`, which Spade and the service share.

2. **Same ace account.** A request carries the person's ace account credential: an ADR 0111
   `machine` grant for the machine Spade runs on, verified exactly as the relay verifies it
   (Ed25519 over the claims, keys from the account backend's `GET /v1/keys`, kind, lifetime,
   skew), against the same test vectors as `@ace/account-grant`. There is no Spade login. Spade
   gets the grant from its daemon through `POST <daemon>/spade/account-grant`, authorized by
   Spade's own durable grant (ADR 0123); the daemon mints it with the machine's ace session as it
   does for the relay. Each account is rate limited.

3. **The broker.** A data file lists each app the cloud signs in to: issuer, authorization and
   token endpoints, client authentication method, scopes, the MCP resource, and the names of the
   environment variables holding its client ID and secret. Spade starts a sign-in with a PKCE
   challenge and a one-time X25519 public key; the cloud keeps a state bound to the account, app,
   challenge, public key and a ten-minute expiry, and returns the authorization URL whose redirect
   is `https://cloud.acehq.dev/v1/oauth/callback`. The maker redirects there; the cloud checks
   state and `iss` and shows "Signed in. You can close this tab." Spade then sends the PKCE
   verifier; the cloud checks it against the challenge, exchanges the code with the client
   secret, seals the token response to Spade's key (X25519, HKDF-SHA256, ChaCha20-Poly1305),
   returns it and forgets it. Refreshing works the same way: Spade sends its refresh token over
   TLS with a fresh public key, and gets the new tokens back sealed.

4. **The exception to ADR 0002, and its limits.** The cloud sees an app's tokens in transit,
   during an exchange or a refresh, and stores none: no database, no token in memory after the
   request that carried it, none in logs. Its only state is pending sign-ins (state, PKCE
   challenge, public key, and the authorization code until Spade collects it, at most ten
   minutes) and rate-limit counters, in memory. Logs carry the account id, the app and the
   outcome. Tokens live where every connector's tokens live: the OS keychain on the person's
   machine. Provider CLIs are untouched; this covers connector apps only.

5. **Spade works without it.** Catalogue entries marked `via: "cloud"` sign in through Spade
   Cloud; every other connector, and "use your own client ID" for these four, work as before.
   Signed out of ace, the entry says so with a Sign in to ace button. With the cloud unreachable,
   apps already connected keep working until their tokens expire, and their rows say so. A
   connected app routed through the cloud says "Signs in through Spade Cloud".

6. **Designed to grow.** State sits behind small stores so a database can replace the in-memory
   ones without changing the API. A managed Spade (running Spade itself in the cloud) is recorded
   as the direction, not built; it needs its own decision on where tokens and history live.

## Consequences

- Asana, Box, Canva and HubSpot can sign in with one click once the owner registers Spade's apps
  with them and sets their secrets on the service.
- ace now runs a service that holds client secrets and sees app tokens in transit. A compromise
  of the service exposes the secrets (rotate at each maker) and tokens of sign-ins and refreshes
  during the compromise; stored tokens are not exposed, because none are stored.
- Machine grants are not bound to an audience: one handed to Spade Cloud could be replayed at the
  relay's `/host` within five minutes, where the Noise handshake still requires the machine's key.
  An audience claim is a later change to `@ace/account-grant`.
- People using a self-hosted account backend can't use Spade Cloud; the cloud trusts only
  ace's.

## Tests

- Service: a fake maker and fake account keys. State is bound to account and app; `iss` is
  checked; a wrong verifier is refused; another account can't finish a sign-in; an expired state
  is refused; a callback or finish can't be replayed; the sealed answer opens only with Spade's
  key; no token, code, verifier or secret reaches the logs or survives the request; rate limits
  answer 429.
- Spade: a fake Spade Cloud. Sign-in stores tokens in the keychain; renewal goes through the
  cloud; with the cloud down a connected app keeps working and says so; signed out of ace, connect
  is refused with the Sign in to ace reason.
- Daemon: Spade's grant gets a machine grant; any other bearer doesn't; signed out answers so.
