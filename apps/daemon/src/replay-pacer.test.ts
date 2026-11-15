import { describe, expect, it } from "vitest";
import { ackTimeoutMs, budgetBounds, budgetMs, ReplayPacer } from "./replay-pacer.ts";

/** A pacer on a clock and timers the test moves. */
function pacer() {
  let now = 0;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  const pace = new ReplayPacer(
    () => now,
    (run, ms) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  );
  return {
    pace,
    advance(ms: number) {
      now += ms;
      for (const timer of timers.splice(0))
        if (timer.live && timer.at <= now) timer.run();
        else if (timer.live) timers.push(timer);
    },
  };
}

describe("pacing a replay to the link", () => {
  it("the first piece goes at once, and the next waits while the budget is on its way", () => {
    const { pace } = pacer();
    const ran: string[] = [];
    pace.whenReady(() => ran.push("first"));
    pace.sent("s", 10, budgetBounds.first);
    pace.whenReady(() => ran.push("second"));
    expect(ran).toEqual(["first"]);
    pace.received("s", 10);
    expect(ran).toEqual(["first", "second"]);
  });

  it("a piece is half the budget, so one is on its way while the next is made", () => {
    const { pace } = pacer();
    expect(pace.pieceBytes()).toBe(budgetBounds.first / 2);
    pace.sent("s", 1, pace.pieceBytes());
    const ran: number[] = [];
    pace.whenReady(() => ran.push(2));
    expect(ran).toEqual([2]);
  });

  it("the budget follows the link: what it carries in budgetMs, within its bounds", () => {
    const slow = pacer();
    // 50 KB a second: about 20 KB in 400 ms.
    for (let piece = 1; piece <= 6; piece++) {
      slow.pace.sent("s", piece, 10_000);
      slow.advance(200);
      slow.pace.received("s", piece);
    }
    expect(slow.pace.budget()).toBeCloseTo(50 * budgetMs, -2);
    const fast = pacer();
    for (let piece = 1; piece <= 6; piece++) {
      fast.pace.sent("s", piece, 1024 * 1024);
      fast.advance(1);
      fast.pace.received("s", piece);
    }
    expect(fast.pace.budget()).toBe(budgetBounds.most);
    const stalled = pacer();
    stalled.pace.sent("s", 1, 1000);
    stalled.advance(60_000);
    stalled.pace.received("s", 1);
    expect(stalled.pace.budget()).toBe(budgetBounds.least);
  });

  it("an acknowledgement covers every earlier piece of its subscription, and only those", () => {
    const { pace } = pacer();
    pace.sent("a", 5, 6000);
    pace.sent("b", 6, 6000);
    pace.sent("a", 9, 6000);
    pace.received("a", 9);
    expect(pace.unacknowledged).toBe(6000);
  });

  it("a client that never acknowledges slows the replay but never stops it", () => {
    const { pace, advance } = pacer();
    pace.sent("s", 1, budgetBounds.first);
    const ran: number[] = [];
    pace.whenReady(() => ran.push(2));
    advance(ackTimeoutMs - 1);
    expect(ran).toEqual([]);
    advance(1);
    expect(ran).toEqual([2]);
  });

  it("a stopped subscription's pieces no longer hold the others back", () => {
    const { pace } = pacer();
    pace.sent("gone", 1, budgetBounds.first);
    const ran: number[] = [];
    pace.whenReady(() => ran.push(1));
    pace.forget("gone");
    expect(ran).toEqual([1]);
  });

  it("a wait that is cancelled never runs", () => {
    const { pace } = pacer();
    pace.sent("s", 1, budgetBounds.first);
    const ran: number[] = [];
    const cancel = pace.whenReady(() => ran.push(1));
    cancel();
    pace.received("s", 1);
    expect(ran).toEqual([]);
  });
});
