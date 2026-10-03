# @ace/adapter-opencode

OpenCode CLI **2.0.22** through the official `@opencode/client@2.0.22` public Promise root. The adapter discovers the user's installed CLI and uses its existing login. It never invokes credential/login/config APIs, embeds a runtime, or hosts a provider service.

```ts
import { createOpenCodeAdapter } from "@ace/adapter-opencode";
const adapter = createOpenCodeAdapter();
const session = await adapter.openSession({
  threadId,
  rootKey,
  cwd,
  model: "opencode-go/muse-spark-1.3-contributor",
  onFrame,
  onExit,
  signal,
});
await session.send([{ type: "text", text: input }], "queue");
await session.close("idle");
```

One adapter instance shares an ace-owned `serve --stdio --hostname 127.0.0.1 --port 0` process. Stdin remains open as its lease. Readiness must be JSON containing a credential-free loopback URL; `/api/info` must match the discovered version and owned PID, and `/openapi.json` must contain the required operation IDs. An injected ephemeral `OPENCODE_PASSWORD` authenticates transport. Passwords, authorization headers and process startup logs never become frames or stored evidence. Provider-kit owns spawning and bounded shutdown.

Account environments use one owned server per account instance, shared by its sessions. Different account instances remain isolated. Reusing an instance with a changed environment is rejected; cancelling one session does not stop its peers. Closing the adapter closes its sessions and owned processes, and closes externally attached sessions without stopping their server. Observed frames carry the shared immutable `ProviderPayload` certificate; its 1 MiB observation limit can reject a response even when it fits the transport's 2 MiB JSON limit.

Only the inspected release is supported. V1, unreviewed future versions, HTML fallbacks and incomplete specs fail startup. This conservative gate can be widened after a contract review. ADR 0047 (the proposal originally called 0043) remains **Proposed**; implementation does not change its status.

`ProviderAdapter` and `ProviderSession` remain the public engine boundary. Native execution boundaries define turns. Step completion, prompt admission, interrupt acknowledgement and root completion do not settle tools, descendants, interactions, inbox work or native background shells. Permission `always` means a persisted project grant. Known question forms retain field keys, multi-select answers and optional dismissal feedback; generic forms use canonical elicitation. Plan review, fork creation and file rewind remain disabled. Resume, steering, transcripts, usage, images and background control are implemented from the source-confirmed v2 contracts, but await owner-approved live certification. Cascade interrupts are ace's verified child-first traversal plus owned-shell removal; they are not a claim about native cascade behavior.

The official event subscription owns parsing and its shared upstream connection. Ace supplies tighter byte limits, activity-based transport liveness and one reconnect owner. Comment activity refreshes transport without creating agent work. Transient loss retains interaction uncertainty. Confirmed location shutdown expires permissions/forms for verified owners, blocks further actions in that location and preserves unresolved work. Replacement streams open before two bounded snapshot passes; sends wait behind recovery. Durable aggregate sequence gaps request snapshots, while the first observed sequence establishes a baseline, including inherited fork prefixes. Logs are never treated as retained replay evidence.

Recovery reads verified info/children, active metadata, opaque message pages, session permissions/forms/inbox and location-scoped shells. Foreign roots, forks, projects, global forms and shells without session metadata are excluded. A known location move requires a fresh ownership check. Newer scoped work beats staged idle/absence snapshots. Mutable live tool messages are refreshed alongside the incremental history head; matching message/ordinal snapshots suppress only covered deltas, while later suffixes and other ordinals are replayed. Positive running evidence is applied before buffered terminals. Child recovery traverses its ownership index rather than scanning the whole tree per node. Recovery overflow or inability to prove completeness fails closed; an external attachment is left disconnected and its process is never stopped.

Bounds include 128 consumers, 1,024 sessions/interactions/inputs, 2,048 live tools/shells/jobs, 1 MiB SSE records, 2 MiB JSON responses, and 4,096 events/8 MiB recovery buffering. Ownership evidence for unknown sessions is capped at eight concurrent ancestry lookups, 32 events per candidate and 1 MiB total. History reads at most 512 pages of 128, retains opaque cursor order and stops at its previous head. Maps at capacity reject further work rather than silently dropping live evidence.

HTTP admissions serialize with at most 64 waiters; execution and work queues remain owned by the engine and native inbox. The optional engine command ID is correlated locally with the native input ID so a late admission cannot acknowledge a newer send. Uncertain network receipts trigger reconciliation without an automatic resend. A canonical, non-stoppable uncertainty task keeps the thread unsettled without double-counting the engine queue; empty inbox snapshots alone cannot prove rejection. Recovered idle outcomes must be newer than the active execution's idle baseline and creation time before settling it.

`discoverOpenCodeModels(options, directory, signal)` provides an owned metadata-only lifecycle to `@ace/models`; normalization, login revision and cache ownership remain there. `OpenCodeServer` and `SessionOwnership` are public utilities for the recorder, which uses the same transport and ownership rules. Explicit `attach` accepts a pre-discovered loopback URL and transport authorization; it never calls `Service.ensure`, replaces a user's service, or gains process ownership.

V1 recordings and their test-only implementation remain under `fixtures/opencode/1.18.33` and `src/testing/v1`. They are historical evidence, not v2 certification. See [VERIFICATION.md](VERIFICATION.md) for the merge gate and recording candidates.

The existing daemon registry already consumes this public factory. Review/verifier workers consume its version-gated capabilities; plan review stays off. The history importer already detects v2 `session_message` storage and reports it unsupported (ADR 0033); this migration does not relabel legacy SQLite transcripts as v2 imports.
