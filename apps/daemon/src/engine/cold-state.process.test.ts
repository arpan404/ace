import { ThreadOrganizer } from "../thread-organizer.ts";
import { afterEach, expect, test } from "vitest";
import { fixture, cleanupRecovery, crashCopy, text } from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";

afterEach(cleanupRecovery);

test("an old undelivered model failure retains its exact message in a held queue after restart", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, end)] }], frames);
  const id = await h.create();
  h.command({ type: "queue.pause", threadId: id, expectedRevision: h.engine.queue(id).revision });
  h.command(
    {
      type: "thread.send",
      threadId: id,
      input: text("Which file needs fixing?"),
      context: { mentions: [{ path: "src/main.ts" }], attachments: [] },
    },
    "device",
    "old-failure",
  );
  await h.engine.flush();
  // Stored by older releases before undelivered inputs were retained.
  h.store.atomic((db) =>
    db
      .prepare(
        "UPDATE intents SET status='failed',error='opencode session opening failed: model_unavailable' WHERE command_id='old-failure'",
      )
      .run(),
  );
  h.store.appendEvents(
    id,
    [{ type: "thread.client.updated", changes: { settledAt: 1000, settledReason: "manual" } }],
    1000,
  );
  const recovered = await crashCopy(h);
  const organizer = new ThreadOrganizer(recovered.store, undefined, h.clock.now, () => () => {});
  try {
    await organizer.sweep();
    expect(recovered.store.getThread(id)?.settledAt).toBeUndefined();
  } finally {
    await organizer.close();
  }
  expect(recovered.engine.queue(id)).toMatchObject({
    paused: true,
    reason: "not_sent",
    messages: [
      {
        id: "old-failure",
        input: text("Which file needs fixing?"),
        context: { mentions: [{ path: "src/main.ts" }] },
      },
    ],
  });
  expect(recovered.store.getThread(id)?.queue).toMatchObject({
    paused: true,
    reason: "not_sent",
    pendingCount: 1,
  });
  expect(recovered.store.snapshotThread(id).items["input:old-failure"]).toMatchObject({
    type: "message",
    parts: text("Which file needs fixing?"),
  });
});

test("a thread whose provider never started a turn has no restart continuation", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [] }], frames);
  const id = await h.create();
  h.store.atomic((db) =>
    db
      .prepare(
        "UPDATE engine_queue SET reason='restart',paused=1,continuation='continue',trigger='restart' WHERE thread_id=?",
      )
      .run(id),
  );
  const recovered = await crashCopy(h);
  expect(recovered.engine.queue(id).reason).toBe("uncertain");
  expect(recovered.engine.queue(id).pendingCount).toBe(1);
  expect(
    Object.values(recovered.store.snapshotThread(id).items).some(
      (item) => item.type === "message" && item.origin?.kind === "restart",
    ),
  ).toBe(false);
});

test("separate sends with equal text remain queued behind an uncertain input after restart", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [] }], frames);
  const id = await h.create();
  h.command(
    { type: "thread.send", threadId: id, input: text("first"), delivery: "queue" },
    "device",
    "repeated-send",
  );
  h.command(
    {
      type: "thread.send",
      threadId: id,
      input: text("first"),
      delivery: "queue",
      context: { mentions: [{ path: "another.ts" }], attachments: [] },
    },
    "device",
    "different-input",
  );
  await h.engine.flush();
  const recovered = await crashCopy(h);
  const queued = recovered.engine.queue(id).messages;
  expect(queued.map((message) => message.state)).toEqual(["uncertain", "queued", "queued"]);
  expect(queued[2]?.context?.mentions).toEqual([{ path: "another.ts" }]);
  expect(queued.some((message) => message.id === "repeated-send")).toBe(true);
});
