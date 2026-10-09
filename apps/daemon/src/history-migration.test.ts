import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Agent, Thread, ThreadId } from "@ace/protocol";
import { migrateEngine } from "./engine/migrations.ts";
import { Store } from "./store.ts";
import { expect, test } from "vitest";

test("old imports settle once on upgrade, while active, adopted, deleted and explicitly unsettled imports keep their state", async () => {
  const root = await mkdtemp(join(tmpdir(), "ace-history-upgrade-")),
    path = join(root, "events.sqlite");
  let store = new Store(path);
  try {
    const workspaceId = store.createWorkspace("/synthetic", "Fixture");
    for (const id of ["old", "active", "unsettled", "ordinary", "adopted", "deleted"]) {
      const thread = Thread.parse({
        id,
        workspaceId,
        title: "New thread",
        provider: "codex",
        rootAgentId: `${id}-root`,
        status: {
          state: id === "active" ? "working" : "new",
          ...(id === "active" ? { agents: 1 } : {}),
        },
        createdAt: 1,
        updatedAt: 1,
        ...(id !== "ordinary"
          ? {
              imported: {
                sourceId: id,
                instanceId: "codex",
                native: { provider: "codex", nativeId: id },
                importedAt: 10,
              },
            }
          : {}),
      });
      store.appendEvents(
        thread.id,
        [
          { type: "thread.created", thread },
          {
            type: "agent.created",
            agent: Agent.parse({
              id: `${id}-root`,
              threadId: id,
              parentId: null,
              origin: "root",
              native: { provider: "codex", nativeId: id },
              model: "bare-model",
              cwd: "/synthetic",
              fidelity: "full",
              createdAt: 1,
              status:
                id === "active"
                  ? { state: "working", activity: "responding" }
                  : { state: "unresponsive", lastSignalAt: 1 },
            }),
          },
        ],
        10,
      );
      if (id === "unsettled")
        store.appendEvents(
          thread.id,
          [{ type: "thread.client.updated", changes: { settledAt: null } }],
          11,
        );
    }
    store.appendEvents(
      ThreadId.parse("deleted"),
      [{ type: "thread.client.updated", changes: { deletedAt: 12 } }],
      12,
    );
    await store.close();
    const db = new DatabaseSync(path);
    migrateEngine(db);
    db.prepare("INSERT INTO engine_sessions(thread_id,cwd) VALUES (?,?)").run(
      "adopted",
      "/synthetic",
    );
    db.prepare("DELETE FROM upgrade_cleanup WHERE id=?").run("settle-history-imports-v1");
    db.close();
    store = new Store(path);
    const upgraded = store.listThreads().find((t) => t.id === "old");
    expect(upgraded).toMatchObject({
      status: { state: "done" },
      settledAt: 10,
      unread: false,
      title: "New thread",
    });
    expect(
      Object.values(store.snapshotThread(Thread.parse({ ...upgraded }).id).agents)[0],
    ).toMatchObject({ status: { state: "idle" }, model: "bare-model" });
    expect(store.listThreads().find((t) => t.id === "active")).toMatchObject({
      status: { state: "working" },
    });
    for (const id of ["active", "unsettled", "ordinary", "adopted", "deleted"])
      expect(store.getThread(ThreadId.parse(id))?.settledAt).toBeUndefined();
    const head = store.headSeq();
    await store.close();
    store = new Store(path);
    expect(store.headSeq()).toBe(head);
    expect(store.listThreads().find((t) => t.id === "old")?.settledAt).toBe(10);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
