import { describe, expect, it } from "vitest";
import { StreamPace } from "./stream-pace.ts";

/** A fake clock and renderer: renders take `renderMs` and timers run when time passes. */
function harness(renderMs = 10, intervalMs = 50) {
  let time = 0;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  const sent: Array<{ text: string; finalized: boolean; at: number }> = [];
  const renders: Array<() => void> = [];
  const pace = new StreamPace({
    now: () => time,
    schedule(delayMs, run) {
      const timer = { at: time + delayMs, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    interval: () => intervalMs,
    send(text, finalized) {
      sent.push({ text, finalized, at: time });
      return new Promise<void>((resolve) => renders.push(resolve));
    },
  });
  /** Moves time forward, finishing renders after `renderMs` and firing due timers. */
  async function advance(ms: number) {
    const end = time + ms;
    while (time < end) {
      time += 1;
      if (renders.length && sent.at(-1) && time - sent.at(-1)!.at >= renderMs) renders.shift()!();
      await Promise.resolve();
      for (const timer of timers.filter((t) => t.live && t.at <= time)) {
        timer.live = false;
        timer.run();
      }
      await Promise.resolve();
    }
  }
  return { pace, sent, advance };
}

describe("a streaming message reaches its renderer at a calm pace", () => {
  it("renders the first text at once", () => {
    const { pace, sent } = harness();
    pace.push("Hel", false);
    expect(sent.map((s) => s.text)).toEqual(["Hel"]);
  });

  it("coalesces deltas that arrive within the interval into one update with the latest text", async () => {
    const { pace, sent, advance } = harness(10, 50);
    pace.push("a", false);
    for (const text of ["ab", "abc", "abcd", "abcde"]) {
      await advance(5);
      pace.push(text, false);
    }
    await advance(60);
    expect(sent.map((s) => s.text)).toEqual(["a", "abcde"]);
    expect(sent[1]!.at).toBeGreaterThanOrEqual(50);
  });

  it("sends the finished text without waiting for the interval", async () => {
    const { pace, sent, advance } = harness(10, 100);
    pace.push("draft", false);
    await advance(15);
    pace.push("draft and more", false);
    await advance(5);
    pace.push("final answer", true);
    await advance(1);
    expect(sent.at(-1)).toMatchObject({ text: "final answer", finalized: true });
    expect(sent.at(-1)!.at).toBeLessThan(100);
  });

  it("never renders the same text twice", async () => {
    const { pace, sent, advance } = harness();
    pace.push("same", true);
    await advance(20);
    pace.push("same", true);
    await advance(100);
    expect(sent).toHaveLength(1);
  });

  it("stops rendering once disposed", async () => {
    const { pace, sent, advance } = harness();
    pace.push("a", false);
    pace.push("ab", false);
    pace.dispose();
    await advance(200);
    pace.push("abc", true);
    expect(sent.map((s) => s.text)).toEqual(["a"]);
  });
});
