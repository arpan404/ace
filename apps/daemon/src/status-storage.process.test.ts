import { restorePrePreviewSchema } from "./migration-test-support.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Agent, BackgroundTask, Interaction, Run, DeviceId, type Thread } from "@ace/protocol";
import { Store, createDevThread } from "./index.ts";
import { message } from "./payload-test-support.ts";
function work(store: Store, thread: Thread) {
  const agent = Agent.parse({
    id: "root",
    threadId: thread.id,
    parentId: null,
    origin: "root",
    native: { provider: "codex" },
    fidelity: "full",
    cwd: "/repo",
    status: { state: "starting" },
    createdAt: 1,
  });
  const child = Agent.parse({
    ...agent,
    id: "child",
    parentId: agent.id,
    origin: "provider_subagent",
  });
  const run = Run.parse({
    id: "r",
    threadId: thread.id,
    agentId: agent.id,
    trigger: "user",
    state: "active",
    startedAt: 1,
  });
  const interaction = Interaction.parse({
    id: "q",
    threadId: thread.id,
    agentId: agent.id,
    blocking: true,
    request: { kind: "approval", title: "allow", options: [] },
    state: "pending",
    createdAt: 1,
  });
  const task = BackgroundTask.parse({
    id: "t",
    agentId: child.id,
    kind: "shell",
    title: "build",
    status: "running",
    stoppable: true,
    startedAt: 1,
  });
  store.appendEvents(thread.id, [
    { type: "agent.created", agent },
    { type: "agent.created", agent: child },
    { type: "agent.created", agent: Agent.parse({ ...child, id: "sibling" }) },
    { type: "run.started", run },
    { type: "interaction.opened", interaction },
    { type: "background_task.started", task },
    { type: "agent.updated", agentId: child.id, parentId: null, name: "worker" },
    { type: "agent.status", agentId: agent.id, status: { state: "idle" } },
    { type: "run.ended", runId: run.id, state: "completed", trigger: "parent_agent", endedAt: 2 },
    {
      type: "interaction.closed",
      interactionId: interaction.id,
      state: "resolved",
      resolution: { kind: "approval", optionId: "yes" },
      resolvedBy: DeviceId.parse("device"),
      closedAt: 2,
    },
    { type: "background_task.updated", taskId: task.id, status: "completed", endedAt: 2 },
    { type: "usage.updated", agentId: agent.id, inputTokens: 3, outputTokens: 4 },
  ]);
}
function assertWork(store: Store, thread: Thread) {
  const view = store.snapshotThread(thread.id);
  expect(view.agents.root).toMatchObject({ status: { state: "idle" } });
  expect(view.agents.child).toMatchObject({ parentId: null, name: "worker" });
  expect(view.agentChildren.root).toEqual(["sibling"]);
  expect(view.runs.r).toMatchObject({ state: "completed", trigger: "parent_agent", endedAt: 2 });
  expect(view.interactions.q).toMatchObject({
    state: "resolved",
    resolution: { optionId: "yes" },
    resolvedBy: DeviceId.parse("device"),
    closedAt: 2,
  });
  expect(view.backgroundTasks.t).toMatchObject({ status: "completed", endedAt: 2 });
  expect(view.usage.root).toMatchObject({ inputTokens: 3, outputTokens: 4 });
}
it("loads cold work status and the item window without reading historical event bodies", () => {
  const db = new DatabaseSync(":memory:");
  const store = new Store(":memory:", undefined, { database: db });
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "repo"));
    work(store, thread);
    store.appendEvents(
      thread.id,
      Array.from({ length: 201 }, (_, i) => ({
        type: "item.created" as const,
        item: message(`m${i}`),
      })),
    );
    db.function("historical_body", () => {
      throw new Error("read historical event body");
    });
    db.exec(
      "ALTER TABLE events RENAME TO historical_events; CREATE VIEW events AS SELECT seq, id, thread_id, at, type, historical_body(payload) AS payload FROM historical_events",
    );
    assertWork(store, thread);
    expect(store.snapshotThread(thread.id).itemOrder).toHaveLength(200);
    const status = store.acquireThread(thread.id);
    expect(status.itemOrder).toEqual([]);
    store.releaseThread(thread.id);
  } finally {
    store.close();
  }
});
it("backfills version-three work entities and item metadata once, then keeps appending across restarts", () => {
  const home = mkdtempSync(join(tmpdir(), "ace-status-upgrade-"));
  const path = join(home, "events.sqlite");
  let store = new Store(path);
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "repo"));
    work(store, thread);
    store.appendEvents(thread.id, [{ type: "item.created", item: message("m", "before") }]);
    store.close();
    const db = new DatabaseSync(path);
    restorePrePreviewSchema(db);
    db.exec(
      "DROP TABLE text_encoding_migration; DROP TABLE item_text_chunks; DROP TABLE item_heads; DROP TABLE view_entities; DROP TABLE status_migration; UPDATE schema_version SET version = 3",
    );
    db.close();
    store = new Store(path);
    assertWork(store, thread);
    const item = message("m");
    store.appendEvents(thread.id, [
      {
        type: "item.delta",
        itemId: item.id,
        agentId: item.agentId,
        field: "text",
        append: " after",
      },
    ]);
    const snapshot = store.snapshotThread(thread.id);
    expect(snapshot.items.m).toMatchObject({ parts: [{ text: "before after" }] });
    store.close();
    store = new Store(path);
    expect(store.snapshotThread(thread.id)).toEqual(snapshot);
  } finally {
    store.close();
    rmSync(home, { recursive: true, force: true });
  }
});
it("uses the injected allocator for durable blob references", () => {
  const ids = ["workspace-id", "thread-event-id", "item-event-id", "blob-id"];
  const store = new Store(":memory:", undefined, {
    nextId: () => {
      const id = ids.shift();
      if (!id) throw new Error("Fixture ids exhausted");
      return id;
    },
  });
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "repo"));
    const item = message("raw");
    if (item.type !== "message") throw new Error("Expected message");
    item.raw = [{ type: "native", data: "x".repeat(65536) }];
    store.appendEvents(thread.id, [{ type: "item.created", item }]);
    expect(store.snapshotThread(thread.id).items.raw).toMatchObject({
      raw: [{ blobRef: "blob-id" }],
    });
  } finally {
    store.close();
  }
});

it("snapshots retain pending approvals and recent closed approvals after thousands of answers", () => {
  const store = new Store(":memory:");
  try {
    const thread = createDevThread(store, store.createWorkspace("/repo", "repo"));
    for (let offset = 0; offset < 5000; offset += 100) {
      const events: import("@ace/protocol").EventPayload[] = [];
      for (let i = offset; i < offset + 100; i++) {
        const interaction = Interaction.parse({
          id: `q${i}`,
          threadId: thread.id,
          agentId: "root",
          blocking: true,
          request: { kind: "approval", title: "approve", options: [] },
          state: "pending",
          createdAt: i,
        });
        events.push({ type: "interaction.opened", interaction });
        if (i !== 0)
          events.push({
            type: "interaction.closed",
            interactionId: interaction.id,
            state: "resolved",
            closedAt: i,
          });
      }
      store.appendEvents(thread.id, events);
    }
    const view = store.snapshotThread(thread.id);
    expect(view.interactions.q0?.state).toBe("pending");
    expect(view.interactions.q4999?.state).toBe("resolved");
    expect(Object.keys(view.interactions).length).toBeLessThanOrEqual(201);
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(131072);
    const ids = new Set(Object.keys(view.interactions));
    let before = view.entitiesBefore?.interactions;
    while (before != null) {
      const page = store.readEntityPage(thread.id, "interactions", before, 200);
      if (page.collection !== "interactions") throw new Error("Unexpected page");
      for (const interaction of page.entries) ids.add(interaction.id);
      before = page.entitiesBefore;
    }
    expect(ids.size).toBe(5000);
    expect(ids.has("q1")).toBe(true);
  } finally {
    store.close();
  }
});
