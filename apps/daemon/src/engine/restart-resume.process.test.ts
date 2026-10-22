import { backup } from "node:sqlite";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { Fact } from "@ace/core";
import { Capabilities, type ThreadId } from "@ace/protocol";
import { Engine, Store } from "@ace/daemon";
import {
  cleanupRecovery,
  crashCopy,
  dispatch,
  fixture,
  replaceProvider,
  restart,
  sends,
  text,
  type RecoveryHarness,
} from "./recovery-test-support.ts";
import { end, question, scriptFrames, start, task } from "./test-support.ts";

/*
 * A restart that cuts a turn short continues it by itself, once and safely: one restart
 * continuation, ahead of queued messages, and only for work that was running. A turn waiting on
 * the person, a stopped turn, a provider that can't resume and a turn that keeps dying across
 * restarts wait for the person instead. A provider that dies while ace keeps running still holds.
 */
afterEach(cleanupRecovery);

const inputs = (adapter: Parameters<typeof sends>[0]) =>
  sends(adapter).flatMap((command) =>
    command.input.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );
const restartInput = (value: string) => value.startsWith("ace restarted while you were working");

function restartNotices(store: Store, id: ThreadId) {
  return Object.values(store.snapshotThread(id).items).flatMap((item) =>
    item.type === "notice" && item.code === "restart_interrupted" ? [item.text] : [],
  );
}

/** A thread whose first turn is still running, with `queued` waiting behind it. */
async function interruptedThread(queued: string[] = [], first: Fact[] = [start]) {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(...first)] }], frames);
  const id = await h.create();
  for (const message of queued)
    h.command({ type: "thread.send", threadId: id, input: text(message) }, "device", message);
  await h.engine.flush();
  const replacement = replaceProvider(h, frames, [
    { on: "send", frames: [frames.frame(start, end)] },
    { on: "send", frames: [frames.frame(start, end)] },
    { on: "send", frames: [frames.frame(start, end)] },
  ]);
  return { h, id, frames, replacement };
}

/** A second thread in the same workspace, its first turn started with `message`. */
async function createThread(h: RecoveryHarness, existing: ThreadId, message: string) {
  const result = h.command({
    type: "thread.create",
    workspaceId: h.workspace,
    provider: "codex",
    model: "model",
    input: text(message),
  });
  if (!result.ok) throw new Error(result.error);
  const id = h.store.listThreads().find((thread) => thread.id !== existing)?.id;
  if (!id) throw new Error("Missing second thread");
  await h.engine.flush();
  return id;
}

/** Crash a recovered copy again: snapshot its database and start a fresh engine on it. */
async function crashAgain(h: RecoveryHarness, store: Store, name: string) {
  const path = join(h.home, `${name}.sqlite`);
  await backup(
    store.atomic((db) => db),
    path,
  );
  const copy = new Store(path);
  const engine = new Engine(copy, { registry: h.registry, clock: h.clock });
  await engine.flush();
  return {
    store: copy,
    engine,
    close: async () => {
      await engine.close();
      await copy.close();
    },
  };
}

test("a turn a crash cut short continues by itself with one restart continuation", async () => {
  const { h, id, replacement } = await interruptedThread([], [start, task]);
  const recovered = await crashCopy(h);
  await recovered.engine.flush();

  const sent = inputs(replacement);
  expect(sent).toHaveLength(1);
  expect(restartInput(sent[0] ?? "")).toBe(true);
  // The agent hears which background work died with the old provider.
  expect(sent[0]).toContain("Background build");
  expect(h.contexts.at(-1)?.resume).toEqual({ nativeSessionId: "native-1" });
  expect(restartNotices(recovered.store, id)).toEqual(["Interrupted by a restart. Continuing."]);
  const origins = Object.values(recovered.store.snapshotThread(id).items).flatMap((item) =>
    item.type === "message" && item.role === "user" && item.origin ? [item.origin.kind] : [],
  );
  expect(origins).toContain("restart");
  expect(recovered.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
  expect(recovered.store.getThread(id)?.status.state).toBe("done");
});

test("a turn a graceful restart stopped continues by itself too", async () => {
  const { h, id, replacement } = await interruptedThread();
  const engine = await restart(h);
  await engine.flush();
  const sent = inputs(replacement);
  expect(sent).toHaveLength(1);
  expect(restartInput(sent[0] ?? "")).toBe(true);
  expect(restartNotices(h.store, id)).toEqual(["Interrupted by a restart. Continuing."]);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("messages queued behind the interrupted turn go out after the continuation, in order", async () => {
  const { h, id, replacement } = await interruptedThread(["a", "b"]);
  const recovered = await crashCopy(h);
  await recovered.engine.flush();
  const sent = inputs(replacement);
  expect(restartInput(sent[0] ?? "")).toBe(true);
  expect(sent.slice(1)).toEqual(["a", "b"]);
  expect(recovered.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
});

test("only a thread that was running when ace stopped continues after a restart", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start)] }], frames);
  const finished = await h.create();
  const running = await createThread(h, finished, "second");
  // The first thread's turn ends before ace stops; the second is still running.
  await h.contexts[0]?.onFrame(frames.frame(end));
  await h.engine.flush();
  expect(h.store.getThread(finished)?.status.state).toBe("done");
  const replacement = replaceProvider(h, frames, [
    { on: "send", frames: [frames.frame(start, end)] },
  ]);
  const recovered = await crashCopy(h);
  await recovered.engine.flush();
  expect(replacement.sessions).toHaveLength(1);
  expect(inputs(replacement).map(restartInput)).toEqual([true]);
  expect(restartNotices(recovered.store, running)).toEqual([
    "Interrupted by a restart. Continuing.",
  ]);
  expect(restartNotices(recovered.store, finished)).toEqual([]);
  expect(recovered.store.getThread(finished)?.status.state).toBe("done");
  expect(recovered.engine.queue(finished)).toMatchObject({ paused: false, messages: [] });
});

test("a turn waiting on the person's answer shows the request again and doesn't resume", async () => {
  const { h, id, replacement } = await interruptedThread([], [start, question]);
  expect(h.store.getThread(id)?.status.state).toBe("needs_you");
  const recovered = await crashCopy(h);
  await recovered.engine.flush();
  expect(sends(replacement)).toEqual([]);
  expect(recovered.engine.queue(id)).toMatchObject({ paused: true, reason: "restart" });
  expect(restartNotices(recovered.store, id)).toEqual([
    'Interrupted by a restart while waiting for your answer to "Continue?". Continue and the agent asks again.',
  ]);
  expect(recovered.store.getThread(id)?.status.state).not.toBe("done");

  // Continue sends the restart continuation; the agent asks again from there.
  expect(
    dispatch(recovered.store, recovered.engine, {
      type: "thread.resume",
      threadId: id,
      expectedRevision: recovered.engine.queue(id).revision,
    }).ok,
  ).toBe(true);
  await recovered.engine.flush();
  expect(inputs(replacement).map(restartInput)).toEqual([true]);
});

test("a thread stopped while its turn wound down stays stopped across a restart", async () => {
  const frames = scriptFrames();
  // The provider takes the interrupt but never reports the turn's end before ace stops.
  const h = await fixture(
    [
      { on: "send", frames: [frames.frame(start)] },
      { on: "interrupt", frames: [] },
    ],
    frames,
  );
  const stopped = await h.create();
  expect(h.command({ type: "thread.interrupt", threadId: stopped, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  expect(h.engine.queue(stopped)).toMatchObject({ paused: true, reason: "stopped" });
  const running = await createThread(h, stopped, "second");
  const replacement = replaceProvider(h, frames, [
    { on: "send", frames: [frames.frame(start, end)] },
  ]);
  const recovered = await crashCopy(h);
  await recovered.engine.flush();
  // Only the thread nobody stopped continues.
  expect(replacement.sessions).toHaveLength(1);
  expect(recovered.store.getThread(running)?.status.state).toBe("done");
  expect(recovered.engine.queue(stopped)).toMatchObject({ paused: true, reason: "stopped" });
  expect(restartNotices(recovered.store, stopped)).toEqual(["Interrupted by a restart"]);
});

test("a provider that can't resume its session waits for the person's next message", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start)] }], frames);
  const id = await h.create();
  const capabilities = Capabilities.parse({
    ...h.registry.get("codex").capabilities,
    resume: false,
  });
  const replacement = replaceProvider(h, frames, [
    { on: "send", frames: [frames.frame(start, end)] },
  ]);
  h.registry.register(
    { ...h.registry.get("codex").adapter, capabilities: () => capabilities },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  const recovered = await crashCopy(h);
  await recovered.engine.flush();
  expect(sends(replacement)).toEqual([]);
  expect(recovered.engine.queue(id)).toMatchObject({ paused: true, reason: "restart" });
  expect(restartNotices(recovered.store, id)).toEqual([
    "Interrupted by a restart. This agent can't pick its session back up by itself; send a message to carry on.",
  ]);
});

test("a turn that keeps dying across restarts stops continuing by itself after three tries", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start)] }], frames);
  const id = await h.create();
  // Every resumed turn starts and is cut short by the next crash.
  const replacement = replaceProvider(h, frames, [{ on: "send", frames: [frames.frame(start)] }]);
  let current: { store: Store; engine: Engine; close?: () => Promise<void> } = await crashCopy(h);
  const copies: (() => Promise<void>)[] = [];
  for (let attempt = 2; attempt <= 4; attempt++) {
    await current.engine.flush();
    const next = await crashAgain(h, current.store, `crash-${attempt}`);
    copies.push(next.close);
    current = next;
  }
  await current.engine.flush();
  try {
    expect(inputs(replacement).map(restartInput)).toEqual([true, true, true]);
    expect(current.engine.queue(id)).toMatchObject({ paused: true, reason: "restart" });
    expect(restartNotices(current.store, id).at(-1)).toBe(
      "Interrupted by a restart 3 times in a row, so ace stopped continuing it by itself. Continue when ready.",
    );

    // The person's Continue carries on, and starts a fresh count.
    expect(
      dispatch(current.store, current.engine, {
        type: "thread.resume",
        threadId: id,
        expectedRevision: current.engine.queue(id).revision,
      }).ok,
    ).toBe(true);
    await current.engine.flush();
    expect(inputs(replacement)).toHaveLength(4);
    const after = await crashAgain(h, current.store, "crash-after-continue");
    copies.push(after.close);
    await after.engine.flush();
    expect(inputs(replacement)).toHaveLength(5);
  } finally {
    for (const close of copies.toReversed()) await close();
  }
});

test("a provider that dies mid-turn while ace keeps running holds its queue until Resume", async () => {
  const { h, id, replacement } = await interruptedThread(["a"]);
  h.contexts.at(-1)?.onExit({ deliberate: false, message: "provider died" });
  await h.engine.flush();
  expect(sends(replacement)).toEqual([]);
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "restart" });
  dispatch(h.store, h.engine, {
    type: "thread.resume",
    threadId: id,
    expectedRevision: h.engine.queue(id).revision,
  });
  await h.engine.flush();
  expect(inputs(replacement)).toEqual(["Continue where you left off.", "a"]);
});

test("a provider released after its idle window resumes with exactly the next message", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
    { idleMs: 5 * 60_000 },
  );
  const id = await h.create();
  h.clock.advance(h.clock.now() + 5 * 60_000);
  await h.engine.flush();
  expect(h.adapter.commands.filter((command) => command.type === "close")).toEqual([
    { type: "close", reason: "idle" },
  ]);
  expect(h.engine.queue(id)).toMatchObject({ paused: false });

  h.command({ type: "thread.send", threadId: id, input: text("next") });
  await h.engine.flush();
  expect(inputs(h.adapter)).toEqual(["first", "next"]);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("a message sent after Stop goes out as the next turn instead of waiting behind the stop", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      { on: "send", frames: [frames.frame(start)] },
      { on: "interrupt", frames: [frames.frame({ ...end, outcome: "interrupted" })] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  const id = await h.create();
  expect(h.command({ type: "thread.interrupt", threadId: id, cascade: true }).ok).toBe(true);
  await h.engine.flush();
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "stopped" });
  expect(inputs(h.adapter)).toEqual(["first"]);

  h.command({ type: "thread.send", threadId: id, input: text("next") });
  await h.engine.flush();
  expect(inputs(h.adapter)).toEqual(["first", "next"]);
  expect(h.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
  expect(h.store.getThread(id)?.status.state).toBe("done");
});
