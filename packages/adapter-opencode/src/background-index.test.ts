import { expect, it } from "vitest";
import { harness } from "./replay.ts";

it("expires staggered background results in deadline order after a child resumes and idles again", () => {
  const h = harness();
  let clock = 0;
  let seq = 0;
  const event = (type: string, properties: unknown) =>
    h.feed({
      seq: seq++,
      t: clock,
      dir: "recv",
      channel: "sse",
      data: { payload: { type, properties } },
    });
  event("session.created", { info: { id: "native_root" } });
  event("message.updated", { sessionID: "native_root", info: { id: "root_user", role: "user" } });
  event("session.status", { sessionID: "native_root", status: { type: "busy" } });
  for (const child of ["first", "second", "third"]) {
    event("session.created", { info: { id: child, parentID: "native_root" } });
    event("message.updated", { sessionID: child, info: { id: `${child}_user`, role: "user" } });
    event("session.status", { sessionID: child, status: { type: "busy" } });
    event("message.part.updated", {
      part: {
        id: `spawn_${child}`,
        sessionID: "native_root",
        type: "tool",
        tool: "task",
        state: {
          status: "completed",
          input: { description: child },
          metadata: { background: true, sessionId: child },
        },
      },
    });
  }
  event("session.status", { sessionID: "native_root", status: { type: "idle" } });
  clock = 100;
  event("session.status", { sessionID: "first", status: { type: "idle" } });
  clock = 200;
  event("session.status", { sessionID: "second", status: { type: "idle" } });
  clock = 250;
  event("session.status", { sessionID: "first", status: { type: "busy" } });
  clock = 260;
  event("session.status", { sessionID: "first", status: { type: "idle" } });
  const tasks = () =>
    Object.fromEntries(
      Object.values(h.view.backgroundTasks).map((task) => [task.title, task.status]),
    );
  h.tick(3199);
  expect(tasks()).toEqual({ first: "running", second: "running", third: "running" });
  h.tick(3200);
  expect(tasks()).toEqual({ first: "running", second: "completed", third: "running" });
  h.tick(3260);
  expect(tasks()).toEqual({ first: "completed", second: "completed", third: "running" });
  expect(h.view.thread.status.state).toBe("working");
  clock = 3300;
  event("session.status", { sessionID: "third", status: { type: "idle" } });
  h.tick(6300);
  expect(tasks()).toEqual({ first: "completed", second: "completed", third: "completed" });
  expect(h.view.thread.status.state).toBe("done");
});

it("keeps late running tools visible after their owning turn has already idled", () => {
  const h = harness();
  let seq = 0;
  const event = (type: string, properties: unknown) =>
    h.feed({
      seq: seq++,
      t: seq,
      dir: "recv",
      channel: "sse",
      data: { payload: { type, properties } },
    });
  event("session.created", { info: { id: "native_root" } });
  event("message.updated", { sessionID: "native_root", info: { id: "user", role: "user" } });
  event("session.status", { sessionID: "native_root", status: { type: "busy" } });
  event("session.status", { sessionID: "native_root", status: { type: "idle" } });
  expect(h.view.thread.status.state).toBe("done");
  const part = { id: "shell", sessionID: "native_root", type: "tool", tool: "bash" };
  event("message.part.updated", {
    part: { ...part, state: { status: "running", input: { command: "offline" } } },
  });
  expect(h.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  expect(Object.values(h.view.backgroundTasks).map((task) => task.status)).toEqual(["running"]);
  event("message.part.updated", {
    part: { ...part, state: { status: "completed", input: {}, output: "done" } },
  });
  expect(h.view.thread.status.state).toBe("done");
});

it("does not create a second survivor for a live tool already representing its background child", () => {
  const h = harness();
  let seq = 0;
  const event = (type: string, properties: unknown) =>
    h.feed({
      seq: seq++,
      t: seq,
      dir: "recv",
      channel: "sse",
      data: { payload: { type, properties } },
    });
  event("session.created", { info: { id: "native_root" } });
  event("message.updated", { sessionID: "native_root", info: { id: "user", role: "user" } });
  event("session.status", { sessionID: "native_root", status: { type: "busy" } });
  event("session.created", { info: { id: "child", parentID: "native_root" } });
  event("message.updated", { sessionID: "child", info: { id: "child_user", role: "user" } });
  event("session.status", { sessionID: "child", status: { type: "busy" } });
  const part = { id: "spawn", sessionID: "native_root", type: "tool", tool: "task" };
  const metadata = { background: true, sessionId: "child" };
  event("message.part.updated", {
    part: { ...part, state: { status: "running", input: {}, metadata } },
  });
  event("session.status", { sessionID: "native_root", status: { type: "idle" } });
  expect(Object.values(h.view.backgroundTasks)).toHaveLength(1);
  event("message.part.updated", {
    part: { ...part, state: { status: "completed", input: {}, metadata } },
  });
  event("session.status", { sessionID: "child", status: { type: "idle" } });
  h.tick(4000);
  expect(Object.values(h.view.backgroundTasks).map((task) => task.status)).toEqual(["completed"]);
  expect(h.view.thread.status.state).toBe("done");
});
