# @ace/history-import

Read existing local CLI transcripts without starting a provider or changing its files. Node 24+ is required. Each service runs its index, parsers and archive SQLite in a worker; filesystem sampling uses batches of 16 files.

```ts
import { openHistory } from "@ace/history-import";
import { ThreadId, WorkspaceId } from "@ace/protocol";

const history = await openHistory({
  indexPath: "/home/user/.ace-next/history.sqlite",
  instances: [
    { id: "personal", provider: "claude", homeDir: "/home/user/.claude" },
    { id: "work", provider: "codex", homeDir: "/home/user/.codex-work" },
  ],
});
const scan = await history.scan(signal, (files) => reportProgress(files));
const page = await history.list({ type: "history.list", cwd: "/work/project", limit: 50 });
const source = page.sessions[0];
if (source?.support.status === "supported") {
  const threadId = ThreadId.parse(assignId());
  await history.importSession({
    sourceId: source.id,
    threadId,
    workspaceId: WorkspaceId.parse("workspace"),
    agentId: assignId(),
    at: clock(),
  });
  const items = await history.itemsPage({ threadId, limit: 200 });
  const context = await history.continuation(source.id, "resume");
  // Select the instance's environment before adapter.openSession(context).
}
await history.close();
```

The default import stays inside the worker and persists imported threads, agents, items and blobs in the private ace index database. Only commit publishes a thread. Cancellation, source changes, sink errors and crashes cannot publish a partial import. Duplicate source imports fail the archive's uniqueness constraint. Supply an `ImportSink` to use an engine-owned store instead. Its writes must remain bounded and transactional; commit is the visibility boundary. Never collect the stream into a full-history core projection.

`itemsPage` uses an exclusive sequence cursor and caps each page at 200 items or 1 MiB. `importedThread` and `importedAgents` read committed records. `readBlob` takes a blob ID, byte offset and limit up to 256 KiB. Large raw data uses ADR 0006's native `{blobRef, size, preview}` form. Raw records are attached once across text fragments; canonical metadata is capped and archive publication refuses any item above 256 KiB. Text blocks become 4,096-character items. Native records above 1 MiB remain lossless blobs with a notice; they are not decoded as canonical messages. Message counts stay labelled sampled when records cannot be decoded.

JSONL scans read at most 64 KiB at each end, and label long-file counts `sampled`. A complete stable decode upgrades the count to `exact`. Warm scans stat paths but read no unchanged transcript content. `ScanResult.reads` reports content-reader opens, including databases. Tests independently observe real FileHandle, readFile and stream reads rather than trusting this counter. Truncated or malformed small samples never claim an exact count. Removed files are pruned only after a completed instance scan. Database entries are stored independently and deduplicated when listing, so removing a Codex rollout reveals its database fallback. Reopening reconciles registered instance IDs, homes and providers before serving any reads. Workspace lists show root sessions; sidechain transcripts are imported with their parent. Sidechain activity contributes to the parent session's recency. One operation is in flight, and imports pull at most 16 bounded packets before awaiting sink writes. Concurrent requests reject instead of queuing.

Claude project logs and subagent sidechains, legacy Codex rollouts, Codex state metadata, OpenCode v1 SQLite and legacy JSON storage are supported. Unknown native records remain raw notices. Codex compressed/paginated/database-only history and OpenCode v2 history and SQLite scalar records above 1 MiB need provider-owned materialization or a new mapper. Cursor returns an unsupported reason because readable transcripts omit results and TUI chats cannot load through ACP. Claude imports follow the selected `parentUuid` chain, using a private disk-backed ancestry index. Codex and Claude results are matched by native call ID, complete their canonical call, and link output notices through `toolCallId`. Full shell output is stored as a bounded stream. Historical calls without recorded completion remain pending; thread state stays new and agents unresponsive until native state is reconciled.

Provider databases open read-only. Live homes first stream a private database and WAL snapshot under the ace index directory, with fingerprint checks. This also preserves source shared-memory bytes, which a direct read-only SQLite connection can change. Changed databases therefore incur O(database bytes) copying; unchanged scans skip the copy. Active rollback journals return a retry reason. Set `offlineSnapshot: true` only for a checkpointed, inactive copy; it enables immutable mode and refuses WAL/journal files. Homes and the index path are host-local configuration. Homes must be absolute, instance IDs unique, and the index outside all provider homes. Symlinks, special files and escaped paths are rejected or skipped. The reader never opens provider auth/config files.

`continuation(sourceId, "fork", nativeFork)` requires an injected native operation which returns the provider's new ID. This package does not launch a CLI. The engine owns capability checks, live-writer reconciliation, instance selection and lifecycle. Schema-only wire contracts live at `@ace/protocol/history`; the daemon binds them to authenticated handlers. The CLI scans default homes on startup or uses `ACE_HISTORY_INSTANCES`, a host-local JSON array of `{id, provider, homeDir}`. Programmatic callers pass the sixth `startDaemon` argument. Read scope permits `history.list`; operate scope is required for `history.scan`, `history.import`, and `history.continue`. Import validates the workspace against the source cwd, publishes the private archive transactionally into the daemon event store in a second worker, then deletes staging rows. Existing subscriptions and `items.page` / `output.read` expose imported history like any other thread.

A `HistoryAdapterPort` resolves the adapter already bound to the instance home and sends its live frames/exits to the engine. `history.continue` opens or reuses that adapter session, passes the native resume or injected fork ID, sends the requested input, and persists the returned native ID. Subsequent forks and resumes use the persisted root-agent identity, including after native exit or daemon restart. No launch environment arrives from a socket client. Sessions are capped at 64 and closed on daemon shutdown. Client disconnects do not abort an active provider session. A fork request on an active session is rejected before invoking the native operation, and a session which exits during startup is never cached. Without a registered adapter and frame consumer, continuation returns an explicit unsupported result. ADR 0007's engine and concrete adapter factories are still separate workstreams; the routes and transactional storage are implemented here.

Before the event-store publication lease, the host's `HistoryAdapterPort.pausePersistence(signal)` must drain current persistence and pause frame/exit callback ingress for all its engine writers with bounded transport backpressure. It returns an awaitable release operation. The daemon releases the Store lease after commit/rollback and notifications, then calls release in `finally`, including cancellation. A host with active continuations but no pause port cannot publish another import; it refuses before locking Store, keeps the live callbacks working and retains private staging for retry. No live frame or exit is deliberately dropped and no unbounded queue is used. Hosts with other engine-owned writers must supply the same global barrier even if no history continuation is active. The concrete engine/adapter owner implements transport flow control at this injected boundary.

`close()` aborts pending work, returns suspended generators, rolls back private archive writes, closes SQLite handles and removes scratch files before terminating the worker. Async scan progress callbacks are acknowledged before scanning resumes. `openHistory` accepts an injected worker factory for instrumentation. `openArchiveReader`, `findImported`, and `deleteImported` support bounded engine publication and staging cleanup.

The owner requires tests to run once at merge. During this review round, run only `bun run fmt`, `bun run lint`, `bun run typecheck` and `bun run check:size`. Behaviour tests, mutation cases and revised performance measurements need run at merge. The benchmark scripts create synthetic temporary homes; they never read real accounts or spend provider quota. `bench/scan.ts` covers 5,000 files and a 20,000-message transcript. `bench/native-stores.ts` covers SQLite snapshots and legacy ordering. `bench/tools.ts` covers call/result correlation, and `apps/daemon/bench/history.ts` covers selected ancestry plus publication through an authenticated socket. `apps/daemon/bench/history-live.ts` covers publication backpressure with 2,000 live frames and an exit. See [historical benchmark baseline](BENCHMARKS.md) and [mutation cases](MUTATIONS.md). Shared file and lineage contracts for ADR 0018 live in `@ace/native-session`.

Live SQLite scans copy the main database and a fixed WAL prefix into private
scratch storage. A streamed SHA-256 comparison verifies that the copied prefix
has not changed, while allowing newer commits to append. Main-file changes and
WAL resets retry up to three attempts, then preserve cached rows with a retry
reason. Scans publish the consistent private snapshot even when the provider
commits during pagination; the prior fingerprint keeps newer data eligible for
the next scan. Source databases and WAL shared-memory files are never opened by
SQLite. Display titles are selected with a bounded SQL expression; a large title
does not reject the whole Codex inventory. Identity and cwd bounds remain enforced.
