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

The daemon's `ace` bin delegates `ace accounts ...` to this package; there is one host CLI bin. `ACE_ACCOUNTS_DB` overrides the default `$ACE_HOME/accounts.sqlite` (`ACE_HOME` defaults to `~/.ace`), shared with the daemon. Cursor SDK sign-in is separate from CLI/editor login. When the exact supported SDK is installed, Cursor add/status use isolated SDK hosts and safe auth-source metadata; SDK absence retains ACP login. Its one-time browser URL is displayed only in the calling terminal. API authentication inherits the existing launch environment, with no key entry UI. Other providers inherit the terminal and run their CLI login flow. Its injected supervised spawner owns the process group; cancellation escalates from SIGTERM to SIGKILL and waits for the child to be reaped. For a Claude API key, configure the CLI's home directly; `--console` selects its Console login. ace does not accept a key argument.

## Engine integration

Import only the package root and `@ace/protocol/accounts` for schemas. `createInstance` builds isolated home selectors. `instanceEnv(instance, baseEnv)` removes ambient provider auth overrides and returns the environment for discovery and adapter launch. `loginStatus` reuses provider-kit single-provider discovery; it never probes unrelated CLIs. The ACP Cursor fallback needs the installed CLI's native file credential store and a private HOME/XDG/APPDATA root in addition to its data/config selectors, because the default macOS keychain remains global. ace sets those process options and the CLI performs login/storage. The hidden store selector is verified for `2026.09.26-dd393fe`; other versions report unknown auth and cannot run an accounts login until reverified. Existing global Cursor keychain logins are not imported. Its private HOME also changes home-dependent tool configuration, so users may need to configure git/SSH through the CLI environment for that instance. `openRegistry` returns a registry with `register`, `ingest`, `summary`, `summaries`, `pickInstance`, and `close`; callers close it during daemon shutdown. `register` is asynchronous: it canonicalizes every selector through the nearest existing ancestor before the SQLite transaction. Physical aliases are refused; reopening an older registry upgrades identities and refuses historical aliases.

`ingestQuota(state, {provider, payload, observedAt, timeZone})` is pure. Supply `payload: new ProviderPayload(encodedBytes)` from `@ace/provider-kit/payload`. The constructor refuses inputs over 1 MiB before JSON parsing or object enumeration, limits structural depth to 64 and nodes to 32,768, and freezes the owned decoded data. No arbitrary-object certification API exists. The fold returns `{state, raw}` with `raw === payload.data`, including unknown variants. An uncertified object input installs a conservative overflow blocker without traversing it. Times in stored windows are epoch milliseconds; provider epoch seconds are converted at ingress. Token/cost counters are latest cumulative snapshots, so adapters must keep session accounting outside this per-instance estimate. Out-of-order observations are ignored. Claude event utilization is fractional, while experimental usage snapshot utilization is percentage. At 80% the instance is near its limit; at 100% it is exhausted until every exhausted window resets. Unknown reset times block until fresh provider data arrives. More than 32 windows produces a conservative overflow blocker, cleared only by a complete bounded authoritative usage/limits snapshot. Local blockers have their own namespace, inaccessible to provider window names. Unknown statuses and malformed siblings preserve existing constraints. Ingress validates container references without cloning maps and decodes at most 32 entries plus overflow lookahead, including malformed entries.

`pickInstance({provider, role, estimatedLoad}, candidates, now)` and `registry.pickInstance(input, now)` require estimated load in percentage points. They exclude logged-out, unknown, near-limit and exhausted instances, then prefer the earliest active reset, headroom and stable ID. `speedHint` uses role policy and per-instance model capabilities. Pass the installed Codex `model/list` response or an explicitly probed Claude fast-model allowlist. No global catalog is assumed.

`migrateSession({provider, nativeSessionId, from, to}, safety, observe?)` returns a typed `migrated`, `unsupported`, or `refused` result. The daemon must provide `safety.acquire`, which holds exclusive quiescence for both homes, including all ancestors/sidechains and independently launched CLIs, through publication. Return undefined if that cannot be proven. The package additionally refuses native Codex writer locks, including stale ones, and rechecks files/locks before publishing. It never creates, cleans up or removes source lock files. A supplied lease that excludes only ace-owned root processes is unsafe.

Successful Codex migration returns the unchanged native ID and `action: "fork"`; use the destination environment for the native fork. Claude returns `action: "resume"`. Source transcripts and credentials stay untouched. Discovery records unsupported formats and ambiguity per session; only failures in the selected lineage block migration. The optional async progress observer receives bounded copy/staging progress and provides backpressure. Cleanup failures return optional `cleanupWarnings` alongside the migration outcome; a failed lease release does not hide successful publication. Complete files publish atomically without clobbering existing paths, ancestors/sidechains first and the root last. Already copied files are reused only after their streamed SHA-256 hashes match, so sibling forks can share ancestors and repeated migrations are idempotent. Conflicting files are refused. Partial operation failures roll back published files. A host crash can leave complete orphan ancestors or `.ace-migrate-*` staging directories. There is no automatic deletion of user history.

`AccountService.bindAdapter(factory, assignmentFor?)` returns an engine-compatible `ProviderAdapter`. Register this bound adapter with the engine. Its native `factory.create(env, context)` runs after account assignment and receives the final selected home environment before constructing option-based adapters. The optional assignment policy receives context and returns schema-validated role/load/instance selection. Persist `session.instanceId` alongside `session.nativeSessionId`, and pass `context.instanceId` on resume; unpinned resume refuses. The factory may asynchronously compose model resolution for that instance and MCP/plugin/context inputs through their owner APIs. Those owners retain their cleanup responsibilities. Lifetime-bound resources use `context.signal`, revoked on natural exit or completed close.

`AccountService` handles authenticated daemon list/status/migrate messages (`read` scope for list/status, `operate` for migration) and binds adapters through `openSession`. The binding supplies `SessionContext.env`, accepts only certified `Frame.payload` values whose immutable `.data` is the exact `Frame.data`, folds quota frames into the assigned account, and excludes new starts and ace-owned writers during migration. Daemon requests are capped at eight in flight per socket; writer/migration indexes are bounded by the 256-account registry. Stream deltas without quota facts bypass SQLite. Native transports must construct `ProviderPayload` from capped encoded bytes before decoding, retain the certificate on frames, and close their complete process tree before reporting exit. Uncertified/mismatched frames are fenced, never forwarded or ingested, and trigger awaited shutdown. A failed shutdown keeps the writer reservation blocked. Re-serializing arbitrary provider objects is not an admission proof. Transport owners must also bound line/SSE buffers while collecting bytes.

The default daemon safety policy refuses migration because independent-writer exclusion cannot currently be proven. A verified offline host can inject `MigrationSafety`; absence of locks or a process-table snapshot is insufficient because independent CLIs can start afterward. This is a precondition, not implemented independent-process detection. After a lease-release failure, the service keeps both instances blocked. No automatic live migration is enabled. OpenCode and Cursor migration is unsupported until complete history fidelity and exclusion can be established. Paginated/compressed Codex rollouts also require provider-owned materialization; ace refuses them rather than copying provider-wide SQLite databases.

## Verification

The repository owner currently permits static checks only. Tests, mutation cases,
benchmarks and combined-provider execution **need run at merge**. See
[verification and integration notes](VERIFICATION.md) for the behavior guards and
mutation cases. Allowed static checks:

```sh
bun run typecheck
bun run lint
bun run fmt
bun run check:size
```

The fork-verification command is opt-in and invokes the installed Codex only on synthetic histories with no prompt argument and ignored stdin. It creates no model turn. Tests use fake CLIs or synthetic files and a real local process for live-lease refusal. Sample rate-limit fixtures come from the repository's existing recordings, not a new recorder run. See [ADR 0018](../../docs/adr/0018-accounts-and-session-portability.md) for format limits and provider evidence.

Cursor SDK factories use `bindCursorSdk` and preserve the selected backend/home before host import. `cursorSdkLoginDriver` requires a selected-instance stop fence for logout; share one `CursorHostSlots` across auth, catalog and session workers. Safe SDK source/status is `quota.cursorSdkAuth`. The default credential store is `<instance.homeDir>/user/.cursor/sdk/auth.json`. Sign-out retains checkpoints/history and does not revoke the dashboard key; launch-environment authentication remains active until removed. Native SDK checkpoint migration is unsupported. See [integration limits](../../docs/integration/cursor-sdk-accounts.md).

`CursorAuthService` assembles per-account browser sign-in, polling/cancellation,
safe status, account selection and sign-out for the daemon service registry.
Login challenges expire in bounded memory and belong to the paired device that
started them; neither URLs nor returned credentials enter canonical history.
Sign-in and sign-out drain selected-instance hosts; sign-out also drains any
pending login before deleting the SDK store. `selectedCursorSdk`/`selectCursorSdk`
store only the default account identity. New SDK threads pin it at command
acceptance; resume retains the original instance. The remote client opens the
SDK-provided URL. See the [typed browser auth protocol](../../docs/integration/cursor-sdk-auth.md).

## ACP registry instances

`createAcpInstance` registers a CLI-owned default with explicit `acpAgentId`, `installationId` and `instanceId`. Default instances may share the current user home without claiming isolation. Unknown home/keychain strategies and ACP migration return unsupported; `createInstance` continues to construct native instances. Stored defaults cannot change agent or installation identity under the same ID.

`AccountService.acpEnvironment` returns the selected local environment and login revision. A successful CLI login revises only that account generation; ACP advertised auth methods do not establish login status. `AccountService.loginAcp` is a local terminal API backed by the approved registry's reviewed login resolver. It inherits terminal streams without recording credential input/output and has no remote wire route. Unknown profile commands are unsupported. Session wrappers preserve immutable launch plans, negotiated support and model/mode selectors even when they replace lifetime signals.

ACP behavior suites and `bench/acp.ts` are written but not executed. They need run at merge under the owner's verification policy.
