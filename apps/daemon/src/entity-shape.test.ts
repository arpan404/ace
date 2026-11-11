import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  Agent,
  BackgroundTask,
  EventPayload,
  Interaction,
  Run,
  type Thread,
  type ThreadId,
} from "@ace/protocol";
import { afterEach, expect, it } from "vitest";
import { createDevThread } from "./commands.ts";
import { decodeStoredEntity, type StoredEntityCollection } from "./stored-decode.ts";
import { Store } from "./store.ts";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).toReversed()) close();
});

/** A store whose entity "shape" the test chooses, standing in for different builds. */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "ace-entity-shape-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const path = join(home, "events.sqlite");
  let store: Store | undefined;
  const open = (entityShape: string) => {
    store?.close();
    store = new Store(path, console.error, { entityShape });
    return store;
  };
  cleanup.push(() => store?.close());
  return { open };
}

function question(thread: Thread, id: string) {
  return Interaction.parse({
    id,
    threadId: thread.id,
    agentId: "root",
    blocking: true,
    request: {
      kind: "question",
      questions: [{ id: "q0", text: "Which?", options: [], multiSelect: false, allowOther: true }],
    },
    state: "pending",
    createdAt: 1,
  });
}

/** Rewrite a stored question as an older build might have left it: without `secret`. */
function dropSecret(store: Store, thread: ThreadId, id: string) {
  store.atomic((db) =>
    db
      .prepare(
        "UPDATE view_entities SET value = json_remove(value, '$.request.questions[0].secret') WHERE thread_id = ? AND collection = 'interactions' AND id = ?",
      )
      .run(thread, id),
  );
}

/** Every way a client or the daemon reads a stored interaction back. */
function readQuestion(store: Store, thread: ThreadId, id: string) {
  const page = store.readEntityPage(thread, "interactions", Number.MAX_SAFE_INTEGER, 200);
  if (page.collection !== "interactions") throw new Error("expected interactions");
  return {
    page: page.entries.find((entry) => entry.id === id)?.request,
    snapshot: store.snapshotThread(thread).interactions[id]?.request,
    interaction: store.getInteraction(id)?.request,
  };
}
const withSecret = { questions: [expect.objectContaining({ id: "q0", secret: false })] };
const decodedEverywhere = { page: withSecret, snapshot: withSecret, interaction: withSecret };

function begin(store: Store) {
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo", 1));
  store.appendEvents(thread.id, [
    { type: "interaction.opened", interaction: question(thread, "old") },
  ]);
  return thread;
}

it("entity rows an older build left are read with the new schema's defaults", () => {
  const { open } = setup();
  const before = open("older build");
  const thread = begin(before);
  dropSecret(before, thread.id, "old");

  const after = open("newer build");
  expect(readQuestion(after, thread.id, "old")).toMatchObject(decodedEverywhere);
  // And still once the newer build has recorded its shape.
  expect(readQuestion(open("newer build"), thread.id, "old")).toMatchObject(decodedEverywhere);
});

it("entity rows a different build rewrote in between are decoded again after coming back", () => {
  const { open } = setup();
  const thread = begin(open("build A"));
  const other = open("build B");
  dropSecret(other, thread.id, "old");

  expect(readQuestion(open("build A"), thread.id, "old")).toMatchObject(decodedEverywhere);
});

it("a stored entity that no longer decodes keeps every other old row decoded", () => {
  const { open } = setup();
  const before = open("older build");
  const thread = begin(before);
  const task = BackgroundTask.parse({
    id: "broken",
    agentId: "root",
    kind: "shell",
    title: "build",
    status: "running",
    stoppable: true,
    startedAt: 1,
  });
  before.appendEvents(thread.id, [{ type: "background_task.started", task }]);
  dropSecret(before, thread.id, "old");
  before.atomic((db) =>
    db.prepare("UPDATE view_entities SET value = '{\"id\":\"broken\"}' WHERE id = 'broken'").run(),
  );

  // Twice: the shape is never recorded while a row can't be put in it.
  for (let attempt = 0; attempt < 2; attempt++) {
    const after = open("newer build");
    const page = after.readEntityPage(thread.id, "interactions", Number.MAX_SAFE_INTEGER, 200);
    if (page.collection !== "interactions") throw new Error("expected interactions");
    expect(page.entries[0]?.request).toMatchObject(withSecret);
    expect(after.getInteraction("old")?.request).toMatchObject(withSecret);
    expect(() =>
      after.readEntityPage(thread.id, "backgroundTasks", Number.MAX_SAFE_INTEGER, 200),
    ).toThrow();
  }
});

it("every entity row this build writes is already in its schema's shape", () => {
  const { open } = setup();
  const store = open("current");
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo", 1));
  const root = Agent.parse({
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
  const run = Run.parse({
    id: "r",
    threadId: thread.id,
    agentId: root.id,
    trigger: "user",
    state: "active",
    startedAt: 1,
  });
  const task = BackgroundTask.parse({
    id: "t",
    agentId: root.id,
    kind: "shell",
    title: "build",
    status: "running",
    stoppable: true,
    startedAt: 1,
  });
  store.appendEvents(thread.id, [
    { type: "agent.created", agent: root },
    {
      type: "agent.created",
      agent: Agent.parse({ ...root, id: "child", parentId: root.id, origin: "provider_subagent" }),
    },
    EventPayload.parse({ type: "agent.updated", agentId: "child", name: "worker" }),
    { type: "agent.status", agentId: root.id, status: { state: "working", activity: "thinking" } },
    { type: "run.started", run },
    { type: "interaction.opened", interaction: question(thread, "q") },
    EventPayload.parse({
      type: "interaction.closed",
      interactionId: "q",
      state: "resolved",
      closedAt: 2,
    }),
    { type: "background_task.started", task },
    { type: "background_task.updated", taskId: task.id, status: "completed", endedAt: 2 },
    { type: "run.ended", runId: run.id, state: "completed", endedAt: 3 },
    {
      type: "context_meter.updated",
      meter: { agentId: root.id, epoch: 1, usedTokens: 10, windowTokens: 100, source: "provider" },
    },
    { type: "usage.updated", agentId: root.id, inputTokens: 3, outputTokens: 4 },
    EventPayload.parse({
      type: "usage.updated",
      agentId: root.id,
      inputTokens: 100,
      outputTokens: 20,
      usageScope: "provider_session",
      counterKey: "native:initial",
    }),
    { type: "queue.updated", revision: 1, paused: true, reason: "manual", resumeAt: null },
  ]);

  const rows = store.atomic((db) =>
    db.prepare("SELECT collection, value FROM view_entities WHERE thread_id = ?").all(thread.id),
  );
  const collections = new Set(rows.map((row) => String(row.collection)));
  expect(collections).toEqual(
    new Set([
      "agents",
      "runs",
      "interactions",
      "backgroundTasks",
      "contextMeters",
      "usage",
      "usageSnapshots",
      "queue",
    ]),
  );
  const reshaped = rows.filter((row) => {
    const stored: unknown = JSON.parse(String(row.value));
    const collection = String(row.collection) as StoredEntityCollection;
    return !isDeepStrictEqual(decodeStoredEntity(collection, stored), stored);
  });
  expect(reshaped).toEqual([]);
});

it("an entity page never holds more than 200 entries, whatever limit it is asked for", () => {
  const { open } = setup();
  const store = open("current");
  const thread = createDevThread(store, store.createWorkspace("/repo", "Repo", 1));
  const tasks: EventPayload[] = [];
  for (let index = 0; index < 205; index++)
    tasks.push({
      type: "background_task.started",
      task: BackgroundTask.parse({
        id: `t${index}`,
        agentId: "root",
        kind: "shell",
        title: "t",
        status: "completed",
        stoppable: false,
        startedAt: 1,
      }),
    });
  store.appendEvents(thread.id, tasks);

  const page = store.readEntityPage(thread.id, "backgroundTasks", Number.MAX_SAFE_INTEGER, 500);
  expect(page.entries).toHaveLength(200);
  expect(page.entitiesBefore).not.toBeNull();
});
