import { expect, test } from "vitest";
import { setup, shell } from "./translator.test-helper.ts";

test.each(["spawn announcement", "authoritative snapshot"])(
  "a recreated buffer admitted by %s recovers old messages and surviving shells",
  (admission) => {
    const h = setup();
    h.start();
    h.start("child", "old");
    h.item({ id: "old-message", type: "agentMessage", text: "lost history" }, true, "child", "old");
    h.item(shell, false, "child", "old");
    h.end("completed", "child", "old");
    for (let i = 0; i < 300; i++)
      h.recv("thread/status/changed", { threadId: `noise-${i}`, status: { type: "idle" } });
    // These boundaries recreate an evicted buffer before ancestry is established.
    h.start("child", "next");
    h.end("completed", "child", "next");
    if (admission === "spawn announcement")
      h.item(
        { id: "spawn", type: "subAgentActivity", kind: "started", agentThreadId: "child" },
        true,
      );
    h.feed({
      seq: 1000,
      t: 1000,
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
              items: [
                { id: "old-message", type: "agentMessage", text: "recovered old history" },
                shell,
              ],
            },
            { id: "next", status: "completed", items: [] },
          ],
        },
      },
    });
    h.feed({
      seq: 1001,
      t: 1001,
      dir: "recv",
      channel: "stdio",
      data: {
        method: "item/completed",
        params: {
          threadId: "native",
          turnId: "turn",
          item: {
            id: "spawn-again",
            type: "subAgentActivity",
            kind: "started",
            agentThreadId: "child",
          },
        },
      },
    });
    h.feed({
      seq: 1002,
      t: 1002,
      dir: "recv",
      channel: "stdio",
      data: {
        method: "turn/completed",
        params: { threadId: "native", turn: { id: "turn", status: "completed" } },
      },
    });
    h.feed({
      seq: 1003,
      t: 1003,
      dir: "note",
      channel: "stdio",
      data: { event: "discovery-finished", task: "discovery:scan" },
    });
    expect(
      Object.values(h.state.items).some(
        (i) =>
          i.type === "message" &&
          i.parts.some((p) => p.type === "text" && p.text === "recovered old history"),
      ),
    ).toBe(true);
    expect(Object.values(h.state.runs).every((r) => r.state === "completed")).toBe(true);
    expect(h.state.status).toEqual({ state: "waiting", on: "background_task" });
    expect(
      Object.values(h.state.tasks).some(
        (t) => t.kind === "shell" && t.status === "running" && t.stoppable,
      ),
    ).toBe(true);
    h.feed({
      seq: 1004,
      t: 1004,
      dir: "recv",
      channel: "stdio",
      data: {
        method: "item/completed",
        params: {
          threadId: "child",
          turnId: "old",
          item: { ...shell, status: "completed", aggregatedOutput: "finished", exitCode: 0 },
        },
      },
    });
    expect(h.state.status.state).toBe("done");
    expect(h.state.items["exec"]).toMatchObject({ complete: true, call: { status: "succeeded" } });
  },
);
