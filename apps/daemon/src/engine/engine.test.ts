import { afterEach, expect, test } from "vitest";
import { Command, type ThreadId } from "@ace/protocol";
import { applyEvent, createThreadView } from "@ace/projection";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Store, Engine } from "@ace/daemon";
import { harness, scriptFrames, start, end, question, task, until } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const input = [{ type: "text" as const, text: "next" }];
function track<T extends Awaited<ReturnType<typeof harness>>>(h: T): T {
  cleanups.push(h.close);
  return h;
}
function view(store: Store, id: ThreadId) {
  const result = store.acquireThread(id);
  store.releaseThread(id);
  return result;
}

test("a websocket send translates provider frames into the client's completed transcript", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [
        { on: "send", frames: [frames.frame(start, end)] },
        {
          on: "send",
          frames: [
            frames.frame(start),
            frames.frame({
              type: "item.delta",
              agent: "root",
              item: "answer",
              field: "text",
              append: "Hello from the provider",
            }),
            frames.frame(end),
          ],
        },
      ],
      frames,
    ),
  );
  const id = await h.create();
  const client = await h.connect("device");
  client.send({
    type: "subscribe",
    subscriptionId: "thread",
    scope: { kind: "thread", threadId: id },
  });
  const snapshot = await until(client, (message) => message.type === "snapshot");
  if (snapshot.type !== "snapshot" || snapshot.view.kind !== "thread")
    throw new Error("Missing snapshot");
  const thread = h.store.getThread(id);
  if (!thread) throw new Error("Missing thread");
  const projected = createThreadView(thread);
  for (const event of h.store.readEvents({ afterSeq: 0, threadId: id, limit: 1000 })) {
    projected.seq = event.seq - 1;
    applyEvent(projected, event);
  }
  const command = Command.parse({
    id: "send",
    deviceId: "device",
    payload: { type: "thread.send", threadId: id, input, delivery: "queue" },
  });
  client.send({ type: "command", command });
  let accepted = false;
  let completed = false;
  while (!accepted || !completed) {
    const message = await client.next();
    if (message.type === "commandResult") {
      expect(message.ok).toBe(true);
      accepted = true;
    }
    if (message.type === "events")
      for (const event of message.events) {
        applyEvent(projected, event);
        if (event.payload.type === "thread.updated" && event.payload.status?.state === "done")
          completed = true;
      }
  }
  expect(
    Object.values(projected.items).some(
      (item) =>
        item.type === "message" &&
        item.parts.some((part) => part.type === "text" && part.text === "Hello from the provider"),
    ),
  ).toBe(true);
  expect(projected.thread.status.state).toBe("done");
  expect(h.contexts[0]?.cwd).toBe(realpathSync(h.home));
  expect(h.contexts[0]?.model).toBe("model");
});

test("a snapshot write failure rolls back the events and client publication together", async () => {
  const frames = scriptFrames();
  const h = track(await harness([{ on: "send", frames: [frames.frame(start)] }], frames));
  const id = await h.create();
  const seq = h.store.headSeq();
  let published = false;
  const stop = h.store.subscribe(() => {
    published = true;
  });
  h.store.atomic((db) =>
    db.exec(`CREATE TRIGGER reject_snapshot BEFORE UPDATE ON thread_state
    BEGIN SELECT RAISE(ABORT, 'injected snapshot failure'); END`),
  );
  const context = h.contexts[0];
  if (!context) throw new Error("Missing provider context");
  context.onFrame(frames.frame(end));
  // The actor reports the persistence failure; observers never see its rolled-back events.
  await h.engine.flush();
  expect(
    h.errors.some(
      (error) => error instanceof Error && error.message.includes("injected snapshot failure"),
    ),
  ).toBe(true);
  expect(h.store.headSeq()).toBe(seq);
  expect(published).toBe(false);
  const reopened = new Store(h.path);
  expect(reopened.getThread(id)?.status.state).toBe("working");
  reopened.close();
  h.store.atomic((db) => db.exec("DROP TRIGGER reject_snapshot"));
  const recoveryStore = new Store(h.path);
  const recovery = new Engine(recoveryStore, { registry: h.registry, clock: h.clock });
  await recovery.flush();
  expect(recoveryStore.getThread(id)?.status.state).toBe("failed");
  await recovery.close();
  recoveryStore.close();
  stop();
});

test("two websocket devices answering one interaction produce exactly one accepted resolution", async () => {
  const frames = scriptFrames();
  const { promise: resolveGate, resolve: release } = Promise.withResolvers<void>();
  const h = track(
    await harness(
      [{ on: "send", frames: [frames.frame(start, question)] }, { on: "resolve" }],
      frames,
      { resolveGate },
    ),
  );
  const id = await h.create();
  const interaction = Object.values(view(h.store, id).interactions)[0];
  if (!interaction) throw new Error("Missing interaction");
  const devices = await Promise.all([h.connect("phone"), h.connect("desktop")]);
  for (const [index, client] of devices.entries())
    client.send({
      type: "command",
      command: Command.parse({
        id: `answer-${index}`,
        deviceId: index === 0 ? "phone" : "desktop",
        payload: {
          type: "interaction.resolve",
          interactionId: interaction.id,
          resolution: { kind: "approval", optionId: "yes" },
        },
      }),
    });
  const results = await Promise.all(
    devices.map((client) =>
      until(client, (message) => message.type === "commandResult" || message.type === "error"),
    ),
  );
  release();
  expect(view(h.store, id).interactions[interaction.id]?.state).toBe("pending");
  expect(results.filter((result) => result.type === "commandResult" && result.ok)).toHaveLength(1);
  expect(
    results.filter(
      (result) => result.type === "commandResult" && result.error === "already_resolved",
    ),
  ).toHaveLength(1);
  await h.engine.flush();
  const resolved = view(h.store, id).interactions[interaction.id];
  expect(resolved?.state).toBe("resolved");
  expect(["phone", "desktop"]).toContain(resolved?.resolvedBy);
  expect(h.adapter.commands.filter((command) => command.type === "resolve")).toHaveLength(1);
});

test("the next core deadline ticks both translator and core without early expiry", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start)] }], frames, {
      tick: () => [{ type: "queue.changed", count: 1 }],
    }),
  );
  const id = await h.create();
  h.clock.advance(1100);
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("working");
  expect(Object.values(view(h.store, id).items).some((item) => item.type === "notice")).toBe(false);
  h.clock.advance(1101);
  await h.engine.flush();
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "queue" });
  expect(Object.values(view(h.store, id).agents).map((agent) => agent.status.state)).toEqual([
    "unresponsive",
  ]);
});

test("an idle session closes at the configured deadline and resumes on the next send", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start, end)] }], frames, { idleMs: 500 }),
  );
  const id = await h.create();
  h.clock.advance(1499);
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "close")).toEqual([]);
  h.clock.advance(1500);
  await h.engine.flush();
  expect(h.adapter.commands.at(-1)).toEqual({ type: "close", reason: "idle" });
  expect(h.store.getThread(id)?.status.state).toBe("done");
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  expect(h.contexts[1]?.resume).toEqual({ nativeSessionId: "native-1" });
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(2);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("startup expires interactions and ends work saved by a daemon that died", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness([{ on: "send", frames: [frames.frame(start, question, task)] }], frames),
  );
  const id = await h.create();
  // Opening another SQLite connection simulates a fresh daemon reading crash-era durable state.
  const restartedStore = new Store(h.path);
  const recovered = new Engine(restartedStore, { registry: h.registry, clock: h.clock });
  await recovered.flush();
  expect(restartedStore.getThread(id)?.status.state).toBe("failed");
  const recoveredView = view(restartedStore, id);
  expect(Object.values(recoveredView.interactions).map((item) => item.state)).toEqual(["expired"]);
  expect(Object.values(recoveredView.backgroundTasks).map((item) => item.status)).toEqual([
    "unknown",
  ]);
  expect(Object.values(recoveredView.runs).map((run) => run.state)).toEqual(["failed"]);
  await recovered.close();
  restartedStore.close();
});

test("queued input waits for background work and releases when the whole tree settles", async () => {
  const frames = scriptFrames();
  const h = track(
    await harness(
      [
        { on: "send", frames: [frames.frame(start, task, end)] },
        {
          on: "stopTask",
          frames: [frames.frame({ type: "background.ended", task: "shell", status: "stopped" })],
        },
        { on: "send", frames: [frames.frame(start, end)] },
      ],
      frames,
    ),
  );
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input, delivery: "queue" });
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(1);
  expect(h.store.getThread(id)?.status).toEqual({ state: "waiting", on: "background_task" });
  const background = Object.values(view(h.store, id).backgroundTasks)[0];
  if (!background) throw new Error("Missing task");
  h.command({ type: "background_task.stop", taskId: background.id });
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "send")).toHaveLength(2);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("a provider intent failure becomes a visible notice and is never resent", async () => {
  const frames = scriptFrames();
  const h = track(await harness([{ on: "interrupt" }], frames));
  const id = await h.create();
  expect(
    Object.values(view(h.store, id).items).some(
      (item) =>
        item.type === "notice" &&
        item.level === "error" &&
        item.text.includes("expected interrupt, got send"),
    ),
  ).toBe(true);
  await h.engine.flush();
  const db = new DatabaseSync(h.path);
  expect(db.prepare("SELECT status, attempts FROM intents").get()).toEqual({
    status: "failed",
    attempts: 1,
  });
  db.close();
});
