import { expect, test } from "vitest";
import { ItemId } from "@ace/protocol";
import {
  root,
  storeFixture,
  start,
  end,
  turns,
  catchUp,
  tool,
} from "./long-thread-test-support.ts";

// Mutations: ignoring a running tool after run.ended, forgetting original-turn ownership,
// forcing completion to follow the newest root ordinal. Not executed (tests run at merge).
test("a running tool keeps its completed root turn unfinished and settles it during a later run", () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "late-shell",
          "running",
          { kind: "shell", command: "background build" },
          "first",
        ),
      },
    ],
    25,
  );
  end(f.store, f.thread, "first", 30);
  const waiting = turns(f.store, f.thread).turns[0];
  expect(waiting).toMatchObject({
    outcome: "completed",
    status: { state: "waiting", on: "background_task" },
    digest: { commandsRun: 1 },
  });
  expect(waiting?.endedAt).toBeUndefined();
  expect(catchUp(f.store, f.thread, { sinceSeq: 0 }).turnsCompleted).toBe(0);
  start(f.store, f.thread, "second", 40);
  expect(turns(f.store, f.thread).turns[0]?.status).toEqual({
    state: "waiting",
    on: "background_task",
  });
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.updated",
        item: tool(
          "late-shell",
          "succeeded",
          { kind: "shell", command: "background build", exitCode: 0 },
          "first",
        ),
      },
    ],
    50,
  );
  const [first, second] = turns(f.store, f.thread).turns;
  expect(first).toMatchObject({
    ordinal: 1,
    outcome: "completed",
    status: { state: "done" },
    endedAt: 50,
    digest: { commandsRun: 1, commandsFailed: 0 },
  });
  expect(second).toMatchObject({
    ordinal: 2,
    outcome: "active",
    status: { state: "working" },
    digest: { commandsRun: 0 },
  });
  expect(second?.endedAt).toBeUndefined();
  expect(catchUp(f.store, f.thread, { sinceSeq: 0 }).turnsCompleted).toBe(1);
});

// Mutations: counting an awaiting approval shell as executed, ignoring its outstanding
// lifecycle or treating a declined command as failed execution. Not executed (tests run at merge).
test("an awaiting approval shell counts as a tool but never as a command run before it starts", () => {
  const f = storeFixture();
  start(f.store, f.thread, "approval-turn", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "unapproved-shell",
          "awaiting_approval",
          { kind: "shell", command: "deploy" },
          "approval-turn",
        ),
      },
    ],
    25,
  );
  end(f.store, f.thread, "approval-turn", 30);
  const pending = turns(f.store, f.thread).turns[0];
  expect(pending?.digest).toMatchObject({
    toolCounts: { shell: 1 },
    commandsRun: 0,
    commandsFailed: 0,
    commands: [],
  });
  expect(pending?.endedAt).toBeUndefined();
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.updated",
        item: tool(
          "unapproved-shell",
          "declined",
          { kind: "shell", command: "deploy" },
          "approval-turn",
        ),
      },
    ],
    40,
  );
  const declined = turns(f.store, f.thread).turns[0];
  expect(declined).toMatchObject({
    status: { state: "done" },
    endedAt: 40,
    digest: { commandsRun: 0, commandsFailed: 0, commands: [] },
  });
  expect(catchUp(f.store, f.thread, { sinceSeq: 0 }).turnsCompleted).toBe(1);
});

// Mutations: skipping settlement for item.deleted, losing the deletion sequence from a turn
// range, retaining a deleted tool's digest. Not executed (tests run at merge).
test("deleting the last unresolved tool settles its original turn without waiting for another event", () => {
  const f = storeFixture();
  start(f.store, f.thread, "first", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "item.created",
        item: tool(
          "deleted-shell",
          "pending",
          { kind: "shell", command: "never started" },
          "first",
        ),
      },
    ],
    25,
  );
  end(f.store, f.thread, "first", 30);
  start(f.store, f.thread, "second", 40);
  const events = f.store.appendEvents(
    f.thread.id,
    [{ type: "item.deleted", itemId: ItemId.parse("deleted-shell") }],
    50,
  );
  const deletion = events.find((event) => event.payload.type === "item.deleted");
  if (!deletion) throw new Error("Missing deletion event");
  const first = turns(f.store, f.thread).turns[0];
  expect(first).toMatchObject({ ordinal: 1, status: { state: "done" }, endedAt: 50 });
  expect(first?.endSeq).toBeGreaterThanOrEqual(deletion.seq);
  expect(first?.digest.toolCounts.shell ?? 0).toBe(0);
  expect(catchUp(f.store, f.thread, { sinceSeq: deletion.seq - 1 }).turnsCompleted).toBe(1);
});

// Mutations: subtracting a failed agent's historical error during recovery or moving it to
// the next root turn. Not executed (tests run at merge).
test("a recovered root agent keeps its failure in the original turn's digest", () => {
  const f = storeFixture();
  start(f.store, f.thread, "failed-turn", 20);
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "agent.status",
        agentId: root,
        status: {
          state: "failed",
          error: { kind: "provider", message: "Temporary provider failure" },
        },
      },
    ],
    25,
  );
  f.store.appendEvents(
    f.thread.id,
    [
      {
        type: "agent.status",
        agentId: root,
        status: {
          state: "failed",
          error: { kind: "provider", message: "Temporary provider failure" },
        },
      },
    ],
    26,
  );
  end(f.store, f.thread, "failed-turn", 30);
  start(f.store, f.thread, "recovered-turn", 40);
  const [failed, recovered] = turns(f.store, f.thread).turns;
  expect(failed?.digest.errors).toBe(1);
  expect(recovered?.digest.errors).toBe(0);
  expect(catchUp(f.store, f.thread, { sinceSeq: 0 }).digest.errors).toBe(1);
});
