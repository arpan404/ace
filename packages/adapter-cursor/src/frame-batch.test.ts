import { expect, test } from "vitest";
import { FrameBatch, unbatch, type BatchTimer } from "./frame-batch.ts";
import type { CursorEnvelope } from "./contracts.ts";

const envelope = (kind: string, body: unknown): CursorEnvelope => ({
  schemaVersion: 1,
  generation: "g",
  operationId: "op",
  segment: 0,
  runId: "run",
  kind,
  body,
});

/** A batch over a manual clock; `stored` is what reached the daemon, one entry per ack. */
function harness(options: { maxBytes?: number } = {}) {
  const stored: CursorEnvelope[][] = [];
  const timers: (() => void)[] = [];
  const timer: BatchTimer = (run) => {
    timers.push(run);
    return () => {
      const index = timers.indexOf(run);
      if (index >= 0) timers.splice(index, 1);
    };
  };
  const batch = new FrameBatch(
    async (frames) => {
      stored.push(frames);
    },
    () => {},
    { timer, windowMs: 32, ...options },
  );
  const push = (kind: string, body: unknown, bytes = 16) => batch.push(envelope(kind, body), bytes);
  /** The window ends. */
  const tick = async () => {
    for (const run of timers.splice(0)) run();
    await batch.flush();
  };
  const kinds = () =>
    stored.map((frames) =>
      frames.map((f) => `${f.kind}:${String((f.body as { type?: string }).type ?? "")}`),
    );
  return { stored, push, tick, kinds, flush: () => batch.flush() };
}
const text = (value: string) => ({ type: "text-delta", text: value });

test("a burst of text deltas reaches the daemon as a few batched frames, with tool starts not delayed", async () => {
  const h = harness();
  await h.push("delta", text("a"));
  for (let index = 0; index < 200; index++) await h.push("delta", text("b"));
  // The first chunk went at once; the rest wait for the window.
  expect(h.stored).toHaveLength(1);
  // A tool starting goes now, after the text it follows, without waiting for the window.
  await h.push("delta", { type: "tool-call-started", callId: "shell" });
  expect(h.kinds()).toEqual([
    ["delta:text-delta"],
    ["delta:text-delta", "delta:tool-call-started"],
  ]);
  // The waiting chunks joined into one text frame, nothing lost.
  expect(h.stored[1]?.[0]?.body).toEqual(text("b".repeat(200)));
});

test("the first thought after text goes at once, and its later chunks wait for the window", async () => {
  const h = harness();
  await h.push("delta", text("hello"));
  await h.push("delta", { type: "thinking-delta", text: "hm" });
  expect(h.stored).toHaveLength(2);
  await h.push("delta", { type: "thinking-delta", text: "m" });
  expect(h.stored).toHaveLength(2);
  await h.tick();
  expect(h.stored.at(-1)?.[0]?.body).toEqual({ type: "thinking-delta", text: "m" });
});

test("a result is stored with every chunk before it, in order", async () => {
  const h = harness();
  await h.push("delta", text("a"));
  await h.push("delta", text("b"));
  await h.push("delta", text("c"));
  await h.push("result", { status: "finished" });
  const all = h.stored.flat();
  expect(all.map((frame) => frame.kind)).toEqual(["delta", "delta", "result"]);
  expect(all[1]?.body).toEqual(text("bc"));
});

test("a stretch that reaches the byte bound is stored without waiting for the window", async () => {
  const h = harness({ maxBytes: 100 });
  await h.push("delta", text("a"), 10);
  for (let index = 0; index < 5; index++) await h.push("delta", text("b"), 30);
  // Three chunks filled the batch and went without the window; the rest wait for it.
  expect(h.stored.map((frames) => frames.length)).toEqual([1, 1]);
  await h.tick();
  expect(
    h.stored
      .flat()
      .map((frame) => (frame.body as { text: string }).text)
      .join(""),
  ).toBe("abbbbb");
});

test("a stored batch unpacks into its frames in order", () => {
  const frames = [1, 2].map((n) => ({
    schemaVersion: 1 as const,
    generation: "g",
    operationId: "op",
    segment: 0,
    kind: "delta",
    body: text(String(n)),
  }));
  expect(unbatch({ ...frames[0]!, kind: "batch", body: { frames } })).toEqual(frames);
  expect(unbatch(frames[0]!)).toEqual([frames[0]]);
  expect(() => unbatch({ ...frames[0]!, kind: "batch", body: {} })).toThrow("Malformed");
});
