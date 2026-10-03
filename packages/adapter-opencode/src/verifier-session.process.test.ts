import { expect, it } from "vitest";
import { object } from "./testing/v1/data.ts";
import { recoveryBarrier } from "./testing/recovery-barriers.ts";

const payload = (data: unknown) => object(object(data).payload);
const properties = (data: unknown) => object(payload(data).properties);
const prompts = (frames: { dir: string; data: unknown }[]) =>
  frames.filter(
    (frame) => frame.dir === "send" && String(object(frame.data).path).endsWith("/prompt_async"),
  );
const shell = (id: string, status: string) => ({
  id: "shell",
  callID: "shell_call",
  sessionID: id,
  type: "tool",
  tool: "bash",
  state: { status, input: { command: "offline" }, output: status === "completed" ? "done" : "" },
});

async function firstPrompt(h: Awaited<ReturnType<typeof recoveryBarrier>>) {
  await h.session.send([{ type: "text", text: "first" }], "queue");
  await h.wait(
    (frame) =>
      frame.channel === "sse" &&
      payload(frame.data).type === "session.status" &&
      object(properties(frame.data).status).type === "busy",
  );
}

it("holds delivery when newer busy SSE arrives while an older idle snapshot is in flight", async () => {
  const h = await recoveryBarrier("status");
  const id = h.session.nativeSessionId;
  await firstPrompt(h);
  await h.recover({ statuses: { [id]: { type: "idle" } } });
  const observed = h.observe(
    (data) =>
      payload(data).type === "session.status" && object(properties(data).status).type === "busy",
  );
  await h.control("/test/state", { statuses: { [id]: { type: "busy" } } });
  await h.publish("session.status", { sessionID: id, status: { type: "busy" } });
  await observed;
  h.release();
  await h.wait((frame) => frame.channel === "lifecycle" && object(frame.data).type === "resynced");
  const recovered = h.projection.view.thread.status.state;
  const queued = h.session.send([{ type: "text", text: "second" }], "queue");
  void queued.catch(() => {});
  await h.session.resolve("barrier", { kind: "approval", optionId: "once" });
  expect({ recovered, accepted: prompts(h.frames).length }).toEqual({
    recovered: "working",
    accepted: 1,
  });
  await h.publish("session.status", { sessionID: id, status: { type: "idle" } });
  await queued;
});

it("keeps a newer running shell live before settling an older idle snapshot", async () => {
  const h = await recoveryBarrier("status");
  const id = h.session.nativeSessionId;
  await firstPrompt(h);
  await h.recover({ statuses: { [id]: { type: "idle" } } });
  const observed = h.observe((data) => object(properties(data).part).id === "shell");
  await h.publish("message.part.updated", { part: shell(id, "running") });
  await observed;
  h.release();
  await h.wait((frame) => frame.channel === "lifecycle" && object(frame.data).type === "resynced");
  expect(h.projection.view.thread.status).toEqual({ state: "waiting", on: "background_task" });
  const queued = h.session.send([{ type: "text", text: "second" }], "queue");
  void queued.catch(() => {});
  await h.session.resolve("barrier", { kind: "approval", optionId: "once" });
  expect(prompts(h.frames)).toHaveLength(1);
  expect(Object.values(h.projection.view.backgroundTasks).map((task) => task.status)).toEqual([
    "running",
  ]);
  await h.publish("message.part.updated", { part: shell(id, "completed") });
  await queued;
  expect(prompts(h.frames)).toHaveLength(2);
});

it("settles a newer idle received while an older busy status snapshot is in flight", async () => {
  const h = await recoveryBarrier("status");
  const id = h.session.nativeSessionId;
  await firstPrompt(h);
  await h.recover({ statuses: { [id]: { type: "busy" } } });
  const observed = h.observe(
    (data) =>
      payload(data).type === "session.status" && object(properties(data).status).type === "idle",
  );
  await h.publish("session.status", { sessionID: id, status: { type: "idle" } });
  await observed;
  h.release();
  await h.wait((frame) => frame.channel === "lifecycle" && object(frame.data).type === "resynced");
  expect(h.projection.view.thread.status.state).toBe("done");
  await h.session.send([{ type: "text", text: "second" }], "queue");
  expect(prompts(h.frames)).toHaveLength(2);
});

it("settles a newer completed shell received while older running history is in flight", async () => {
  const h = await recoveryBarrier("history");
  const id = h.session.nativeSessionId;
  await firstPrompt(h);
  await h.recover({
    statuses: { [id]: { type: "idle" } },
    messages: {
      [id]: [{ info: { id: "tool_message", role: "assistant" }, parts: [shell(id, "running")] }],
    },
  });
  const observed = h.observe(
    (data) => object(object(properties(data).part).state).status === "completed",
  );
  await h.publish("message.part.updated", { part: shell(id, "completed") });
  await observed;
  h.release();
  await h.wait((frame) => frame.channel === "lifecycle" && object(frame.data).type === "resynced");
  expect(h.projection.view.thread.status.state).toBe("done");
  expect(
    Object.values(h.projection.view.items)
      .filter((item) => item.type === "tool_call")
      .map((item) => item.call.status),
  ).toEqual(["succeeded"]);
  await h.session.send([{ type: "text", text: "second" }], "queue");
  expect(prompts(h.frames)).toHaveLength(2);
});

it("retains the active turn when a buffered idle is superseded by newer busy before reconciliation", async () => {
  const h = await recoveryBarrier("status");
  const id = h.session.nativeSessionId;
  await firstPrompt(h);
  await h.recover({ statuses: { [id]: { type: "idle" } } });
  for (const type of ["idle", "busy"]) {
    const observed = h.observe(
      (data) =>
        payload(data).type === "session.status" && object(properties(data).status).type === type,
    );
    await h.publish("session.status", { sessionID: id, status: { type } });
    await observed;
  }
  h.release();
  await h.wait((frame) => frame.channel === "lifecycle" && object(frame.data).type === "resynced");
  expect(h.projection.view.thread.status.state).toBe("working");
  const queued = h.session.send([{ type: "text", text: "second" }], "queue");
  void queued.catch(() => {});
  await h.session.resolve("barrier", { kind: "approval", optionId: "once" });
  expect(prompts(h.frames)).toHaveLength(1);
  await h.publish("session.status", { sessionID: id, status: { type: "idle" } });
  await queued;
});
