import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "../../shared/contract.ts";
import { checkWithFeedback, type Timers } from "./update-feedback.ts";

/** Timers that fire only when the test moves the clock. */
function manualClock() {
  let now = 0;
  const pending = new Set<{ at: number; callback: () => void }>();
  const timers: Timers = {
    set(delayMs, callback) {
      const entry = { at: now + delayMs, callback };
      pending.add(entry);
      return () => pending.delete(entry);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const entry of pending)
      if (entry.at <= now) {
        pending.delete(entry);
        entry.callback();
      }
  };
  return { timers, advance };
}

describe("Check for Updates feedback", () => {
  it("says it is checking at once, then gives the result", async () => {
    const reported: UpdateStatus[] = [];
    const { timers } = manualClock();
    await checkWithFeedback({
      check: async () => ({ state: "current", version: "1.2.0" }),
      report: (status) => reported.push(status),
      timers,
    });
    expect(reported).toEqual([{ state: "checking" }, { state: "current", version: "1.2.0" }]);
  });

  it("tells the person the check timed out after 10 seconds, and drops a late answer", async () => {
    const reported: UpdateStatus[] = [];
    const clock = manualClock();
    const feed = Promise.withResolvers<UpdateStatus>();
    const done = checkWithFeedback({
      check: () => feed.promise,
      report: (status) => reported.push(status),
      timers: clock.timers,
    });
    clock.advance(9_999);
    expect(reported).toEqual([{ state: "checking" }]);
    clock.advance(1);
    await done;
    feed.resolve({ state: "available", version: "2.0.0", url: "https://example.com" });
    await feed.promise;
    expect(reported).toEqual([
      { state: "checking" },
      { state: "error", message: "The update check timed out." },
    ]);
  });

  it("reports a check that fails as an error with its reason", async () => {
    const reported: UpdateStatus[] = [];
    await checkWithFeedback({
      check: async () => {
        throw new Error("The release feed is unreachable");
      },
      report: (status) => reported.push(status),
      timers: manualClock().timers,
    });
    expect(reported).toEqual([
      { state: "checking" },
      { state: "error", message: "The release feed is unreachable" },
    ]);
  });
});
