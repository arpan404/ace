import { afterEach, expect, test } from "vitest";
import { Command, type ThreadId } from "@ace/protocol";
import { Engine, type Store } from "@ace/daemon";
import { organizeThread } from "../thread-organization.ts";
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
 * Settling says the person is finished with a thread. A turn a restart left on hold is over
 * then: the thread is finished, never waiting on a "continue" nobody will send, and later
 * restarts don't hold it again.
 */
afterEach(cleanupRecovery);

async function heldAfterRestart(queued: string[] = []) {
  const frames = scriptFrames();
  // One finished turn, then a second one still running when ace restarts.
  const h = await fixture(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start)] },
    ],
    frames,
  );
  const id = await h.create();
  await h.engine.flush();
  h.command({ type: "thread.send", threadId: id, input: text("again") }, "device", "again");
  await h.engine.flush();
  for (const message of queued)
    h.command({ type: "thread.send", threadId: id, input: text(message) }, "device", message);
  await h.engine.flush();
  const replacement = replaceProvider(h, frames, [
    { on: "send", frames: [frames.frame(start, end)] },
  ]);
  const recovered = await crashCopy(h);
  expect(recovered.engine.queue(id)).toMatchObject({ paused: true, reason: "restart" });
  return { h, id, replacement, recovered };
}

function settle(store: Store, id: ThreadId, at: number) {
  return organizeThread(
    store,
    Command.parse({
      id: `settle-${at}`,
      deviceId: "device",
      payload: { type: "thread.settle", threadId: id },
    }),
    at,
  );
}

test("settling a thread a restart left on hold ends the turn, and the next restart holds nothing", async () => {
  const { h, id, replacement, recovered } = await heldAfterRestart();
  expect(recovered.store.getThread(id)?.status).toMatchObject({ state: "waiting", on: "queue" });

  expect(settle(recovered.store, id, h.clock.now()).ok).toBe(true);
  await recovered.engine.flush();
  expect(recovered.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
  // The turn is over: the thread no longer waits on a "continue" nobody will send.
  expect(recovered.store.getThread(id)?.status.state).not.toBe("waiting");
  expect(recovered.store.getThread(id)?.settledReason).toBe("manual");

  await recovered.engine.close();
  const again = new Engine(recovered.store, { registry: h.registry, clock: h.clock });
  try {
    await again.flush();
    expect(again.queue(id)).toMatchObject({ paused: false });
    expect(recovered.store.getThread(id)?.status.state).not.toBe("waiting");
    expect(sends(replacement)).toEqual([]);
  } finally {
    await again.close();
  }
});

test("a message the person queued keeps its hold when the thread is settled", async () => {
  const { h, id, replacement, recovered } = await heldAfterRestart(["a"]);
  expect(settle(recovered.store, id, h.clock.now()).ok).toBe(true);
  await recovered.engine.flush();
  expect(recovered.engine.queue(id)).toMatchObject({ paused: true });
  expect(recovered.engine.queue(id).messages.map((message) => message.id)).toEqual(["a"]);
  expect(sends(replacement)).toEqual([]);

  // Their next message still carries on, after the one they queued.
  dispatch(
    recovered.store,
    recovered.engine,
    { type: "thread.send", threadId: id, input: text("b") },
    "b",
  );
  await recovered.engine.flush();
  expect(
    sends(replacement).flatMap((command) =>
      command.input.flatMap((part) => (part.type === "text" ? [part.text] : [])),
    ),
  ).toEqual(["a", "b"]);
});
