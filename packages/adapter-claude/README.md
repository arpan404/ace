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

The recorded baseline is Claude Code 2.1.286. Older or unrecognized versions advertise no verified capabilities, and session opening rejects them. Newer versions retain the baseline capabilities. Steering, fork and file rewind remain disabled because their behavior is outside these recordings. A `steer` send rejects with an actionable error; queued sends use SDK priority `next`, with queue ownership remaining in the engine.

`resolve` supports approval options, question answers keyed by question text, and plan approval/rejection/cancellation. Approval suggestions are returned through `updatedPermissions`. Approving a plan returns allow and sets permission mode to `default`. A withdrawn request cannot be answered. `stopTask` accepts native task ids or translator task keys. Interrupting a child stops that task; explicit cascade also stops its registered descendants. A root cascade stops all live registered tasks. Closing ends input, closes the SDK, stops the owned process group and drains the pump.

## Status and identity

- Turn ends, background task levels, child terminals and interactions determine status. Default operation does not depend on `session_state_changed`.
- Background completion holds `wake.expected` for five seconds across the notification-to-init gap. A completion during a turn anchors that grace at the result.
- Removing a task from the level set gives its terminal edge one second to arrive. The next translator tick at or after that deadline marks an unmatched task unknown.
- Aborted results become interrupted, even with a stale `stop_reason`. Surviving background work still holds the thread open.
- SDK error metadata classifies provider failures. Ordinary assistant prose about connector authorization does not fail a turn.
- Spawn tool ids route child transcripts; native task ids route permissions. Late task registration links the same child. Session lifecycle frames include a process UUID, so reused native ids after resume cannot collide with old turns or items.
- Root usage comes from the final result, avoiding repeated assistant-message usage. Child aggregate usage lacks the required input/output split and remains raw.

## Verification

All eight committed fixtures have expectations, replay through `@ace/adapter-testkit`, and were checked with its timeline CLI. The round-2 interrupt fixture ends with an interrupted root and a done thread at 19667 ms. A separate synthetic test guards an interrupt whose background shell survives.

Complete assistant blocks correlate with their stream indices, preserving thinking and text as separate items. An aborted result closes partial streamed items.

Offline session tests run the real SDK against a synthetic local CLI process. They cover initialize, queued content, permissions, questions, plan approval/rejection, resume, task stops, cascade, cancellation, unexpected exit, engine abort, raw controls and malformed output. They never invoke an installed provider or a model. The opt-in `ACE_LIVE_CLI=1` test initializes only and supplies no prompt. It was not run for this change.

Eleven temporary production mutations were detected by behavior tests and reverted. See the PR description for each mutation and its failing behavior.

## Shared-contract requests

1. Core currently ignores a repeated `background.started` while its task is running. Claude's level arrives before its edge, so later tool/child links, ownership and output-path metadata cannot enrich that first canonical task. The tree and status remain correct for the committed fixtures. Request: allow enrichment without restarting the task or creating another historical task.
2. ADR 0007 has no translator deadline query. The one-second missing-edge fallback runs on the next engine tick or frame time, which can be later than one second. Request: expose the translator's next deadline and combine it with `core.nextDeadline` in the engine. No session-side status timer duplicates this logic.
3. Core exposes one queue counter for both engine-held input and native queued turns. An unchanged native zero never overwrites engine queue state here. A native nonzero-to-zero transition concurrent with engine queueing still needs a shared source-aware queue contract.
4. A permission with a native child id before _both_ its spawn item and task binding uses a provisional child. If the spawn item already created another unbound child, core has no identity-merge fact for the later join. The recordings bind tasks before child permissions; the synthetic late-registration test covers the permission-first path. Request: define reconciliation for the ambiguous multi-placeholder case rather than guess an owner.

Unrecorded paths remain conservative: mid-turn steering, multi-select answer serialization, nested live cascade behavior and plan approval were not exercised against a real CLI. Their tests use the SDK's declared contract at the fake CLI boundary; new recordings require explicit user authorization.
