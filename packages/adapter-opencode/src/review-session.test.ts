import { fileURLToPath } from "node:url";
import { OpenCodeServer } from "./index.ts";
import { readSse } from "@ace/provider-kit/sse";
import { expect, it } from "vitest";
import { object } from "./data.ts";
import { setup } from "./testing/session-harness.ts";
import { recoveryBarrier } from "./testing/recovery-barriers.ts";
const sentPrompts = (frames: { dir: string; channel: string; data: unknown }[]) =>
  frames.filter(
    (f) =>
      f.dir === "send" &&
      f.channel === "http" &&
      String(object(f.data).path).endsWith("/prompt_async"),
  );
it("never forwards foreign buffered recovery evidence to a thread", async () => {
  const h = await setup();
  await h.control("/test/state", {
    duringMessage: {
      sessionID: h.session.nativeSessionId,
      messages: [],
      event: {
        directory: "/foreign",
        payload: { type: "future.secret", properties: { text: "FOREIGN_SECRET" } },
      },
    },
  });
  await h.control("/test/drop", {});
  await h.wait((f) => f.channel === "lifecycle" && object(f.data).type === "resynced");
  expect(JSON.stringify(h.frames)).not.toContain("FOREIGN_SECRET");
});
it("recovers while foreign projects emit on every history read", async () => {
  const h = await setup();
  await h.control("/test/state", {
    onMessage: {
      directory: "/foreign",
      payload: { type: "future.event", properties: { text: "unrelated" } },
    },
  });
  await h.control("/test/drop", {});
  const recovered = await Promise.race([
    h.wait((f) => f.channel === "lifecycle" && object(f.data).type === "resynced").then(() => true),
    h.control("/test/history-reads", { count: 4 }).then(() => false),
  ]);
  expect(recovered).toBe(true);
});
it("holds queued input until an interrupted surviving shell actually terminates", async () => {
  const h = await setup();
  const id = h.session.nativeSessionId;
  await h.session.send([{ type: "text", text: "first" }], "queue");
  const part = {
    id: "shell",
    callID: "shell_call",
    sessionID: id,
    type: "tool",
    tool: "bash",
    state: { status: "running", input: { command: "offline" } },
  };
  await h.publish("message.part.updated", { part });
  await h.wait(
    (f) => object(object(object(object(f.data).payload).properties).part).id === "shell",
  );
  await h.session.interrupt({ cascade: true });
  const queued = h.session.send([{ type: "text", text: "second" }], "queue");
  void queued.catch(() => {});
  await h.session.resolve("barrier", { kind: "approval", optionId: "once" });
  expect(sentPrompts(h.frames)).toHaveLength(1);
  await h.publish("message.part.updated", {
    part: {
      ...part,
      state: {
        status: "completed",
        input: {},
        output: "User aborted the command",
        metadata: { exit: null },
      },
    },
  });
  await queued;
  expect(sentPrompts(h.frames)).toHaveLength(2);
});
it("does not send a queued prompt past a busy child after a provider roundtrip", async () => {
  const h = await setup();
  const id = h.session.nativeSessionId;
  await h.session.send([{ type: "text", text: "first" }], "queue");
  await h.publish("session.created", { info: { id: "child", parentID: id } });
  await h.publish("session.status", { sessionID: "child", status: { type: "busy" } });
  await h.publish("session.status", { sessionID: id, status: { type: "idle" } });
  await h.wait(
    (f) =>
      object(object(object(f.data).payload).properties).sessionID === id &&
      object(object(object(object(f.data).payload).properties).status).type === "idle",
  );
  const queued = h.session.send([{ type: "text", text: "second" }], "queue");
  void queued.catch(() => {});
  await h.session.resolve("barrier", { kind: "approval", optionId: "once" });
  expect(sentPrompts(h.frames)).toHaveLength(1);
  await h.publish("session.status", { sessionID: "child", status: { type: "idle" } });
  await queued;
  expect(sentPrompts(h.frames)).toHaveLength(2);
});
it("cancels local queued work even when the abort endpoint never replies", async () => {
  const timers = new Set<{ callback(): void; delay: number }>();
  const h = await setup({
    runtime: {
      schedule: (callback, delay) => {
        const timer = { callback, delay };
        timers.add(timer);
        return () => {
          timers.delete(timer);
        };
      },
    },
  });
  await h.session.send([{ type: "text", text: "first" }], "queue");
  await h.control("/test/state", { stallAbort: true });
  let rejected = false;
  const queued = h.session.send([{ type: "text", text: "second" }], "queue").catch(() => {
    rejected = true;
  });
  const closing = h.session.close("shutdown");
  void closing.catch(() => {});
  await h.control("/test/abort-entered", {});
  expect(rejected).toBe(true);
  for (const timer of timers) if (timer.delay === 1000) timer.callback();
  await closing;
  await queued;
  expect(h.exits).toEqual([{ deliberate: true }]);
});
it("streams a UTF-8 history value before the response is complete", async () => {
  const cli = fileURLToPath(new URL("./testing/cli.mjs", import.meta.url));
  const server = new OpenCodeServer({
    discovery: { overrides: { opencode: cli, claude: cli, codex: cli, cursor: cli } },
  });
  const signal = new AbortController().signal;
  const control = (path: string, body: unknown) =>
    server.request("POST", path, "/test", body, () => {}, signal);
  try {
    await server.ready();
    const first = { info: { id: "msg_1" }, parts: [{ text: 'é 🧑🏽‍💻 \\\" [{],' }] };
    const second = { info: { id: "msg_2" }, parts: [] };
    await control("/test/state", { messages: { saved: [first, second] }, streamHistory: true });
    const stream = server.history("/session/saved/message?limit=128", "/one", () => {}, signal);
    expect(await stream.next()).toEqual({ done: false, value: first });
    await control("/test/finish-history", {});
    expect(await stream.next()).toEqual({ done: false, value: second });
    expect((await stream.next()).done).toBe(true);
  } finally {
    await server.close();
  }
});
it("imports paged history and keeps the latest completed turn settled on subsequent recovery", async () => {
  const h = await setup();
  const id = h.session.nativeSessionId;
  await h.open("/two");
  await h.session.close("idle");
  const messages = Array.from({ length: 260 }, (_, i) => ({
    info: {
      id: `msg_${String(i).padStart(4, "0")}`,
      sessionID: id,
      role: i % 2 ? "assistant" : "user",
      ...(i % 2
        ? {
            parentID: `msg_${String(i - 1).padStart(4, "0")}`,
            time: { created: i, completed: i + 1 },
          }
        : { time: { created: i } }),
    },
    parts: [
      {
        id: `part_${i}`,
        sessionID: id,
        messageID: `msg_${String(i).padStart(4, "0")}`,
        type: "text",
        text: `restored_${i}`,
        time: { end: i + 1 },
      },
    ],
  }));
  await h.control("/test/state", {
    sessions: [{ id, directory: "/one" }],
    statuses: { [id]: { type: "idle" } },
    messages: { [id]: messages },
  });
  const resumed = await h.open("/one", id);
  expect(h.renderedText).toContain("restored_0");
  expect(h.renderedText).toContain("restored_259");
  expect(h.projection.view.thread.status.state).toBe("done");
  await h.control("/test/drop", {});
  await h.wait((f) => f.channel === "lifecycle" && object(f.data).type === "resynced");
  expect(h.projection.view.thread.status.state).toBe("done");
  expect(Object.values(h.projection.view.runs)).toHaveLength(1);
  await resumed.close("idle");
});

it("converts a live retry with injected receipt clocks after restoring old history", async () => {
  let monotonic = 0;
  let wallTime = 1_000_000;
  const h = await setup({
    runtime: {
      monotonic: () => monotonic,
      wallTime: () => wallTime,
      entropy: (bytes) => "a".repeat(bytes * 2),
    },
  });
  monotonic = 200;
  wallTime = 1_000_200;
  await h.publish("message.updated", {
    sessionID: h.session.nativeSessionId,
    info: { id: "old_user", role: "user", time: { created: 1 } },
  });
  await h.publish("session.status", {
    sessionID: h.session.nativeSessionId,
    status: { type: "retry", next: 1_005_200, message: "overloaded" },
  });
  await h.wait(
    (f) => f.channel === "sse" && object(object(f.data).payload).type === "session.status",
  );
  expect(Object.values(h.projection.view.agents)[0]?.status).toMatchObject({ until: 5200 });
});
it("bounds recovery even when an owned project emits on every history read", async () => {
  const h = await setup();
  await h.control("/test/state", {
    onMessage: {
      directory: "/one",
      payload: { type: "future.event", properties: { text: "owned" } },
    },
  });
  await h.control("/test/drop", {});
  const recovered = await Promise.race([
    h.wait((f) => f.channel === "lifecycle" && object(f.data).type === "resynced").then(() => true),
    h.control("/test/history-reads", { count: 4 }).then(() => false),
  ]);
  expect(recovered).toBe(true);
});
it("does not replay an older buffered idle over a newer busy REST snapshot", async () => {
  const h = await recoveryBarrier("status");
  const id = h.session.nativeSessionId;
  await h.session.send([{ type: "text", text: "first" }], "queue");
  await h.recover({
    onMessage: {
      directory: "/one",
      payload: { type: "session.status", properties: { sessionID: id, status: { type: "idle" } } },
    },
  });
  h.release();
  await h.wait((f) => f.channel === "lifecycle" && object(f.data).type === "resynced");
  expect(h.projection.view.thread.status.state).toBe("working");
  const queued = h.session.send([{ type: "text", text: "second" }], "queue");
  void queued.catch(() => {});
  await h.session.resolve("barrier", { kind: "approval", optionId: "once" });
  expect(sentPrompts(h.frames)).toHaveLength(1);
});

it("stops a surviving shell through its child owner instead of aborting the root", async () => {
  const h = await setup();
  await h.session.send([{ type: "text", text: "first" }], "queue");
  await h.publish("session.created", {
    info: { id: "child", parentID: h.session.nativeSessionId },
  });
  await h.publish("message.updated", {
    sessionID: "child",
    info: { id: "child_user", role: "user" },
  });
  await h.publish("session.status", { sessionID: "child", status: { type: "busy" } });
  await h.publish("message.part.updated", {
    part: {
      id: "shell",
      callID: "shell_call",
      sessionID: "child",
      type: "tool",
      tool: "bash",
      state: { status: "running", input: { command: "offline" } },
    },
  });
  await h.publish("session.status", { sessionID: "child", status: { type: "idle" } });
  await h.wait(
    (f) =>
      object(object(object(f.data).payload).properties).sessionID === "child" &&
      object(object(object(object(f.data).payload).properties).status).type === "idle",
  );
  await h.session.stopTask("survivor:shell_call");
  const info = object(await h.control("/test/requests"));
  expect(JSON.stringify(info)).toContain('"path":"/session/child/abort"');
  expect(JSON.stringify(info)).not.toContain(
    `"path":"/session/${h.session.nativeSessionId}/abort"`,
  );
});
it("rearms a grace timer that fires before the injected deadline", async () => {
  let clock = 0;
  const timers = new Set<{ at: number; callback(): void }>();
  const h = await setup({
    runtime: {
      monotonic: () => clock,
      schedule: (callback, delay) => {
        const timer = { at: clock + delay, callback };
        timers.add(timer);
        return () => {
          timers.delete(timer);
        };
      },
    },
  });
  const id = h.session.nativeSessionId;
  await h.session.send([{ type: "text", text: "first" }], "queue");
  await h.publish("session.created", { info: { id: "child", parentID: id } });
  await h.publish("message.part.updated", {
    part: {
      id: "spawn",
      callID: "spawn_call",
      sessionID: id,
      type: "tool",
      tool: "task",
      state: { status: "completed", input: {}, metadata: { background: true, sessionId: "child" } },
    },
  });
  await h.publish("session.status", { sessionID: id, status: { type: "idle" } });
  await h.publish("session.status", { sessionID: "child", status: { type: "idle" } });
  await h.wait(
    (f) =>
      object(object(object(f.data).payload).properties).sessionID === "child" &&
      object(object(object(object(f.data).payload).properties).status).type === "idle",
  );
  const queued = h.session.send([{ type: "text", text: "second" }], "queue");
  void queued.catch(() => {});
  clock = 2999;
  for (const timer of Array.from(timers)) {
    timers.delete(timer);
    timer.callback();
  }
  await h.session.resolve("early_barrier", { kind: "approval", optionId: "once" });
  expect(sentPrompts(h.frames)).toHaveLength(1);
  clock = 3000;
  for (const timer of Array.from(timers))
    if (timer.at <= clock) {
      timers.delete(timer);
      timer.callback();
    }
  await h.session.resolve("deadline_barrier", { kind: "approval", optionId: "once" });
  expect(sentPrompts(h.frames)).toHaveLength(2);
  await queued;
});
it("does not disclose a foreign project event marked with global directory", async () => {
  const h = await setup();
  await h.control("/test/state", {
    duringMessage: {
      sessionID: h.session.nativeSessionId,
      messages: [],
      event: {
        directory: "global",
        project: "/foreign",
        payload: { type: "future.secret", properties: { text: "FOREIGN_PROJECT_SECRET" } },
      },
    },
  });
  await h.control("/test/drop", {});
  await h.wait((f) => f.channel === "lifecycle" && object(f.data).type === "resynced");
  expect(JSON.stringify(h.frames)).not.toContain("FOREIGN_PROJECT_SECRET");
});

it("reconnects the event stream before restoring a heartbeat-gap recovery", async () => {
  let gap: ((elapsed: number) => void) | undefined;
  const h = await setup({
    runtime: {
      stream: (url, options) => {
        gap = options.heartbeat?.onGap;
        return readSse(url, options);
      },
    },
  });
  gap?.(25_001);
  await h.wait((f) => f.channel === "lifecycle" && object(f.data).type === "resynced");
  expect(object(await h.control("/test/requests")).connections).toBe(2);
});
