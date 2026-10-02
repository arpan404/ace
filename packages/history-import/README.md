# @ace/history-import

Read existing local CLI transcripts without starting a provider or changing its files. Node 24+ is required. Each service runs its index, parsers and archive SQLite in a worker; filesystem sampling uses batches of 16 files.

```ts
import { openHistory } from "@ace/history-import";
import { ThreadId, WorkspaceId } from "@ace/protocol";

const history = await openHistory({
  indexPath: "/home/user/.ace/history.sqlite",
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

`itemsPage` uses an exclusive sequence cursor and caps each page at 200 items or 1 MiB. `importedThread` and `importedAgents` read committed records. `readBlob` takes a blob ID, byte offset and limit up to 256 KiB. Large raw data currently uses `{blobRef, size}` inside `RawPayload.data`, pending the native blob union on the ADR 0006 branch. Text blocks become 4,096-character items. Native records above 1 MiB remain lossless blobs with a notice; they are not decoded as canonical messages. Message counts stay labelled sampled when records cannot be decoded.

JSONL scans read at most 64 KiB at each end, and label long-file counts `sampled`. A complete stable decode upgrades the count to `exact`. Warm scans stat paths but read no unchanged transcript content. `ScanResult.reads` counts actual content-reader opens, including databases. Removed files are pruned only after a completed instance scan. Workspace lists show root sessions; sidechain transcripts are imported with their parent. Sidechain activity contributes to the parent session's recency. One operation is in flight, and imports pull at most 16 bounded packets before awaiting sink writes. Concurrent requests reject instead of queuing.

Claude project logs and subagent sidechains, legacy Codex rollouts, Codex state metadata, OpenCode v1 SQLite and legacy JSON storage are supported. Unknown native records remain raw notices. Codex compressed/paginated/database-only history and OpenCode v2 history and SQLite scalar records above 1 MiB need provider-owned materialization or a new mapper. Cursor returns an unsupported reason because readable transcripts omit results and TUI chats cannot load through ACP. Historical calls without recorded completion remain pending; thread state stays new and agents unresponsive until native state is reconciled.

Provider databases open read-only. Live homes first stream a private database and WAL snapshot under the ace index directory, with fingerprint checks. This also preserves source shared-memory bytes, which a direct read-only SQLite connection can change. Changed databases therefore incur O(database bytes) copying; unchanged scans skip the copy. Active rollback journals return a retry reason. Set `offlineSnapshot: true` only for a checkpointed, inactive copy; it enables immutable mode and refuses WAL/journal files. Homes and the index path are host-local configuration. Homes must be absolute, instance IDs unique, and the index outside all provider homes. Symlinks, special files and escaped paths are rejected or skipped. The reader never opens provider auth/config files.

`continuation(sourceId, "fork", nativeFork)` requires an injected native operation which returns the provider's new ID. This package does not launch a CLI. The engine owns capability checks, live-writer reconciliation, instance selection and lifecycle. Schema-only wire contracts live at `@ace/protocol/history`; binding them to authenticated daemon handlers remains the engine integration boundary. No daemon routes are installed by importing this package.

Run `bun run test -- packages/history-import`, `bun run --filter @ace/history-import bench`, and the repository's `bun run check`. The benchmark creates 5,000 synthetic files and a 20,000-message transcript in a temporary home; it never reads real account homes or spends provider quota. The `bench/native-stores.ts` script also measures SQLite snapshots and legacy storage ordering. See [benchmark evidence](BENCHMARKS.md) and [mutation verification](MUTATIONS.md). Shared file and lineage contracts for ADR 0018 live in `@ace/native-session`.
