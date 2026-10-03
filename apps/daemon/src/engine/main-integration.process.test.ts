import { createScriptedAdapter } from "@ace/adapter-testkit";
import { afterEach, expect, test } from "vitest";
import { backup } from "node:sqlite";
import { join } from "node:path";
import { Command } from "@ace/protocol";
import { Engine, Store } from "@ace/daemon";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});
const input = [{ type: "text" as const, text: "next" }];
function resumedProvider(
  h: Awaited<ReturnType<typeof harness>>,
  frames: ReturnType<typeof scriptFrames>,
) {
  const discovery = { installed: true, auth: "logged_in" as const, loginHint: "unused" };
  const resumed = createScriptedAdapter({
    provider: "codex",
    nativeSessionId: "native-1",
    capabilities: h.adapter.capabilities(discovery),
    createTranslator: () => ({ translate: frames.translate, tick: () => [] }),
    steps: [{ on: "send", frames: [frames.frame(start, end)] }],
  });
  h.registry.register(resumed, discovery);
  return resumed;
}

test("provider queued work holds engine input until the provider queue settles", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [frames.frame(start, end, { type: "queue.changed", source: "provider", count: 2 })],
      },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "queue" });
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
  const context = h.contexts[0];
  if (!context) throw new Error("Missing session");
  context.onFrame(frames.frame({ type: "queue.changed", source: "provider", count: 1 }));
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
  context.onFrame(frames.frame({ type: "queue.changed", source: "provider", count: 0 }));
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(2);
  expect(h.store.getThread(id)?.status.state).toBe("done");
  expect(h.errors).toEqual([]);
});

test("provider settlement fires at its deadline before the next core deadline", async () => {
  const frames = scriptFrames();
  let deadline: number | undefined = 1050;
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames, {
    nextDeadline: () => deadline,
    tick: (now) => {
      if (deadline === undefined || now < deadline) return [];
      deadline = undefined;
      return [end];
    },
  });
  cleanups.push(h.close);
  const id = await h.create();
  h.clock.advance(1049);
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("working");
  h.clock.advance(1050);
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("done");
  expect(h.errors).toEqual([]);
});

test("restart retires provider queued work without replaying it or leaving a ghost queue", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [frames.frame(start, end, { type: "queue.changed", source: "provider", count: 1 })],
      },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  const resumed = resumedProvider(h, frames);
  const path = join(h.home, "recovery.sqlite");
  await backup(
    h.store.atomic((db) => db),
    path,
  );
  const store = new Store(path);
  const engine = new Engine(store, { registry: h.registry, clock: h.clock });
  cleanups.push(async () => {
    await engine.close();
    store.close();
  });
  await engine.flush();
  expect(store.getThread(id)?.status.state).not.toBe("waiting");
  expect(
    Object.values(store.snapshotThread(id).items).some(
      (item) => item.type === "notice" && item.text.includes("uncertain"),
    ),
  ).toBe(true);
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
  // Resume via the recovered handler, not the crashed engine.
  const value = Command.parse({
    id: "recovered-send",
    deviceId: "device",
    payload: {
      type: "thread.send",
      threadId: id,
      input,
      delivery: "queue",
    },
  });
  expect(
    store.recordCommand(value.id, value.deviceId, () => engine.handler.handle(value, store)).ok,
  ).toBe(true);
  await engine.flush();
  expect(resumed.commands.filter((entry) => entry.type === "send")).toHaveLength(1);
  expect(store.getThread(id)?.status.state).toBe("done");
});

test("a provider exit clears native queued work so a later send can resume", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [frames.frame(start, end, { type: "queue.changed", source: "provider", count: 1 })],
      },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  const resumed = resumedProvider(h, frames);
  const context = h.contexts[0];
  if (!context) throw new Error("Missing session");
  context.onExit({ deliberate: false, message: "provider died" });
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).not.toBe("waiting");
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  expect(resumed.commands.filter((entry) => entry.type === "send")).toHaveLength(1);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("targeted root interrupts use the same native root identity as the opened session", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start)] },
      { on: "interrupt", frames: [frames.frame({ ...end, outcome: "interrupted" })] },
    ],
    frames,
  );
  cleanups.push(h.close);
  h.registry.register(
    {
      ...h.adapter,
      async openSession(context) {
        const session = await h.adapter.openSession(context);
        return {
          ...session,
          async interrupt(target) {
            if (target.agent !== context.rootKey) throw new Error("Unknown native root");
            await session.interrupt(target);
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const id = await h.create();
  const root = Object.values(h.store.snapshotThread(id).agents)[0];
  if (!root) throw new Error("Missing root");
  h.command({ type: "thread.interrupt", threadId: id, agentId: root.id, cascade: false });
  await h.engine.flush();
  expect(Object.values(h.store.snapshotThread(id).runs).map((run) => run.state)).toEqual([
    "interrupted",
  ]);
  expect(h.adapter.commands.filter((entry) => entry.type === "interrupt")).toHaveLength(1);
  expect(
    Object.values(h.store.snapshotThread(id).items).filter(
      (item) => item.type === "notice" && item.level === "error",
    ),
  ).toEqual([]);
});

test("durable input admission transfers the engine queue without manufacturing a run", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            { type: "input.admitted", agent: "root", nativeInputId: "input-one" },
            { type: "queue.changed", source: "provider", count: 1 },
          ),
        ],
      },
    ],
    frames,
  );
  cleanups.push(h.close);
  const id = await h.create();
  expect(Object.values(h.store.snapshotThread(id).runs)).toEqual([]);
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "queue" });
  const context = h.contexts[0];
  if (!context) throw new Error("Missing provider context");
  context.onFrame(frames.frame({ type: "queue.changed", source: "provider", count: 0 }, start));
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("working");
  context.onFrame(frames.frame(end));
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("a run after durable admission cannot acknowledge the next unanswered steering input", async () => {
  const frames = scriptFrames();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(
            { type: "input.admitted", agent: "root", nativeInputId: "first" },
            { type: "queue.changed", source: "provider", count: 1 },
          ),
        ],
      },
      { on: "send", frames: [] },
    ],
    frames,
    { steer: true },
  );
  cleanups.push(h.close);
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input, delivery: "steer" });
  await h.engine.flush();
  const context = h.contexts[0];
  if (!context) throw new Error("Missing provider context");
  context.onFrame(
    frames.frame({ type: "queue.changed", source: "provider", count: 0 }, start, end),
  );
  await h.engine.flush();
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "queue" });
  context.onFrame(frames.frame({ type: "input.admitted", agent: "root", nativeInputId: "second" }));
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("a recovered admission for a failed send cannot acknowledge a newer steering input", async () => {
  const frames = scriptFrames();
  const h = await harness([], frames, { steer: true });
  cleanups.push(h.close);
  const commands: string[] = [];
  let context: Parameters<typeof h.adapter.openSession>[0] | undefined;
  h.registry.register(
    {
      ...h.adapter,
      async openSession(ctx) {
        context = ctx;
        const session = await h.adapter.openSession(ctx);
        return {
          ...session,
          async send(_input, _delivery, commandId) {
            if (!commandId) throw new Error("Missing command correlation");
            commands.push(commandId);
            if (commands.length === 1) throw new Error("Uncertain admission acknowledgement");
          },
        };
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input, delivery: "steer" });
  await h.engine.flush();
  const [first, second] = commands;
  if (!context || !first || !second) throw new Error("Missing sent input");
  context.onFrame(
    frames.frame(
      { type: "input.admitted", agent: "root", nativeInputId: "first", commandId: first },
      { type: "queue.changed", source: "provider", count: 1 },
    ),
  );
  await h.engine.flush();
  context.onFrame(
    frames.frame({ type: "queue.changed", source: "provider", count: 0 }, start, end),
  );
  await h.engine.flush();
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "queue" });
  expect(Object.values(h.store.snapshotThread(id).runs)).toHaveLength(1);
  context.onFrame(
    frames.frame({
      type: "input.admitted",
      agent: "root",
      nativeInputId: "second",
      commandId: second,
    }),
  );
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("done");
});
