# Pi adapter

Drives the user's installed Pi 0.85.1 with bounded RPC over stdio. No provider
SDK or login is embedded. See [research](../../docs/research/providers/pi.md)
and [ADR 0050](../../docs/adr/0050-pi-local-rpc-adapter.md).

The public API is `createPiAdapter`, `createPiTranslator`, `openPiSession`,
`piCapabilities`, `piProfile` and `piPermissionArgs`. A `PiSession` implements
ADR 0007 and adds `fork(entryId?)` and `rollback(entryId)`. Fork returns a native
identity-bearing session reference and restores the source process. A selected
branch must contain an assistant message: Pi otherwise defers saving the fork.
A bounded native-entry preflight refuses root clones and forks before the first
user while preserving the live source. Failed fork-file validation restores the
source before returning the error.
`nativeSessionFile` exposes its native path. Saved references retain the expected
header ID; legacy raw paths are accepted and upgraded on reopen. Missing, empty
and replaced history fails resume. Headers are limited to 64 KiB; missing versions
mean native v1. Native conversation navigation
never restores files. The generic adapter `forkSession` also cold-clones a saved session, reading only
a bounded header for its cwd and granting no thread MCP lease. Fork/switch
integration can use these methods when capability-gated; this package does not manufacture a canonical child thread.

The daemon Pi service registers `pi.control` and `pi.result` through the socket
registry. Profile needs read scope; fork and rollback need operate scope, thread
access and a settled whole tree. A live session is required for native controls.
`DaemonOptions.pi` selects executable, injected runtime and default permission
policy. Accounts isolation remains unavailable for Pi until the accounts package
has an audited Pi home strategy; no provider credentials are read by ace.

Ordinary operation preserves Pi skills and extensions. Native read-only mode
selects read/search tools, disables user extensions and omits ace MCP tools.
Supervised and auto-accept-edits fail before spawning, because 0.85.1 has no such
native policies. This allowlist is not an OS sandbox.

The explicit ace extension forwards scoped ace MCP tools through the existing
loopback server. Its lease lives only in process environment and memory, is
redacted before frame persistence and is revoked on every close/exit/failure.
Only `agents` and `notify` are granted by the default daemon integration. It
registers native conversation navigation and appends a custom marker before
acknowledging success. The marker preserves the active branch across restart and
fork restoration, including navigation to root.
The adapter verifies the command's source path before using it.

Caps are 1 MiB per native frame, 2 MiB queued writes, 64 pending RPC commands,
256 live tools/final content blocks, 128 pending dialogs, 128 live daemon sessions,
4096 transient entries per fork preflight, 8 concurrent cold forks, 8 controls per socket and 128 replay receipts. Overflow terminates
transport or keeps completion uncertain; live state is never silently evicted.
MCP forwarding has 16 calls, 256 tool descriptors, 64 KiB arguments and 1 MiB
response bodies. No transcript/history buffer lives in the adapter. Final envelopes are retained
once, with block-local raw on remaining items; cumulative output joins only its
new suffix. Settlement is deferred while native dialogs are pending.

Synthetic behaviour tests, mutation cases and benchmarks are written but **not
executed**. Tests run once at merge. The non-gating benchmark is
`bun run --filter @ace/adapter-pi bench`; ops/s and peak RSS need a run at merge.
`bench/scaling.ts` also covers final raw serialization and cumulative multi-block
output at increasing sizes. Measurements remain unexecuted.
Recorder recipes need separate owner approval and are not wired to default runs.
