# 0189: One shared production; new cloud features are gated by the calling app's version

Date: 2026-11-18. Status: accepted. Decided by: the owner (one shared production for beta and
stable; new server behaviour is gated by client version), the build of this ADR's branch (how).
Builds on [ADR 0177](0177-beta-release-line.md) (the beta line and its version order),
[ADR 0141](0141-ace-cloud.md) (ace cloud), [ADR 0110](0110-cloudflare-relay.md) (the relay on
Workers), [ADR 0155](0155-relay-connect-in-one-round-trip.md),
[ADR 0168](0168-ace-marketplace.md) and [ADR 0174](0174-market-publishers-discovery-and-scanning.md)
(the market).

## Context

ace runs one ace cloud (`apps/cloud`, Worker `ace-relay`, cloud.acehq.dev and relay.acehq.dev:
relay, accounts, Spade's sign-in broker, HTTP forwarding) and one market (`apps/market`,
market.acehq.dev). Betas (`ace-X.Y.Z-beta-N`, app version `X.Y.Z-beta.N`) and stable releases
both talk to them. Until now no client told either server which app or version it was, so a
server change reached every app at once: a beta could not use a new server feature without
stable apps seeing it too.

## Decision

**One shared production for beta and stable.** There is no beta cloud and no beta market.

- Accounts, machines on the relay, market publications and their counts are one set of data. A
  second production would split a person's account and machines in two, or need syncing.
- A person's apps mix lines: a beta iPhone app pairs with a stable desktop through the same
  relay and the same account. Two clouds could not connect them.
- A beta install moves on to stable (ADR 0177) and keeps its account and machines.

**Staging first.** A Worker change deploys to staging before production (the release pipeline's
`deploy-staging` step, [ADR 0188](0188-tag-driven-release-pipeline.md) once it lands), and
production deploys before the apps that need it publish.

**Expand, then contract.** A server change that apps depend on lands in two steps. Expand: the
server accepts both the old and the new shape and keeps serving the old one, deployed before
any app uses the new one. Contract: the old path is removed only once no supported app uses it.
D1 migrations follow the same rule: add columns and tables first, drop them only after.

**The cloud keeps serving older stable apps.** Production deploys before publish and people
update late, so every Worker version serves the apps already out there: the previous stable,
every beta since, and older stables until they are explicitly unsupported. A gate only ever
turns new behaviour on; the behaviour older apps rely on stays as it is.

### The header contract

Every ace app names itself on each request to ace cloud or the market
(`@ace/protocol/ace-client`):

```
ace-client: <app>/<version>
```

- `app`: one of `daemon`, `desktop`, `web`, `ios`, `cli`, `spade`. Any other name is an unknown
  client; a new app is added to `AceClientApp` first.
- `version`: the app's semver, a beta's prerelease included (`0.0.24-beta.1`), or
  `development` for a build that isn't a release.
- **Browsers never send the header.** The web app, the desktop app's renderer and their
  workers carry the same value in the `ace-client` query parameter, on every request and
  upgrade. A WebSocket upgrade can't set headers, and a custom header on a cross-origin call
  adds a CORS preflight: the web app at app.acehq.dev builds from `main` on merge, before the
  cloud deploys, and an older cloud's preflight refuses the header, which would break sign-in.
  A query parameter needs no preflight, so a browser build and any cloud work in either order.
- Apps outside a browser (daemon, CLI, desktop main process, Spade) send the header.
- The servers read the header first, then the parameter, on every request. A present header
  wins over the parameter, even a garbled one.
- At most 96 characters. The account API's CORS preflight also allows the header, which costs
  nothing; no browser relies on it.

The servers read it leniently. A missing, unknown, overlong or garbled value is an **unknown
client**, and an unknown client is served exactly as before: absence never refuses a request.

### The gating rule

`@ace/service/client-features` is the one owner, used by both Workers. Each Worker reads the
caller once per request or upgrade (`clientOf`) and hands handlers a gate: ace cloud passes it
to the account API and the broker, the market puts it on each handler's `Context`.
`gate.supports(feature)` answers from `SERVER_FEATURES`, a table of each feature's first
version per app:

- A release supports a feature when its version is at least its app's minimum, in semver order
  (ADR 0177, compared by `@ace/service/version`): 0.0.24-beta.1 < 0.0.24-beta.2 < 0.0.24. A
  feature first shipped in 0.0.24-beta.1 is on for every later beta and for stable 0.0.24 and up;
  one listed at 0.0.24 stays off for the 0.0.24 betas.
- Apps keep their own version lines (the iPhone app's is not the desktop's), so each feature
  names a minimum per app. An app it doesn't list doesn't get it.
- An **unknown client is treated as the oldest app**: the feature is off.
- A **development build** gets the feature if its app is listed. Development builds are the
  owner's own, built from `main`, which is ahead of every release; the server change has to be
  exercisable before a beta exists, and staging plus expand-then-contract already keep a
  development build from depending on anything production can't serve.

Gating is compatibility, not authorization. Any caller can claim any version, so a gated
feature must be safe for whoever asks for it; access still comes from grants and sessions.

The table ships empty: no current feature needs a gate, and existing behaviour is never gated.

### Adding a gated feature

1. Add an entry to `SERVER_FEATURES` naming the feature and, for each app that understands it,
   the first version that does: the beta that will carry it (`0.0.24-beta.1`), or the stable
   version when no beta will.
2. In the handler, keep the old behaviour and branch on `gate.supports(feature)` for the new one.
3. Deploy the Worker (staging, then production) before the app release that uses it.
4. Remove the entry and its branch once the oldest app the servers still support is past every
   minimum the entry names. Until then the old path stays.

### Who sends it

One helper per runtime builds the value from the app's own version, and every request to ace
cloud or the market goes through it, never a copy per call site.

- **TypeScript** (`@ace/client/ace-client`): `aceClientName(app, version)` builds the value, or
  none for a version it can't read. Outside browsers `namedFetch` adds the header to a `fetch`
  used only for ace cloud or the market; in browsers `namedQueryFetch` adds the query parameter
  instead, and `namedUrl` adds it to a relay upgrade (`connectPortableRelay`'s `aceClient`). The Node relay dialer (`@ace/relay`'s
  `connectHostToRelay` and `connectClientViaRelay`) sends the header on every upgrade.
- **Daemon**: `Config.aceClient`, `daemon/<ACE_VERSION>` or `daemon/development`. Its account
  calls, market calls, host registration on ace's relay (`/host`, `/join`, `/serve`) and
  parcel links through ace's relay carry it. ace-media's media `/join` writes its own upgrade,
  so the daemon names itself on the join address it hands over, as a query parameter. A relay the person runs themselves is never told.
- **Desktop** (main process): `desktop/<version>` when packaged, else `desktop/development`,
  on its account session check.
- **Web** (also the desktop app's renderer): `web/<version>` from the build's `ACE_VERSION`
  (`VITE_ACE_VERSION`), `web/development` under Vite's dev server, none otherwise; as the query
  parameter on account calls (`accountFetch`) and on the account machine's relay route.
- **CLI**: `cli/<version>` (as `ace --version` reads it) on the market maintainer tools' calls.
  The CLI's other traffic goes through the daemon.
- **Spade** (Rust): `spade/<ACE_SPADE_VERSION>` or `spade/development` on its sign-in broker
  calls (`spade-connect`'s `CloudClient`). Spade's TypeScript side never calls the cloud.
- **iPhone**: not yet. Its cloud requests have no single place (`AceAccountAPI`,
  `AceAccountModel` and `RelaySocket` each build their own); it names itself once they share
  one. Until then it is an unknown client.

The relay object can read the same value from the upgrade it receives with `clientOf` when a
relay feature needs it.

## Consequences

- A beta can use a new server feature in the one production while stable apps keep the old
  behaviour.
- Apps released before this ADR send nothing and stay unknown clients: they get no gated
  feature, and are served as before.
- Browser builds and the cloud deploy in either order: browsers add nothing a preflight checks.
- The table needs housekeeping: a gate stays until the oldest supported app passes it.
- Version numbers alone don't protect anything; the header is a hint for compatibility only.
