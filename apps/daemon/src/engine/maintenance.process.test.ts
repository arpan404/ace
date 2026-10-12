import { expect, test } from "vitest";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const preserved = (
  h: Awaited<ReturnType<typeof harness>>,
  id: Parameters<typeof h.store.snapshotThread>[0],
) =>
  Object.values(h.store.snapshotThread(id).items).some(
    (item) =>
      item.type === "message" &&
      item.parts.some((part) => part.type === "text" && part.text === "preserved"),
  );
const delta = {
  type: "item.delta",
  agent: "root",
  item: "live",
  field: "text",
  append: "preserved",
} as const;

test("a streaming thread waits out a long compaction and commits its frames afterwards", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames);
  try {
    const id = await h.create();
    const ctx = h.contexts[0];
    if (!ctx) throw new Error("Missing context");
    const release = Promise.withResolvers<void>();
    const maintenance = h.store.maintenance(() => release.promise);
    let acknowledged = false;
    const committed = Promise.resolve(ctx.onFrame(frames.frame(delta, end))).then(() => {
      acknowledged = true;
    });
    // Longer than any write bound the gate used to impose on held writers.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(acknowledged).toBe(false);
    expect(preserved(h, id)).toBe(false);
    release.resolve();
    await maintenance;
    await committed;
    await h.engine.flush();
    expect(h.errors).toEqual([]);
    expect(h.store.getThread(id)?.status.state).toBe("done");
    expect(preserved(h, id)).toBe(true);
  } finally {
    await h.close();
  }
});

test("a busy admission under a bounded hold retries instead of failing the session", async () => {
  const frames = scriptFrames();
  const h = await harness([{ on: "send", frames: [frames.frame(start)] }], frames, {
    storeOptions: { writeGate: { holdMs: 20 } },
  });
  try {
    const id = await h.create();
    const ctx = h.contexts[0];
    if (!ctx) throw new Error("Missing context");
    const release = Promise.withResolvers<void>();
    const maintenance = h.store.maintenance(() => release.promise);
    const retry = h.clock.waitForDelay(100);
    const committed = Promise.resolve(ctx.onFrame(frames.frame(delta, end)));
    // The held write timed out as busy and the actor scheduled a retry.
    await retry;
    release.resolve();
    await maintenance;
    h.clock.advance(h.clock.time + 100);
    await committed;
    await h.engine.flush();
    expect(h.errors).toEqual([]);
    expect(h.store.getThread(id)?.status.state).toBe("done");
    expect(preserved(h, id)).toBe(true);
  } finally {
    await h.close();
  }
});
