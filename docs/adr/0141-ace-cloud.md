# 0141: ace cloud, one Worker for the relay, accounts and Spade's sign-in broker

Status: accepted. Date: 2026-11-12. Decided by: the owner (2026-11-12). Supersedes
[ADR 0140](0140-spade-cloud.md)'s choice of a separate Rust service on Railway; the rest of 0140
(what the broker does, its API and the limits on its exception to
[ADR 0002](0002-local-cli-providers.md)) stands. Amends [ADR 0110](0110-cloudflare-relay.md) and
[ADR 0111](0111-account-machine-access.md) on the service's name and domain.

## Context

ace runs one hosted Cloudflare Worker (ADR 0110, 0111): the relay, the account API and the
account grants, at `relay.acehq.dev`. ADR 0140 added a second hosted service, Spade Cloud, as a
Rust container on Railway at `cloud.acehq.dev`, whose only job so far is the OAuth broker for
connector apps that need a client secret. That meant a second deployment, a second host, and a
service that fetched the Worker's grant keys over the network to check credentials the Worker
itself had signed.

The owner, 2026-11-12:

- "instead of relay, lets give it a better name ... lets call it cloud itself"
- the name is **ace cloud**, at **cloud.acehq.dev**
- "move the code of our backend to cloudflare workers instead of rust for these connectors, we
  will later add rust as separate VMs and so on managed by the worker itself"

## Decision

1. **One service, ace cloud.** The hosted Worker is renamed ace cloud and served at
   `https://cloud.acehq.dev`. Its code moves from `apps/relay-cloudflare` to `apps/cloud`
   (package `@ace/cloud`). It serves, as before, the relay (`/host`, `/client`, `/join`,
   `/serve`, `/m/<hostId>/…`) and the account API (`/v1/…`), and now Spade's connector sign-in
   broker (`/v1/oauth/…`).

2. **The old address keeps working.** The production Worker also keeps the `relay.acehq.dev`
   custom domain. Both names reach the same script, D1 database and Durable Objects, so
   sessions, grants, saved machines and relay connections are the same on either. Clients
   default to `https://cloud.acehq.dev` (relay `wss://cloud.acehq.dev`). Anything they stored
   under `https://relay.acehq.dev` (the daemon's session file, the desktop's saved sessions, a
   window's session, saved machines' routes, the iPhone's keychain entry) is read as the cloud
   address and moved to it, so no one is signed out. Outside MCP clients configured with
   `https://relay.acehq.dev/m/<hostId>/…` (ADR 0122) keep working there.

3. **The script keeps its name, `ace-relay`.** The relay's Durable Objects belong to the script
   that declares them; deploying under another name would start empty objects and leave the
   live ones behind. Only names people see change. The sign-in objects are a new class added by
   migration `v2`.

4. **The broker is Worker code, in TypeScript.** It keeps ADR 0140's API, wire shapes and
   sealing exactly, so Spade (`spade-connect`, `spade-cloud-wire`) is unchanged:
   - `POST /v1/oauth/{app}/start|finish|refresh` and `GET /v1/oauth/callback/{app}`, Zod 4
     schemas at the boundary, clock, randomness and fetch injected.
   - Sign-ins in progress live in a Durable Object per account (`SignInObject`, named by the
     account id), at most five, ten minutes each, single use; an alarm drops what runs out. The
     OAuth `state` carries the object's id, not the account.
   - The cloud credential (ADR 0111 signing, kind `machine`, `aud: "cloud.acehq.dev"`,
     `purpose: "spade-cloud"`) is minted by this Worker's `/v1/grants` and verified here with
     the same keys (`verifyCloudGrant` in `@ace/account-grant`), with no network fetch. `/host`
     and `/client` refuse it, and the broker refuses relay grants.
   - Rate limits per caller address and per account use Workers rate-limit bindings
     (`BROKER_ADDRESS_REQUESTS`, `BROKER_ACCOUNT_REQUESTS`).
   - Vendor client IDs and secrets are Worker secrets named in the app list
     (`SPADE_CLOUD_<APP>_CLIENT_ID`, `SPADE_CLOUD_<APP>_CLIENT_SECRET`).
   - Sealing is X25519, HKDF-SHA256 and ChaCha20-Poly1305 as before. Workers' Web Crypto has
     X25519 but no ChaCha20-Poly1305, so all three use the `@noble` libraries (MIT, audited)
     that `@ace/secure-channel` already ships. Shared vectors in
     `spade/crates/spade-cloud-wire/test-vectors.json` prove that ring and the Worker seal and
     open the same bytes.

5. **Rust later runs beside the Worker, not instead of it.** When ace cloud needs Rust (running
   Spade itself, for example), it runs on separate machines that the Worker starts, routes to
   and manages. That is the direction, not built; it needs its own decision on where data
   lives. `spade/crates/spade-cloud`, its Dockerfile and its Railway config are removed.

6. **ADR 0002's exception is unchanged.** ADR 0140's scoped exception stands as written: the
   broker holds connector apps' client secrets, sees their tokens only in transit, stores none
   and logs none. It now holds them as Worker secrets instead of a container's environment.

## Consequences

- One deployment and one domain to run. `wrangler deploy --env production` ships the relay,
  accounts and the broker together; the release job smoke-tests both hostnames.
- Before the first deploy with this change, WorkOS needs
  `https://cloud.acehq.dev/v1/account/callback` as a redirect URI, because the account
  backend's public URL becomes cloud.acehq.dev.
- The broker shares the Worker's blast radius: a compromise of the Worker exposes the vendor
  secrets as well as the grant signing key it already held.
- Sign-ins in progress survive a deploy or isolate restart, which the in-memory Rust broker
  didn't.
- Workers' limits now apply to the broker (CPU time per request, subrequest count); a sign-in
  uses one subrequest to the maker.

## Tests

- `apps/cloud/src/broker/broker.test.ts`: state bound to account and app, `iss`, PKCE, wrong
  account, replay of callback and finish, expiry, the five-sign-in cap, credential audience,
  rate limits, maker refusals, and no token, code, verifier, state, credential or secret in the
  logs.
- `apps/cloud/src/broker/seal.test.ts` and `spade-cloud-wire`'s `seal.rs`: the shared vectors.
- `apps/cloud/src/broker.process.test.ts`, under workerd: a credential from `/v1/grants` signs in
  once through the real Durable Object, another account can't finish, the object lets a
  sign-in run out, a cloud credential opens no relay socket and a relay grant starts no
  sign-in, and both hostnames are one service.
- Client tests: a session, secret or machine saved under relay.acehq.dev is still found and
  routed at cloud.acehq.dev.
