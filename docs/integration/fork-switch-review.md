# Fork/switch integration contract after PR #69 review

The branch merges `origin/main` at c7ca5923, preserving ACP registry metadata,
dynamic capabilities and native coding configuration. Migration 10 accepts
either migration-9 owner (`acp` or `transitions`), adding only missing columns.
Migration 11 retains text revisions independently of the current item and uses
one indexed append target. Public-store tests cover both installed schemas.

Run/item `executionSource` is additive. Points without proven native ownership
use portable handoff. Adapters opt into supported `forkPoints`; an unsupported
point cannot be guessed from the current native session. End snapshots guard
and close the source through native opening. The new fork remains an independent
execution root, with lineage stored separately from its parent relationship.

Daemon portable forks and cross-provider switches now call
`@ace/context.portableContext` in production, including Cursor forks. This
facade delegates budget, selection and rendering to `@ace/handoff` and exposes
its manifest for persistence without an extra render/parse round trip. Rendered
text and byte count are evaluated only when requested. The caller supplies the
selected run/item cutoff, indexed inventory and bounded historical page; fork
acceptance grants the recipient that exact cutoff through `HandoffAccess`.
Origin uses the historical execution provider for forks and the outgoing provider
for switches. The public Cursor fake-provider regression follows the manifest's
MCP pointers after delivery and engine restart, retrieves full history, excludes
later source turns and denies unrelated history. Execution needs run at merge.

Cursor #67's SDK adapter remains a parallel PR. During integration, retain this
facade and use the daemon's `thread.fork` path for portable forks. Any SDK-specific
`handoffFrom` convenience must use the same cutoff/count/grant owner; it must not
restore an adapter-specific selection policy or invent a historical cutoff.

Preserve the client-gaps worker's additive create receipt, account/mode/options/
baseBranch fields and send model/options during its separate train merge. This
branch does not replace the organization-command service or edit `server.ts`.

Historical page/chunk access seeks immutable metadata and sequence-bounded byte
lengths. Historical shell suffixes use projection's shared whole-character UTF-8
byte-tail decoder before constructing the summary. Retired source bytes are retained until thread deletion. Missing legacy
prefixes fail visibly rather than substituting the current preview. Source
counts seek incremental ordinals; stream deltas write one length row and use the
existing chunk storage. Prepared statements have a fixed, constant query set;
no history-sized memory index is introduced.

Non-gating benchmarks are written in `packages/handoff/bench/selection.ts`,
`apps/daemon/bench/thread-transitions.ts` and
`apps/daemon/bench/history-revisions.ts`. The latter reports append, bounded count/page and UTF-8 shell suffix costs with 100 and 10,000 historical items. Ops/s, microseconds/op and
peak RSS are **unmeasured: needs run at merge**. Earlier feature regressions remain unexecuted. Under the owner's merge-conflict
exception, the Pi socket coexistence and protocol reference generation test files
passed after resolving the Pi merge. No full suite, probes, mutation runs,
benchmarks, provider prompts, recorder or CI checks were executed.

The legacy SQLite fixture builder removes newer append targets, immutable history
tables and their one-time marker before resetting the schema version. The
oversized-text upgrade case also guards indexed historical reconstruction and
subsequent appends. Genuine old database migrations remain unchanged.

The Pi merge retains both service factories, ready-service values, socket
registrations, public protocol entry points and documentation catalog entries.
Pi's provider-specific history controls and generic `forkSession` API currently
do not declare `forkPoints` or implement `SessionContext.fork`. Generic thread
forks therefore continue through the capability-gated portable path. Bridging
native point selection and opening lifetimes is a separate adapter change; this
conflict resolution does not invent that contract. The transition socket service
already uses the shared remote-access `DeviceScope` authorization API.
