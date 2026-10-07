# 0043: Cursor via `@cursor/sdk` local runtime

Date: 2026-10-02. Status: Accepted.

## Context

The owner has selected Cursor's official local SDK runtime for ace's Cursor
provider. The [SDK audit](../research/providers/cursor-sdk.md) inspected
`@cursor/sdk` 1.0.35, its published implementation, Cursor's official docs, and
ace's ACP adapter on `integration/train-1`.

The SDK embeds a local agent runtime in a Node process. It does not launch
`cursor-agent` or reuse its login. Its browser login mints an API key in an
SDK-owned credential store. The [official SDK login amendment to ADR 0002](0002-local-cli-providers.md#amendment-official-sdk-logins)
authorizes this local integration. It leaves ace's prohibition on hosted service
and ace-owned provider credentials intact.

The SDK supplies structured tool identities, run errors, token usage and durable
SDK sessions. The trade-offs are real: no interactive approval callback, rejected
interactive questions, automatic plan creation, and incomplete nested task
deltas. The audit preserves these findings and their primary sources. The owner
accepts those limits with the following behavior.

## Decision

### Runtime and authentication

Build `packages/adapter-cursor`, exported as `@ace/adapter-cursor`, on the official
`@cursor/sdk` local runtime. Start with exactly version **1.0.35** and gate the
installed SDK version before admitting a turn. The Node 24 daemon supervises
isolated SDK host processes through provider-kit. The SDK performs local tool
execution and its own requests to Cursor; ace remains a local application.

Each provider instance has its own SDK browser sign-in through
`Cursor.auth.login()`, or uses the user's own `CURSOR_API_KEY` from the daemon's
launch environment. Use the provider-instance home contract from
[accounts PR #25](https://github.com/arpan404/ace/pull/25). With that contract's
private `HOME`, the SDK default store is
`<instance.homeDir>/user/.cursor/sdk/auth.json`. Set the home before importing the
SDK, and keep SDK hosts from sharing process-global credential caches.

The SDK owns credential persistence. ace never logs, persists, transmits to its
clients or IPC, or displays the key. It never accepts a key through settings,
RPC or an account registry entry. The SDK consumes the inherited environment key
directly. Discard `login()`'s key-bearing result inside the host and expose only
safe sign-in status. A custom login store alone does not configure the SDK
runtime's credential resolver; use the isolated default store consistently.
[Authentication source findings](../research/providers/cursor-sdk.md#authentication-and-process-ownership).

Sign-out stops the instance's SDK hosts, calls the SDK logout operation and
deletes the SDK credential store. Preserve conversation history. Dashboard
revocation is separate: SDK logout only forgets the local key. An environment
key remains active until the user removes it from the launch environment; report
that source honestly. No credentials pass through ace's own network code.

### User controls

- Map full-access runtime mode to sandbox off. Map restricted mode to sandbox on
  plus Cursor Auto-review. Advertise `approvals: "sandbox-only"` in capabilities.
  The UI shows the execution policy and denials, never a fabricated permission
  prompt. Interactive question answering and provider plan review remain
  unavailable on this backend. Sandbox setup failure fails closed.
- Implement steering by interrupting the current SDK segment and restarting with
  the new input under the **same ace run**. Persist the command intent and segment
  identities. Cancelled or late events from the old segment cannot finish or
  resurrect the replacement. The SDK's optional native `Run.steer` is not the
  selected implementation policy.
- Implement forks as a bounded portable-context handoff to a fresh SDK agent.
  Record provenance and context truncation. Do not claim native checkpoint forks
  or convert an ACP session ID into an SDK agent ID.
- Show `task` children as read-only child agents in ace's tree. Associate task
  calls and nested updates, late-link observed child identities, and declare
  summary or placeholder fidelity where content is missing. Background dispatch
  completion does not settle the child. Apply [ADR 0004](0004-canonical-agent-model.md)
  to the whole tree, including children unresolved after interruption or exit.
- Connect ace operations through ace's thread-scoped MCP server, with its existing
  instance and thread authorization. Do not implement them as SDK `customTools`,
  which bypass the built-in tool approval path. Child tree projections remain
  read-only; they are not independently resumable ace threads.

### Adapter contract and recovery

Follow [ADR 0007](0007-adapter-and-engine-contract.md). The pure translator maps
SDK-boundary frames to canonical facts; the thin session owns SDK host I/O and
lifecycle. The engine owns status, ordering, durable intents and persistence.
Record and replay SDK calls, streaming messages, deltas, results, cancellation,
history snapshots and disposal at that boundary. SDK package internals are not
ace's replay contract.

Bound worker count, IPC frames, pending sends, transcript pages and translator
state. Dispose sessions on idle and shutdown; cancel and terminate unresponsive
hosts after a grace period. Preserve unknown data within the provider payload
budget. An SDK terminal result cannot by itself prove that the whole tree is done.

### ACP and existing threads

Keep the generic ACP adapter for ACP registry agents and Cursor fallback when
`@cursor/sdk` is absent. Use backend-specific capabilities. Auth failure, an
unsupported SDK version or failed sandbox setup must produce an actionable
error, rather than silently switching transports.

New Cursor threads default to the SDK. Existing ACP threads retain their native
IDs, account bindings, events and ACP continuation path. Persist the backend
alongside native identity so resume always selects the original transport. Offer
an explicit portable-context handoff to move an old thread to a new SDK thread.
There is no verified native ACP-to-SDK conversion.

## Consequences and delivery

Cursor has structured SDK session and error reporting, local history and token
usage. Users sign in separately for each SDK provider instance. They give up ACP's
interactive permission, question and plan-review channel on new SDK threads.
Nested task transcript fidelity remains limited, and billed usage is not an
account quota-window feed.

The implementation must coordinate accounts, discovery, capabilities, engine
steering/forks, MCP injection and fixture capture. The detailed migration and
primary evidence are in the [audit](../research/providers/cursor-sdk.md#migration-from-integrationtrain-1).
The worker brief is `/tmp/ace-orch/impl-cursor-brief.md`; it lists behavior tests
and `composer-2.5` fixture scenarios for the owner's approval. This ADR does not
authorize fixture recording or subscription spending.

The implementation is clean room. t3code's public user documentation is an
approach reference only; ace's code comes from its own contract and primary
Cursor sources. Cursor Cloud and a hosted ace service are outside this decision.

## Amendment: one Cursor provider and sign-in

Accepted 2026-10-07 for the owner's single-provider request. This supersedes the
Cursor ACP fallback and continuation decision above. Generic registry ACP agents
remain supported; Cursor itself runs only through the SDK.

The installed dependency was inspected again after `bun install`, without
accessing any user credential files. `@cursor/sdk` is pinned to 1.0.35. Its
published `dist/esm/index.js` contains the modules
`src/agent/auth/credential-store.ts`, `login-flow.ts`, `stored-credentials.ts`
and the public browser login implementation. `dist/esm/auth/login.d.ts` describes
that public interface. The source and [official authentication reference](https://cursor.com/docs/sdk/typescript#cursorauth)
establish the following behavior:

- The resolver reads an explicit key, then `CURSOR_API_KEY`, then the SDK's own
  default store. It does not read the CLI/app credential store or macOS keychain.
- Browser login creates a challenge with `redirectTarget=sdk`, polls the provider,
  mints an expiring API key and persists it through `FileCredentialStore`.
  It is not an API-key-only setup. Browser authentication can reuse a user's
  existing website session, but that is not CLI credential reuse.
- The default store is `~/.cursor/sdk/auth.json`, resolved from the SDK host's
  home. ace sets that home to `<instance.homeDir>/user` before import, so the
  owner's editor directory is never read or changed. The SDK owns this file.
- Login's key-bearing result is discarded inside the host. Only an ephemeral
  challenge URL and sanitized status reach ace. User-provided keys may remain in
  the launch environment and go directly to the SDK, as ADR 0002 allows.

Every provider list now has one product, Cursor. Its existing SDK default identity
is retained to preserve SDK logins and checkpoints. The implicit
`cursor-cli-default` row and its selection are retired before filesystem
canonicalization. Old client selections of that account map to
`cursor-sdk-default`. SDK auth selection and generic account defaults now share
one selection owner; persisted SDK selections are still read. Cursor executable overrides are removed from settings;
other preferences and JSONC comments survive. Automations already persist a
provider kind without a backend. Cursor jobs and delegations therefore select
the SDK through the same engine and account boundary as new human threads.
Legacy ACP and CLI permission-preview values still parse and resolve to Cursor's
SDK capabilities.

Unused CLI threads with no native session, transcript or outstanding intent move
to the SDK. Used CLI threads keep their saved history and native ACP identity,
open read-only, and offer "Continue in a new thread". That action uses the existing
bounded portable-context handoff and scoped history tools. It creates a fresh SDK
session; there is no verified ACP-to-SDK native resume conversion. Read-only
threads reject execution commands and cannot reopen a provider process on
restart. Their interrupted work is still reconciled by the ordinary engine
recovery rules rather than being claimed as completed.

`createCursorLoginDriver(instance, accountDriver).start(signal)` in
`@ace/adapter-cursor` emits an async stream of safe progress. Its states match the
existing SDK browser auth wire: starting, browser, complete, failed, cancelled.
There is no user code for this SDK version. Cancellation and consumer closure
abort and drain the isolated host operation. Challenges have no persistence or
replay path. The parallel in-app sign-in work can bind this small interface to
its flow without introducing another Cursor backend or credential store.

Installed providers with `not_configured` model discovery publish information,
not a failure retry schedule. They provide `actionId: provider.sign_in`, and
Cursor's hint is "Sign in to Cursor". Explicit refresh, changed login identity,
installation/configuration change and maximum cache age cause rechecks. Provider
status also exposes `state: not_configured` and the sign-in action for an
installed, logged-out provider. Other discovery failures retain their backoff.
