import { afterEach, expect, test } from "vitest";
import type { Fact } from "@ace/core";
import type { Frame } from "@ace/engine-api";
import { ProviderPayload } from "@ace/provider-kit/payload";
import { harness, start, ManualClock } from "./test-support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

/** SDK-channel frames: the actor folds each sealed batch inside one store transaction. */
function sdkFrames() {
  const bundles = new Map<number, Fact[]>();
  let seq = 0;
  return {
    frame(...facts: Fact[]): Frame {
      bundles.set(++seq, facts);
      const payload = new ProviderPayload(JSON.stringify({ bundle: seq }));
      return { seq, t: seq, dir: "recv", channel: "sdk", data: payload.data, payload };
    },
    translate(frame: Frame): Fact[] {
      return structuredClone(bundles.get(frame.seq) ?? []);
    },
  };
}
const burst = (from: number, count: number): Fact[] =>
  Array.from({ length: count }, (_, index) => ({
    type: "item.delta",
    agent: "root",
    item: "answer",
    field: "text",
    append: `token${from + index} `,
  }));
const expected = (count: number) =>
  Array.from({ length: count }, (_, index) => `token${index} `).join("");

test("an SDK batch carrying 60+ deltas keeps the transcript intact and the store writable", async () => {
  const frames = sdkFrames();
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
  // Each burst fills the live buffer while its own transaction is still open.
  await context.onFrame(frames.frame(...burst(0, 64)));
  await context.onFrame(frames.frame(...burst(64, 64)));
  await h.engine.flush();
  expect(h.store.liveWriteBlocked()).toBe(false);
  expect(h.store.atomic(() => "writable")).toBe("writable");
  expect(h.store.readItems(id, h.store.headSeq() + 1, 10).items.at(-1)).toMatchObject({
    parts: [{ type: "text", text: expected(128) }],
  });
  expect(context.signal.aborted).toBe(false);
  expect(h.errors).toEqual([]);
});
