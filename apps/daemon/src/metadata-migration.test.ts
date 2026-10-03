import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Thread } from "@ace/protocol";
import { Store } from "@ace/daemon";
import { afterEach, expect, test } from "vitest";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});
const acp = { acpAgentId: "registry-agent", installationId: "installation", instanceId: "account" };
const transition = {
  execution: { provider: "codex" as const, model: "remembered-model", options: {} },
  lineage: {
    parentThreadId: "parent",
    parentAgentId: "root",
    point: { type: "turn" as const, runId: "parent-run" },
    mode: "portable" as const,
    lossy: true,
  },
};
test.each(["acp", "transitions"] as const)(
  "an installed migration-9 %s database preserves its metadata and admits the other owner",
  (legacy) => {
    const home = mkdtempSync(join(tmpdir(), "ace-metadata-upgrade-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const path = join(home, "events.sqlite");
    let store = new Store(path, undefined, { now: () => 1 });
    cleanup.push(() => store.close());
    const workspaceId = store.createWorkspace(home, "Workspace", 1);
    const first = Thread.parse({
      id: "existing",
      workspaceId,
      title: "Existing",
      provider: legacy === "acp" ? "acp" : "codex",
      status: { state: "new" },
      createdAt: 1,
      updatedAt: 1,
      ...(legacy === "acp" ? acp : transition),
    });
    store.appendEvents(first.id, [{ type: "thread.created", thread: first }], 1);
    store.close();
    const db = new DatabaseSync(path);
    try {
      // Model the two released branch schemas at the real SQLite boundary.
      db.exec(
        legacy === "acp"
          ? "ALTER TABLE threads DROP COLUMN transitions"
          : "ALTER TABLE threads DROP COLUMN acp",
      );
      db.exec(`DROP TABLE item_text_targets; DROP TABLE item_source_chunks; DROP TABLE item_text_streams;
      CREATE TABLE item_text_streams (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        part INTEGER NOT NULL, size INTEGER NOT NULL, UNIQUE(item_id,part)
      );
      CREATE TABLE item_source_chunks (
        stream_id TEXT NOT NULL REFERENCES item_text_streams(id) ON DELETE CASCADE,
        offset INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(stream_id,offset)
      );
      UPDATE schema_version SET version=9 WHERE id=1;`);
    } finally {
      db.close();
    }
    store = new Store(path, undefined, { now: () => 1 });
    expect(store.getThread(first.id)).toMatchObject(legacy === "acp" ? acp : transition);
    const second = Thread.parse({
      ...first,
      id: "other-owner",
      provider: "acp",
      ...acp,
      ...transition,
      execution: { ...transition.execution, provider: "acp" },
    });
    store.appendEvents(second.id, [{ type: "thread.created", thread: second }], 2);
    store.close();
    store = new Store(path, undefined, { now: () => 1 });
    expect(store.getThread(second.id)).toMatchObject({
      ...acp,
      lineage: second.lineage,
      execution: second.execution,
    });
  },
);
