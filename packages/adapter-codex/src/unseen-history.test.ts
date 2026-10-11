import { expect, test } from "vitest";
import { setup, shell } from "./translator.test-helper.ts";

test("an unseen active child turn holds completion after an observed turn finishes", () => {
  const h = setup();
  h.start();
  h.item({ id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child" }, true);
  h.start("child", "A");
  h.end("completed", "child", "A");
  h.end();
  expect(h.state.status.state).toBe("done");
  h.feed({
    seq: 100,
    t: 100,
    dir: "note",
    channel: "stdio",
    data: {
      event: "thread-discovered",
      revision: { read: 2, current: 2 },
      thread: {
        id: "child",
        parentThreadId: "native",
        status: { type: "active" },
        turns: [{ id: "B", status: "inProgress", items: [] }],
      },
    },
  });
  h.feed({
    seq: 101,
    t: 101,
    dir: "note",
    channel: "stdio",
    data: { event: "discovery-finished" },
  });
  expect(h.state.status.state).toBe("working");
  h.end("completed", "child", "B");
  expect(h.state.status.state).toBe("done");
});

test.each(["completed", "inProgress"])(
  "an outdated active snapshot preserves a newer %s child turn",
  (status) => {
    const h = setup();
    h.start();
    h.item({ id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child" }, true);
    h.start("child", "newer");
    if (status === "completed") h.end("completed", "child", "newer");
    h.end();
    h.feed({
      seq: 100,
      t: 100,
      dir: "note",
      channel: "stdio",
      data: {
        event: "thread-discovered",
        revision: { read: 1, current: 3 },
        thread: {
          id: "child",
          parentThreadId: "native",
          status: { type: "active" },
          turns: [{ id: "older", status: "inProgress", items: [] }],
        },
      },
    });
    expect(h.state.status.state).toBe(status === "completed" ? "done" : "working");
    h.end("completed", "child", "newer");
    expect(h.state.status.state).toBe("done");
  },
);

test("earlier unseen child work is recovered after a newer live turn completes", () => {
  const h = setup();
  h.start();
  h.item({ id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child" }, true);
  h.start("child", "next");
  h.end("completed", "child", "next");
  h.end();
  const recover = () =>
    h.feed({
      seq: 100,
      t: 100,
      dir: "note",
      channel: "stdio",
      data: {
        event: "thread-discovered",
        thread: {
          id: "child",
          parentThreadId: "native",
          status: { type: "idle" },
          turns: [
            {
              id: "old",
              status: "completed",
              items: [{ id: "history", type: "agentMessage", text: "earlier message" }, shell],
            },
            { id: "next", status: "completed", items: [] },
          ],
        },
      },
    });
  recover();
  recover();
  expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
  expect(Object.values(h.state.items).filter((i) => i.type === "message")).toHaveLength(1);
  expect(
    Object.values(h.state.tasks).filter((t) => t.kind === "shell" && t.status === "running"),
  ).toHaveLength(1);
  h.item(
    { ...shell, status: "completed", exitCode: 0, aggregatedOutput: "finished" },
    true,
    "child",
    "old",
  );
  recover();
  expect(h.state.status.state).toBe("done");
  expect(h.state.items["exec"]).toMatchObject({ complete: true, call: { status: "succeeded" } });
});

test("recovering older child history cannot replace a newer active turn", () => {
  const h = setup();
  h.start();
  h.item({ id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child" }, true);
  h.start("child", "current");
  h.feed({
    seq: 100,
    t: 100,
    dir: "note",
    channel: "stdio",
    data: {
      event: "thread-discovered",
      thread: {
        id: "child",
        parentThreadId: "native",
        status: { type: "idle" },
        turns: [
          {
            id: "old",
            status: "completed",
            items: [{ id: "history", type: "agentMessage", text: "old result" }],
          },
        ],
      },
    },
  });
  h.end();
  expect(Object.values(h.state.runs).find((r) => r.nativeId === "current")?.state).toBe("active");
  expect(h.state.status.state).toBe("working");
  expect(h.state.items["history"]).toMatchObject({ type: "message" });
  h.end("completed", "child", "current");
  expect(h.state.status.state).toBe("done");
});
