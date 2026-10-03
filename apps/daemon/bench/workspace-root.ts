import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Thread } from "@ace/protocol";
import { Store } from "../src/store.ts";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";
const root = mkdtempSync(join(tmpdir(), "ace-root-bench-"));
const store = new Store(join(root, "events.sqlite"));
const workspaceId = store.createWorkspace(root, "Benchmark");
const thread = Thread.parse({
  id: "root-bench",
  workspaceId,
  provider: "codex",
  title: "Root",
  status: { state: "new" },
  createdAt: 1,
  updatedAt: 1,
});
store.appendEvents(thread.id, [{ type: "thread.created", thread }]);
// Persisted session roots are the public I/O boundary measured here; no provider is opened.
store.atomic((db) => {
  db.exec(
    "CREATE TABLE engine_sessions (thread_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, workspace_ready INTEGER NOT NULL)",
  );
  db.prepare("INSERT INTO engine_sessions VALUES (?,?,1)").run(thread.id, root);
});
const runtime = new WorkspaceRuntime(store, root, () => 1000);
try {
  const count = 100_000,
    start = performance.now();
  for (let index = 0; index < count; index++) {
    runtime.root(thread.id);
    runtime.hasOwnedWork(thread.id);
  }
  const elapsed = performance.now() - start;
  console.log(
    JSON.stringify({
      operation: "authoritative-root-and-terminal-ownership",
      opsPerSecond: (count * 1000) / elapsed,
      microsecondsPerOp: (elapsed * 1000) / count,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
} finally {
  await runtime.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
}
