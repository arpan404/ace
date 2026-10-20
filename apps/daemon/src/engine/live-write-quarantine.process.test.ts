import { afterEach, expect, test } from "vitest";
import { harness, scriptFrames, start, ManualClock } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

test("live output that can never be stored stops only its session, with a visible notice", async () => {
  const frames = scriptFrames();
  const scheduler = new ManualClock();
  const h = await harness(
    [
      {
        on: "send",
        frames: [
          frames.frame(start, {
            type: "item.upsert",
            agent: "root",
            item: "answer",
            draft: { type: "message", role: "assistant", parts: [{ type: "text", text: "" }] },
          }),
        ],
      },
    ],
    frames,
    { storeOptions: { bufferScheduler: { delay: scheduler.setTimer } } },
  );
  cleanups.push(h.close);
  const id = await h.create();
  const context = h.contexts[0];
  if (!context) throw new Error("Missing provider");
  h.store.atomic((db) =>
    db.exec(
      "CREATE TRIGGER refuse_delta BEFORE INSERT ON events WHEN NEW.type='item.delta' BEGIN SELECT RAISE(ABORT, 'refused'); END",
    ),
  );
  await context.onFrame(
    frames.frame({ type: "item.delta", agent: "root", item: "answer", field: "text", append: "x" }),
  );
  scheduler.advance(scheduler.time + 75);
  expect(h.store.liveWriteBlocked()).toBe(true);
  // Bounded retries on the backoff, then quarantine: no repair ever comes.
  for (let step = 0; step < 30 && h.store.liveWriteBlocked(); step++)
    scheduler.advance(scheduler.time + 1000);
  expect(h.store.liveWriteBlocked()).toBe(false);
  await h.engine.flush();
  expect(context.signal.aborted).toBe(true);
  expect(h.store.atomic(() => "writable")).toBe("writable");
  expect(
    h.store
      .readEvents({ afterSeq: 0, threadId: id, limit: 200 })
      .some(
        (event) =>
          (event.payload.type === "item.created" || event.payload.type === "item.updated") &&
          event.payload.item.type === "notice" &&
          event.payload.item.text.startsWith("Recent output could not be saved"),
      ),
  ).toBe(true);
});
