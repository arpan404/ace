import { expect, test } from "vitest";
import { setup, shell } from "./translator.test-helper.ts";

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
