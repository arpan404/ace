# @ace/forge

Local GitHub PR operations through the user's installed, authenticated `gh`. No forge SDK, token configuration or hosted service. GitLab detection is available; its backend is a future implementation of `Forge`.

## Public API

- `detectRepository(runner, signal)` reads git remotes. Origin wins unless the caller selects a remote. `repositoryFromRemote` is the pure URL parser; custom forge hosts require an explicit mapping.
- `GitHubForge` implements `Forge`: `status`, `createPr`, `replyComment`, `requestReviews`, `merge`, `enableAutoMerge`, `logTail`. Pass repository, command runner and clock. The `command` option selects an installed `gh` executable.
- `mapPr`, `mapCheck`, `mapLegacyStatus`, `mapComment`, `mapIssueComment`, and `ciStatus` parse/map external data without I/O. Unknown statuses remain unknown and never imply success. Cancelled checks make CI failed.
- `ForgeStore` uses a caller-owned `node:sqlite` database. `link`, `getLink` and `unlink` manage one PR per thread. Relinking clears old feedback and queued work. Delivery identities persist until unlink or thread deletion; acknowledged payloads are removed. Use a file database in production. The database connection belongs to the daemon's serial actor.
- `ReviewLoop.poll` reads a linked PR, admits new failures/comments and drains its durable outbox through `AutoFixExecutor.enqueue`. The executor must deduplicate the supplied key atomically with its engine queue insertion, and resolve only after durable acceptance. A loop admits one poll at a time. The daemon owns one loop per scoped thread and owns relink/unlink ordering.
- `watchPr` runs serial polls. Inject `now`, abortable `wait`, `onStatus` and `onError`. It honours rate-limit deadlines, backs off transient failures, stops on merge/close and terminates on inaccessible or conflicting links. `onStatus` returns a bounded snapshot; the daemon applies its existing event/blob size policy before publishing.
- `createForgeToolkit` returns MCP definitions and a dispatcher for the four requested tools. The MCP server supplies trusted thread/repository/branch scope after authorisation. Create/link persist the association. Status/reply require the linked PR. Replies target inline review comments. Merge operations are deliberately separate API calls.

Wire schemas are exported from `@ace/protocol/forge`. They are additive contracts for the daemon and MCP workstreams; this package does not rewrite their command unions or instantiate an engine. The daemon must enforce thread ownership, route commands, persist returned event payloads, and call `store.unlink` when a thread is deleted. Review intents carry data for the engine's normal queue and approval rules. Review text and log content never authorise a tool action or merge.

## Creating a PR

Pass the thread's branch, base branch, title, summary, draft flag and `{ title, body }` template. Templates accept `{{title}}`, `{{summary}}`, `{{branch}}` and `{{threadId}}`. The MCP dispatcher checks the branch against its trusted scope. The caller must push the branch before creating the PR. There is no automatic retry of writes, including PR creation, replies and merges, because the server may have accepted a write whose response was lost. Inspect status before retrying.

`merge` and `enableAutoMerge` require the expected head SHA and merge method. GitHub decides branch protection and merge-queue policy. Auto-fix never merges on its own. Existing failing CI and actionable comments generate intents on the first poll. Resolved/outdated review threads and configured ignored authors do not generate intents. Changes to comment text generate a new identity; a new commit can generate new CI identities without replaying unchanged comments.

## Bounds and failures

JSON stdout is capped at 4 MiB per process, source data at 8 MiB per snapshot, each connection at 20 pages/2,000 records, and the ETag LRU at 128 entries/8 MiB. Typed projections duplicate only this bounded source data. Over-limit reads fail with `ForgeError("limit")`; they never return partial success. The pending outbox admits at most 2,000 intents globally, reads 32 at a time, and applies backpressure on overflow. In-memory diff indexes contain only the current capped snapshot. GitHub reads are serial to avoid bursts against secondary rate limits.

Job logs stream through a 16 KiB byte ring. Lines over 64 KiB are omitted, with a marker and truncation flag. Tokens are redacted before tail retention, including tokens split across chunks. Unknown provider fields stay in the redacted raw snapshot. `gh` handles login itself; ace neither reads nor emits auth credentials. Fixed errors discard stderr, raw errors and HTTP error bodies. Pattern redaction recognises GitHub token formats, bearer tokens and token/authorization assignments. Arbitrary application secrets with no recognisable format cannot be identified automatically.

Every child has a 30-second deadline and cancellation. The byte transport is local to this package because provider-kit's current readline probes buffer a whole unterminated line before their cap runs. POSIX process groups are killed on exit/cancel/deadline. Windows currently kills the direct child; a Job Object owner remains a platform-wide follow-up.

Run `bun run test packages/forge/src` for the fake CLI, real git/process and temporary SQLite tests. `bun run --filter @ace/forge bench` is non-gating and reports throughput and peak RSS for mapping, diffing, streamed tails and SQLite admission/lookup. Tests never contact GitHub or run coding-agent CLIs.
