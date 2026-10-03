# Cursor SDK recordings

The scenario catalog does not authorize a recording. Recording requires explicit
owner approval, using SDK **1.0.35** and **composer-2.5**. Existing
Cursor ACP recordings and the generic recorder CLI remain unchanged.

## Approved batch driver

The owner-approved 2026-10-03 batch is invoked with:

```sh
bun run record:cursor-sdk --owner-approved-2026-10-03
```

`src/record-cursor-sdk.ts` requires the isolated `cursor-fixture` SDK store at
`~/.ace-fixtures/cursor-sdk`, already signed in through the daemon. It rejects a
launch-environment API-key override. It runs eligible scenarios sequentially,
with injected clock/IDs/environment and a three-minute abort cap per scenario.

Before a provider opens, it reserves `recording-report.json` with exclusive
creation. Each attempt is recorded durably before launch, including incomplete
attempts. Re-running the batch in that directory fails, even after interruption.
Neither a failed attempt nor an abort authorizes another try.

SDK 1.0.35 exposes `autoReview` as a request option whose documented behavior
depends on the backend classifier feature. Its public API does not expose an
account/backend capability query. The executable therefore skips restricted
scenarios until that availability is independently verified. It does not force
development feature gates or treat the option itself as evidence. The reusable
batch function accepts verified setup through the existing recorder dependency
contract. MCP scenarios also require a real storage/tools-owner lease factory;
no static bearer or SDK custom tool substitutes for that owner.

The report records complete, incomplete and skipped outcomes, elapsed milliseconds
and reasons. A complete recording remains an observation for owner review,
rather than an automatic conformance verdict.

`@ace/recorder/cursor-sdk` exports `recordCursorSdkScenario`, `cursorSdkPlan`,
`cursorSdkRecordingPlan` and the bounded capture sink. The scenario driver is
explicitly invoked through this API; generic `record` does not select it. It
parses a matching `{ scenario, approved: true }` authorization before creating
files or opening any provider. Authoring this API does not authorize invoking it.

Before an approved run, the owner supplies:

- An absolute capture path under `fixtures/cursor-sdk/1.0.35/composer-2.5` (or a
  review staging directory); the sink creates with `wx` and never overwrites.
- A fresh isolated fixture instance `{ id, homeDir }`, confirmed by
  `freshFixtureInstance: true`. SDK sign-in in that home is a separate owner
  operation. The recorder never signs in, reads credentials or copies stores.
- Injected clock, IDs, launch environment and an overall abort signal. A time cap
  aborts an incomplete recording; it never establishes task completion. SDK
  hosts retain their separate heap, IPC, checkpoint and shutdown limits.
- Verified Auto-review availability for restricted scenarios. Full access is
  selected only for `full-access`; its header declares sandbox/Auto-review off.
- For `restricted-mcp` and `mcp-image`, a fixture thread/instance-scoped lease
  factory through the adapter's `mcp` option and the existing MCP storage/tools
  owner. Its synthetic thread/history must be registered with that owner. The
  driver refuses absent setup before sending; it cannot invent native child
  attribution or substitute privileged SDK custom tools.

The driver creates/removes its own disposable git workspace. It records the
selected-home SDK model catalog before the turn, SDK method/stream/delta/result
boundaries, blob/output chunks, native identities, host lifecycle notes and
checkpoint snapshots supplied by resume. It emits monotonic `captureSeq` plus
the source `threadId`; SDK boundary/ObserveRun offsets remain separate.
Environment values never enter the request/header, and redaction uses the
selected launch environment before writing model metadata and frames. Auth
channels, auth envelopes and browser challenges are excluded.

Ordinary scenarios wait for canonical whole-tree settlement through
`translate -> core.apply`. Background-child recording adds the planned parent
follow-up. Interrupt waits for an observed tool boundary. Steering waits for
live root text, cancels/restarts through the public session API, and requires two
native SDK segments in one ace run. If the root finishes first, the attempt is
incomplete; another quota-spending attempt requires separate approval.

Close/resume captures two turns with the same thread/native identity and a
durable callback cursor. Portable fork closes/preserves its source and creates a
fresh SDK agent with a budgeted `@ace/handoff` manifest. It never copies SDK/ACP
opaque stores or resumes a source task ID. Source capture remains in the same
artifact with its own thread identity and exposes omitted context.

The final `sdk-scenario-analysis` row reports observed kinds, native/ace run
identities, checkpoint offsets, tree status, child fidelity/background/read-only
policy and explicit evidence limits. **Observed is not a conformance verdict.**
Owner review of these observations establishes fixture expectations; missing
lifecycle evidence remains unresolved. Aborted/failed recordings are marked
incomplete and the driver throws, preventing automatic promotion or retry.

Bounds: 256-KiB frame admission, 32 queued writes/1-MiB pending bytes, 32-MiB
recording/evidence bytes, 16,384 frames per thread and 2,048 identities per index.
Canonical state is retained only within that finite capture budget; raw frames
stream to disk and are not collected in memory. Production certified payloads
are reused across capture, translation and evidence rather than cloned twice.
Overflow fences the recording visibly. SDK-internal/helper memory and actual
sandbox/cancellation behavior still need approved evidence and merge-time runs.

Offline public-API guards substitute only the SDK/provider service and catalog;
they retain real disposable repositories, file streams, translator and core.
They cover authorization refusal, fail-closed setup, selected home, redaction,
checkpoint continuation, fresh portable identity and unresolved background work.
They have **not been executed (tests run at merge)**. Neither the recorder nor
any Cursor prompt was run during implementation.
