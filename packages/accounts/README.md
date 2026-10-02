# Accounts

`@ace/accounts` owns local provider instance metadata, quota snapshots, assignment hints, and offline session copies. It never reads, captures or stores a provider credential.

## CLI

```sh
bun run --filter @ace/accounts accounts accounts add codex codex-work /absolute/path/.codex-work "Work"
bun run --filter @ace/accounts accounts accounts add claude claude-console /absolute/path/.claude-console "Console" --console
bun run --filter @ace/accounts accounts accounts discover
bun run --filter @ace/accounts accounts accounts status codex-work
bun run --filter @ace/accounts accounts accounts list
```

The package also declares an `ace` bin with the same `accounts` subcommands. `ACE_ACCOUNTS_DB` overrides the default `~/.local/state/ace/accounts.sqlite`. Login inherits the terminal and runs the CLI's own login flow. For a Claude API key, configure the CLI's home directly; `--console` selects its Console login. ace does not accept a key argument.

## Engine integration

Import only the package root and `@ace/protocol/accounts` for schemas. `createInstance` builds isolated home selectors. `instanceEnv(instance, baseEnv)` removes ambient provider auth overrides and returns the environment for discovery and adapter launch. `loginStatus` reuses provider-kit discovery. Cursor needs the installed CLI's native file credential store and a private HOME/XDG/APPDATA root in addition to its data/config selectors, because the default macOS keychain remains global. ace sets those process options and the CLI performs login/storage. Existing global Cursor keychain logins are not imported. Its private HOME also changes home-dependent tool configuration, so users may need to configure git/SSH through the CLI environment for that instance. `openRegistry` returns a registry with `register`, `ingest`, `summaries`, `pickInstance`, and `close`; callers close it during daemon shutdown.

`ingestQuota(state, {provider, payload, observedAt, timeZone})` is pure. It returns `{state, raw}` with the exact original raw fact, including unknown variants. Times in stored windows are epoch milliseconds; provider epoch seconds are converted at ingress. Token/cost counters are latest cumulative snapshots, so adapters must keep session accounting outside this per-instance estimate. Out-of-order observations are ignored. Claude event utilization is fractional, while experimental usage snapshot utilization is percentage. At 80% the instance is near its limit; at 100% it is exhausted until every exhausted window resets. Unknown reset times block until fresh provider data arrives. More than 32 windows produces a conservative overflow blocker, cleared only by a bounded authoritative usage/limits snapshot.

`pickInstance({provider, role, estimatedLoad}, candidates, now)` and `registry.pickInstance(input, now)` require estimated load in percentage points. They exclude logged-out, unknown, near-limit and exhausted instances, then prefer the earliest active reset, headroom and stable ID. `speedHint` uses role policy and per-instance model capabilities. Pass the installed Codex `model/list` response or an explicitly probed Claude fast-model allowlist. No global catalog is assumed.

`migrateSession({provider, nativeSessionId, from, to}, safety)` returns a typed `migrated`, `unsupported`, or `refused` result. The daemon must provide `safety.acquire`, which holds exclusive quiescence for both homes, including all ancestors/sidechains and independently launched CLIs, through publication. Return undefined if that cannot be proven. The package additionally refuses native Codex writer locks, including stale ones, and rechecks files/locks before publishing. It never creates, cleans up or removes source lock files. A supplied lease that excludes only ace-owned root processes is unsafe.

Successful Codex migration returns the unchanged native ID and `action: "fork"`; use the destination environment for the native fork. Claude returns `action: "resume"`. Source transcripts and credentials stay untouched. Complete files publish atomically without clobbering existing paths, ancestors/sidechains first and the root last. Already copied files are reused only after their streamed SHA-256 hashes match, so sibling forks can share ancestors and repeated migrations are idempotent. Conflicting files are refused. Partial operation failures roll back published files. A host crash can leave complete orphan ancestors or `.ace-migrate-*` staging directories. There is no automatic deletion of user history.

This package exposes additive wire schemas but does not register daemon handlers or start automatic migrations. Adapters/engine bind those interfaces as their workstreams land. OpenCode and Cursor migration is unsupported until complete history fidelity and exclusion can be established. Paginated/compressed Codex rollouts also require provider-owned materialization; ace refuses them rather than copying provider-wide SQLite databases.

## Verification

```sh
bun run test packages/accounts
bun run --filter @ace/accounts bench
node packages/accounts/bench/mutations.ts
node packages/accounts/bench/verify-codex-fork.ts
```

The last command is opt-in and invokes the installed Codex only on synthetic histories with no prompt argument and ignored stdin. It creates no model turn. Tests use fake CLIs or synthetic files and a real local process for live-lease refusal. Sample rate-limit fixtures come from the repository's existing recordings, not a new recorder run. See [ADR 0018](../../docs/adr/0018-accounts-and-session-portability.md) for format limits and provider evidence.
