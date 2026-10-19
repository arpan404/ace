import { describe, expect, it } from "vitest";
import { AvSync, bufferMs, maxWaitMs } from "./av-sync.ts";

/** Stream (daemon) time is 1 000 000 ms ahead of this client's clock. */
const skew = 1_000_000;

describe("page sound in step with the video", () => {
  it("plays sound when the picture captured with it is on screen", () => {
    const sync = new AvSync();
    // Pictures show 150 ms after capture (the relay, decoding).
    for (let t = 0; t < 1_000; t += 33) sync.shown(skew + t, t + 150);
    // The sound captured at 1 000 arrives after only 40 ms.
    const at = sync.schedule(skew + 1_000, 20, 1_040);
    expect(at).toBe(1_150);
  });

  it("without pictures, plays a jitter buffer behind its arrival", () => {
    const sync = new AvSync();
    expect(sync.schedule(skew + 1_000, 20, 1_040)).toBe(1_040 + bufferMs);
  });

  it("plays consecutive chunks back to back through small arrival jitter", () => {
    const sync = new AvSync();
    const starts: number[] = [];
    for (let index = 0; index < 50; index++) {
      const captured = index * 20;
      // Arrivals wander between 30 and 55 ms after capture.
      const arrived = captured + 30 + ((index * 7) % 26);
      const at = sync.schedule(skew + captured, 20, arrived);
      if (at !== undefined) starts.push(at);
    }
    expect(starts).toHaveLength(50);
    for (let index = 1; index < starts.length; index++)
      expect((starts[index] ?? 0) - (starts[index - 1] ?? 0)).toBe(20);
  });

  it("restarts the schedule rather than play a chunk in the past", () => {
    const sync = new AvSync();
    sync.schedule(skew, 20, 40);
    // A stall: the next chunk arrives 400 ms after its capture.
    const at = sync.schedule(skew + 20, 20, 420);
    expect(at).toBeGreaterThanOrEqual(420);
  });

  it("waits only so long for pictures that run far behind", () => {
    const sync = new AvSync();
    // The video is backed up by five seconds.
    sync.shown(skew, 5_000);
    const at = sync.schedule(skew + 100, 20, 140);
    expect(at).toBe(140 + bufferMs + maxWaitMs);
  });

  it("forgets the old stream's offsets when it starts over", () => {
    const sync = new AvSync();
    sync.shown(skew, 300);
    sync.reset();
    expect(sync.schedule(skew + 1_000, 20, 1_040)).toBe(1_040 + bufferMs);
  });
});
