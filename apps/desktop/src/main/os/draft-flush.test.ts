import { describe, expect, it } from "vitest";
import { draftFlush } from "./draft-flush.ts";

function clock() {
  let now = 0;
  const due: { at: number; run: () => void }[] = [];
  return {
    timers: {
      set(delayMs: number, run: () => void) {
        const entry = { at: now + delayMs, run };
        due.push(entry);
        return () => {
          const index = due.indexOf(entry);
          if (index >= 0) due.splice(index, 1);
        };
      },
    },
    advance(ms: number) {
      now += ms;
      for (const entry of due.filter((each) => each.at <= now)) {
        due.splice(due.indexOf(entry), 1);
        entry.run();
      }
    },
  };
}

/** What the quit heard by now: whether the drafts are kept, or nothing yet. */
const settled = async (promise: Promise<boolean>) => {
  let done: boolean | undefined;
  void promise.then((kept) => (done = kept));
  await Promise.resolve();
  await Promise.resolve();
  return done;
};

describe("keeping drafts on quit", () => {
  it("waits until the window says its drafts are written", async () => {
    const time = clock();
    let asked = 0;
    const flush = draftFlush({ ask: () => (asked++, true), timers: time.timers });
    const quitting = flush.run();
    expect(asked).toBe(1);
    time.advance(500);
    expect(await settled(quitting)).toBeUndefined();
    flush.flushed(true);
    expect(await settled(quitting)).toBe(true);
  });

  it("hears when the window could not keep its drafts, so the quit stops to ask", async () => {
    const flush = draftFlush({ ask: () => true, timers: clock().timers });
    const quitting = flush.run();
    flush.flushed(false);
    expect(await settled(quitting)).toBe(false);
  });

  it("goes ahead after the bound when the window never answers", async () => {
    const time = clock();
    const flush = draftFlush({ ask: () => true, timers: time.timers, boundMs: 2_000 });
    const quitting = flush.run();
    time.advance(1_999);
    expect(await settled(quitting)).toBeUndefined();
    time.advance(1);
    expect(await settled(quitting)).toBe(true);
  });

  it("goes ahead at once with no window to ask", async () => {
    const flush = draftFlush({ ask: () => false, timers: clock().timers });
    expect(await settled(flush.run())).toBe(true);
  });
});
