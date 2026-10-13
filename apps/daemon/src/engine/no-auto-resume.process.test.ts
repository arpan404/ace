import { afterEach, expect, test } from "vitest";
import {
  cleanupRecovery,
  crashCopy,
  dispatch,
  fixture,
  replaceProvider,
  sends,
  text,
} from "./recovery-test-support.ts";
import { end, scriptFrames, start } from "./test-support.ts";

/*
 * Owner rule: nothing runs unless the person sends something. A daemon restart or a provider
 * that dies mid-turn holds the interrupted turn and its queue; only Resume or the person's next
 * message carries on. A provider released after its idle window is not an interruption.
 */
afterEach(cleanupRecovery);

const inputs = (adapter: Parameters<typeof sends>[0]) =>
  sends(adapter).flatMap((command) =>
    command.input.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  );

/** A thread whose first turn is still running, with `queued` waiting behind it. */
async function interruptedThread(queued: string[] = []) {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start)] }], frames);
  const id = await h.create();
  for (const message of queued)
    h.command({ type: "thread.send", threadId: id, input: text(message) }, "device", message);
  await h.engine.flush();
  const replacement = replaceProvider(h, frames, [
    { on: "send", frames: [frames.frame(start, end)] },
    { on: "send", frames: [frames.frame(start, end)] },
    { on: "send", frames: [frames.frame(start, end)] },
  ]);
  return { h, id, replacement };
}

test("a restart with an interrupted turn starts nothing until Resume, which sends one continuation", async () => {
  const { h, id, replacement } = await interruptedThread();
  const opened = h.contexts.length;
  const recovered = await crashCopy(h);
  expect(sends(replacement)).toEqual([]);
  expect(h.contexts).toHaveLength(opened);
  expect(recovered.engine.queue(id)).toMatchObject({ paused: true, reason: "restart" });
  const notices = Object.values(recovered.store.snapshotThread(id).items).filter(
    (item) => item.type === "notice" && item.code === "restart_interrupted",
  );
  expect(notices).toMatchObject([{ text: "Interrupted by a restart" }]);
  expect(recovered.store.getThread(id)?.status.state).not.toBe("working");

  const resumed = dispatch(recovered.store, recovered.engine, {
    type: "thread.resume",
    threadId: id,
    expectedRevision: recovered.engine.queue(id).revision,
  });
  expect(resumed.ok).toBe(true);
  await recovered.engine.flush();
  expect(inputs(replacement)).toEqual(["continue"]);
  expect(recovered.store.getThread(id)?.status.state).toBe("done");
});

test("a restart never sends queued messages by itself", async () => {
  const { h, id, replacement } = await interruptedThread(["a", "b"]);
  const recovered = await crashCopy(h);
  await recovered.engine.flush();
  expect(sends(replacement)).toEqual([]);
  expect(recovered.engine.queue(id).messages.map((message) => message.id)).toEqual(["a", "b"]);
});

test("a message after a restart goes out behind the held queue, with no continue from ace", async () => {
  const { h, id, replacement } = await interruptedThread(["a"]);
  const recovered = await crashCopy(h);
  expect(
    dispatch(
      recovered.store,
      recovered.engine,
      { type: "thread.send", threadId: id, input: text("b") },
      "b",
    ).ok,
  ).toBe(true);
  await recovered.engine.flush();
  expect(inputs(replacement)).toEqual(["a", "b"]);
  expect(recovered.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
});

test("a provider that dies mid-turn holds its queue until Resume", async () => {
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
  expect(inputs(replacement)).toEqual(["continue", "a"]);
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
