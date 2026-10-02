# 0018: Provider accounts, quota and session portability

Date: 2026-10-02. Status: accepted.

## Context

Users can exhaust one subscription while other subscriptions still have capacity. A session must retain its full native history when moved. The competitor inventories describe t3code account selection and pooled usage, Codex thread forks, Claude parallel sessions, and Cursor handoffs. They do not establish a safe cross-account lineage-copy contract. ace needs explicit instance identity and migration safety rather than treating a provider as one global login.

ADR 0002 applies. Accounts are local CLI config homes. ace never reads auth files, accepts a credential, or copies credentials. Provider research in `docs/research/providers/` and primary provider sources define the supported formats; competitor implementations are not used.

## Decision

Add `@ace/accounts`, with pure quota folds and scheduler policy, a small SQLite registry, CLI login/discovery shells, and streamed migration I/O. An instance is `{id, provider, label, homeDir, env}`. IDs are caller supplied. Homes must be absolute, distinct, local directories. Persist only allowlisted directory selectors, never arbitrary environment variables. Build process environments from the instance and the caller's environment, removing provider auth overrides so ambient credentials cannot silently defeat account selection.

Codex uses `CODEX_HOME`. Claude uses `CLAUDE_CONFIG_DIR`. OpenCode uses XDG data/config/state/cache roots, with the actual provider home at `XDG_DATA_HOME/opencode`. Cursor uses `CURSOR_DATA_DIR`, confirmed by the installed hidden `--data-dir` flag and provider research. These are instance configuration, not provider credentials. Discovery finds conventional sibling homes without opening auth files. Login probes reuse provider-kit discovery under instance environments. `ace accounts add` runs the installed CLI's interactive login with inherited terminal streams, then probes status. It records a logged-out account before login so a cancelled login can be retried.

Quota snapshots retain at most 32 named windows per instance and the latest sanitized usage counters. Provider frames are parsed leniently, and the ingest result returns the original raw fact to its caller, including unknown variants. Raw frames are never persisted in the account registry. Unknown/resetless exhausted windows stay blocked until fresh facts arrive. A window expires at its reset instant. Older updates cannot overwrite newer state. Logout takes precedence over quota, and successful login does not erase limits. A usage-limit clock string is interpreted in an explicit IANA timezone, using the next occurrence and rejecting ambiguous/nonexistent civil times conservatively.

`pickInstance({provider, role, estimatedLoad})` selects a logged-in, available instance with enough headroom. Estimated load is percentage points, not tokens. Prefer the earliest active window reset; tie-break on headroom and instance ID. Near-limit accounts are excluded. Role policy requests speed, while capability data decides whether a model supports it: Codex `model/list.serviceTiers` must advertise `priority`; Claude fast mode must be explicitly supported for the chosen model. No catalog is guessed.

## Migration and safety

The engine must stop the source tree, release its provider process, and hold a quiescence lease for every copied native session through publication. `migrateSession` requires an injected lease boundary. It must also exclude independent provider processes; absence of a lock file alone does not prove inactivity. Migration checks Codex `thread-writer-locks/<id>.lock` for every ancestor and refuses even stale locks. This avoids modifying the source to probe or clean up locks. Claude callers must exclude live foreground/background writers and sidechains through the same lease. No automatic migration runs while work is active.

For Codex, discover rollouts by metadata, not only filename. Walk all `forked_from_id`, `parent_thread_id`, and differing root `session_id` references with a bounded graph and detect cycles/missing ancestors. Copy the full files under their native relative paths. Legacy JSONL is supported initially. Compressed, paginated and `history_base` rollouts return `unsupported`: those formats require provider-owned materialization and SQLite projections, and copying an account-wide database would overwrite unrelated destination sessions. Validate compatibility with installed `codex exec fork <id>` without a prompt in an empty synthetic home.

For Claude, copy the project JSONL and all files under its `<id>/subagents/` directory, preserving the project slug. Resume uses the original native ID in the destination. OpenCode export/import is promising but its documented export does not establish complete child/permission fidelity or writer exclusion. Cursor ACP uses `acp-sessions/<id>/store.db`, and resume/fork support is incomplete. Both return `unsupported` with a reason rather than claim full-history migration.

Every source file is streamed into a private staging directory on the destination filesystem. Reject symlinks, traversal, special files, overlapping homes and existing destination files. Check source stat fingerprints and locks again before publishing. Atomic hard-link publication prevents overwrites and exposes only complete files; publish ancestors and sidechains before the root. On failure, roll back files created by this operation. A host crash can leave complete orphan ancestors or staging directories, never a partial root transcript. Multi-file publication is not a filesystem transaction. Callers serialize migration with destination sessions through the lease. Source bytes and metadata are never changed by ace.

## Protocol and wire additions

Add schema-only account definitions in a new protocol file and an additive `./accounts` export. Requests and responses cover `accounts.list`, `accounts.status`, and `accounts.migrate`; login and home registration stay host-local CLI operations. Public snapshots contain ID, provider, label, auth and quota, not paths or environment. A migration response reports `migrated`, `unsupported`, or `refused` and a safe reason. Engine integration will bind this contract to authenticated daemon routes and instance-aware adapters; this package does not rewrite the shared wire union during parallel development.

## Security

No provider credentials cross ace storage or the wire. Login output goes directly to the user's terminal and is not captured. No shell interpolation. SQLite and staging files use private modes. Session transcripts can contain secrets, so copies stay under user-owned local homes with private permissions. Paths never come from a remote request. Native IDs are validated before filesystem access. Unknown provider raw facts stay with the adapter's existing raw-data policy, not a second unbounded log here.

## Performance

Quota ingestion is O(window change), capped at 32 windows; registry size is capped at 256 instances. Scheduling scans at most that cap and only on assignment. Reuse prepared SQLite statements. File discovery and lineage planning are cold paths with explicit file/depth limits; copy streams use fixed-size buffers and sequential backpressure. Benchmarks measure quota folding and scheduling throughput plus peak RSS. No history scan occurs on stream deltas.

## Testing

Public API tests use temporary SQLite homes and executable fake CLIs for account-specific discovery/login. Synthetic native rollouts cover depth-three lineage, missing/cyclic ancestors, format refusal, locks, live lease refusal, destination collisions and unchanged source hashes. Claude tests cover root transcripts and sidechains. Quota tests cover both provider payload families, unknown payloads, stale updates, multiple windows, logout, resets, timezone midnight/DST and limit strings. Scheduler tests cover reset ordering, exhausted/near-limit exclusion, headroom and supported speed tiers. At least eight production mutations must each fail a behavior test before delivery. Real CLI verification never sends a prompt or runs the recorder.

## Primary references

- [Codex provider research](../research/providers/codex.md), including rollout/session metadata and thread-store source paths.
- [Claude provider research](../research/providers/claude-code.md) and [fast mode](https://code.claude.com/docs/en/fast-mode).
- [OpenCode provider research](../research/providers/opencode.md) and [configuration](https://opencode.ai/docs/config/).
- [Cursor provider research](../research/providers/cursor.md) and [CLI configuration](https://cursor.com/docs/cli/reference/configuration).
