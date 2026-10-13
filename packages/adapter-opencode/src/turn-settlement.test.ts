import { expect, it } from "vitest";
import { harness } from "./replay.ts";

function setup() {
  const h = harness();
  let seq = 0;
  const frame = (channel: string, data: unknown, dir: "recv" | "send" | "note" = "recv") =>
    h.feed({ seq: seq++, t: seq, dir, channel, data });
  const event = (type: string, data: Record<string, unknown> = {}) =>
    frame("sse", {
      id: `e${seq}`,
      created: seq,
      type,
      data: { sessionID: "s-root", ...data },
      location: { directory: "/one" },
    });
  frame("lifecycle", { type: "started" }, "note");
  event("session.created", { projectID: "p", location: { directory: "/one" } });
  return { ...h, event };
}

const read = (id: string) => ({ assistantMessageID: "a", id, name: "read" });

it("instructions OpenCode adds mid-turn don't keep the thread working after the turn ends", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("session.tool.called", { ...read("t1"), input: { filePath: "portfolio/data.ts" } });
  h.event("session.tool.success", read("t1"));
  // OpenCode found portfolio/AGENTS.md while reading and injects it into the running turn.
  h.event("session.synthetic", {
    metadata: { instruction: { paths: ["/repo/portfolio/AGENTS.md"] } },
  });
  h.event("session.execution.succeeded");
  expect(h.view.thread.status.state).toBe("done");
  expect(Object.values(h.view.runs)).toHaveLength(1);
});

it("a tool inside a running turn reads as its own step, never as background work", () => {
  const h = setup();
  h.event("session.execution.started");
  for (const id of ["t1", "t2", "t3"]) h.event("session.tool.called", read(id));
  expect(Object.values(h.view.backgroundTasks)).toEqual([]);
  expect(h.view.thread.status.state).toBe("working");
  for (const id of ["t1", "t2", "t3"]) h.event("session.tool.success", read(id));
  h.event("session.execution.succeeded");
  expect(Object.values(h.view.backgroundTasks)).toEqual([]);
  expect(h.view.thread.status.state).toBe("done");
});

it("a tool still cleaning up when its turn ends holds the thread without taking over its row", () => {
  const h = setup();
  h.event("session.execution.started");
  h.event("session.tool.called", read("slow"));
  h.event("session.execution.succeeded");
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  expect(Object.values(h.view.backgroundTasks).map((task) => task.toolCallId)).toEqual([undefined]);
  h.event("session.tool.success", read("slow"));
  expect(h.view.thread.status.state).toBe("done");
});
