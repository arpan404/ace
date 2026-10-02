# @ace/adapter-claude

Claude Code adapter for the locally installed CLI, through Agent SDK 0.3.287. Implements ADR 0007's `ProviderAdapter`, `Translator` and `ProviderSession` contracts. No provider credentials are accepted or managed by this package.

```ts
import { adapter, createClaudeAdapter } from "@ace/adapter-claude";

// Default: resolve the user's claude from PATH through provider-kit.
const provider = adapter;
// An explicit local executable or environment can be supplied by the host.
const configured = createClaudeAdapter({ executable: "/path/to/claude" });
```

`createTranslator({ threadId, rootKey })` is synchronous, has no I/O, and accepts the recorder's `sdk` and `can_use_tool` frames in both directions. Unknown data stays in raw payloads. Frames without a canonical item that can carry their raw data create info notices. This includes status metadata and stream deltas, so the full frame remains available for inspection.

`openSession(ctx)` discovers and probes the executable, then initializes the SDK with an empty streaming input. It sends no prompt until `send` is called. Provider-kit owns the process group through the SDK's custom spawn hook. The input stream remains open between turns. `ctx.onExit` reports process termination once; the engine owns applying the corresponding exit fact.

The recorded baseline is Claude Code 2.1.286. Older or unrecognized versions advertise no verified capabilities, and session opening rejects them. Newer versions retain the baseline capabilities. Steering, fork and file rewind remain disabled because their behavior is outside these recordings. A `steer` send rejects with an actionable error; queued sends use SDK priority `next`, with held input owned by the engine. `queue.changed` now has independent `engine` and `provider` sources; unspecified sources remain engine updates. Core aggregates the two sources before deriving status.

`resolve` supports approval options, question answers keyed by question text, and plan approval/rejection/cancellation. Approval suggestions are returned through `updatedPermissions`. Approving a plan returns allow and sets permission mode to `default`. Canonical resolutions are included beside the native permission response, preserving selected answer identities even when native serialization joins their labels. Native `interrupt: true` plan replies record cancellation. A withdrawn request cannot be answered. `stopTask` accepts native task ids or translator task keys. Interrupting a child stops that task; explicit cascade also stops its registered descendants. A root cascade stops all live registered tasks. Supply `ctx.rootKey` for engine root keys other than the legacy `root` default. Ancestry lookup uses current spawn edges, so a targeted cascade also reaches children registered before their spawning tool arrives. Closing ends input, closes the SDK, stops the owned process group and drains the pump.

## Status and identity

- Turn ends, background task levels, child terminals and interactions determine status. Default operation does not depend on `session_state_changed`.
- Background completion holds `wake.expected` for five seconds across the notification-to-init gap. A completion during a turn anchors that grace at the result.
- Removing a task from the level set gives its terminal edge one second to arrive. The translator exposes that deadline through `nextDeadline()`. A tick or frame at or after it marks an unmatched task unknown, including ambient tasks. The engine schedules with `core.nextDeadline(state, translator.nextDeadline?.())`.
- Aborted results become interrupted, even with a stale `stop_reason`. Surviving background work still holds the thread open.
- SDK error metadata classifies provider failures. Ordinary assistant prose about connector authorization does not fail a turn.
- Spawn tool ids route child transcripts; native task ids route permissions. Spawn tool requests do not start child runs. A native task, child transcript or child permission establishes executing work; native permission aliases are joined before task registration. Terminal children accept transcript enrichment without reopening a run. Session lifecycle frames include a process UUID, so reused native ids after resume cannot collide with old turns or items.
- Root usage comes from the final result. Child input/output/cache counts come from assistant message usage. Repeated blocks refine the current message contribution rather than counting it twice. Task aggregate totals without an input/output split remain raw.

## Verification

All eight committed fixtures have expectations, replay through `@ace/adapter-testkit`, and were checked with its timeline CLI. The round-2 interrupt fixture ends with an interrupted root and a done thread at 19667 ms. A separate synthetic test guards an interrupt whose background shell survives.

Complete assistant blocks correlate with indexed unmatched stream indices. Separate nonstream blocks use native UUIDs and fixed-size content identities for retransmissions, preserving multiple paragraphs within one message. An aborted result closes partial streamed items.

Offline session tests run the real SDK against a synthetic local CLI process. They cover initialize, queued content, permissions, questions, plan approval/rejection, resume, task stops, cascade, cancellation, unexpected exit, engine abort, raw controls and malformed output. They never invoke an installed provider or a model. The opt-in `ACE_LIVE_CLI=1` test initializes only and supplies no prompt. It was not run for this change.

The review regressions were reproduced before fixing them. Twelve additional temporary production mutations were detected and reverted, including all five survivors reported by the review. See the PR description for the mutation evidence.

## Performance and integration

The translator retains identities and live control state, rather than raw transcript history. The first item payload remains on the item; subsequent raw payloads are emitted once as notice additions. Core and projection own the persisted transcript. Message matching uses per-kind queues and identity maps, and terminal task records release their native payloads.

Run the public-API benchmark with:

```sh
node --expose-gc packages/adapter-claude/benchmarks/translator.ts
```

It measures repeated messages, one long streamed message, and retained heap after 4,000 completed turns with separate 8-KiB strings. It starts no session or CLI. Measurements and the comparison with pre-review code are in the PR description; timing is not a gating assertion.

This review adds backward-compatible contracts to core and engine-api: queue sources, a provider deadline argument, optional translator deadline lookup and optional session root identity. Other adapters retain their existing defaults.

Core's existing background task API still ignores metadata enrichment on repeated starts. The adapter emits later metadata; changing canonical task enrichment remains a request for the core owner.

Unrecorded paths remain conservative: mid-turn steering is disabled. Native multi-select serialization, nested live cascade and plan approval have SDK-contract and synthetic subprocess evidence. New provider recordings require explicit user authorization and were not attempted.
